import asyncio, json, re, base64, time, sys, os, zipfile, io
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
import os
PORT = os.environ.get('INKWELL_PORT', '8766')
OUT = os.environ.get('INKWELL_TEST_OUT', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')) + '/'
os.makedirs(OUT + 'shots', exist_ok=True)

URL = f'http://localhost:{PORT}/'
UID = '11111111-1111-1111-1111-111111111111'
SERVER = {}
SB_FILES = {}        # Supabase storage: name -> bytes
R2 = {}              # fake R2: id -> bytes
FILES_ROWS = {}      # files table: id -> bytes
STATE = {'r2': False, 'limit_mb': None, 'calls': []}
CLOCK = [0]
D = OUT

def ts():
    CLOCK[0] += 1
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(1760000000 + CLOCK[0])) + '.%06d+00:00' % (CLOCK[0] * 7 % 1000000)
def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
JWT = b64({'alg': 'HS256', 'typ': 'JWT'}) + '.' + b64({'sub': UID, 'exp': 4102444800, 'role': 'authenticated', 'aud': 'authenticated'}) + '.sig'
USER = {'id': UID, 'aud': 'authenticated', 'role': 'authenticated', 'email': 'r@example.com'}
SESSION = {'access_token': JWT, 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': 4102444800, 'refresh_token': 'rt', 'user': USER}
def parse_in(v):
    m = re.match(r'in\.\((.*)\)$', v); return [x.strip('"') for x in m.group(1).split(',')] if m else []
def pick(row, sel):
    cols = sel.split(',') if sel else list(row.keys()); return {c: row.get(c) for c in cols}
def J(route, status, obj): return route.fulfill(status=status, content_type='application/json', body=json.dumps(obj), headers={'Access-Control-Allow-Origin': '*'})

async def handler(route, request):
    u = urlparse(request.url); q = parse_qs(u.query); path = u.path
    if '/auth/v1/' in path: return await J(route, 200, USER if path.endswith('/user') else SESSION)
    if '/storage/v1/object/list/assets' in path:
        return await J(route, 200, [{'name': n, 'created_at': '2026-01-01T00:00:00Z', 'metadata': {'size': len(b)}} for n, b in SB_FILES.items()])
    if '/storage/v1/object/assets/' in path:
        name = path.split('/storage/v1/object/assets/')[1].split('/', 1)[1]
        if request.method in ('POST', 'PUT'):
            SB_FILES[name] = request.post_data_buffer or b''; STATE['calls'].append(('sb_up', name)); return await J(route, 200, {'Key': name})
        if name in SB_FILES: return await route.fulfill(status=200, body=SB_FILES[name], content_type='image/jpeg')
        return await J(route, 404, {'error': 'not found'})
    if '/storage/v1/object/' in path and request.method == 'GET':
        name = path.split('/')[-1]
        if name in SB_FILES: return await route.fulfill(status=200, body=SB_FILES[name], content_type='image/jpeg')
        return await J(route, 400, {'error': 'not found'})
    if path.endswith('/functions/v1/files'):
        if request.method == 'OPTIONS': return await route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*'})
        if not STATE['r2'] and STATE.get('missing'): return await J(route, 404, {'error': 'not found'})
        b = json.loads(request.post_data or '{}'); a = b.get('action'); STATE['calls'].append(('files', a))
        if a == 'info': return await J(route, 200, {'r2': STATE['r2'], 'used_mb': sum(FILES_ROWS.values()) / 1048576, 'limit_mb': None, 'total_mb': STATE.get('total_mb', sum(FILES_ROWS.values()) / 1048576), 'cap_mb': 9000, 'claude_usd': 0.12, 'claude_limit': None})
        if a == 'put':
            if STATE['limit_mb'] is not None and sum(FILES_ROWS.values()) + b['size'] > STATE['limit_mb'] * 1048576:
                return await J(route, 413, {'error': 'cloud_full', 'total_mb': 9500, 'cap_mb': 9500})
            FILES_ROWS[b['id']] = b['size']; return await J(route, 200, {'url': 'https://r2.fake/obj/' + b['id']})
        if a == 'get': return await J(route, 200, {'urls': {i: ('https://r2.fake/obj/' + i if i in FILES_ROWS else None) for i in b['ids']}})
        if a == 'list': return await J(route, 200, {'files': [{'id': i, 'bytes': n, 'created_at': '2026-01-01T00:00:00Z'} for i, n in FILES_ROWS.items()]})
        if a == 'del':
            for i in b['ids']: R2.pop(i, None); FILES_ROWS.pop(i, None)
            return await J(route, 200, {'removed': len(b['ids'])})
        if a == 'migrate':
            todo = [n for n in SB_FILES if n not in FILES_ROWS]
            for n in todo[:b.get('n', 6)]: R2[n] = SB_FILES[n]; FILES_ROWS[n] = len(SB_FILES[n])
            return await J(route, 200, {'copied': min(len(todo), b.get('n', 6)), 'left': max(0, len(todo) - b.get('n', 6))})
    if '/functions/v1/' in path: return await J(route, 404, {'error': 'nf'})
    if path.endswith('/rest/v1/docs'):
        if request.method == 'GET':
            rows = list(SERVER.values())
            if 'server_ts' in q: rows = [r for r in rows if r['server_ts'] > q['server_ts'][0][3:]]
            if 'id' in q: ids = set(parse_in(q['id'][0])); rows = [r for r in rows if r['id'] in ids]
            rows.sort(key=lambda r: r['server_ts'])
            if 'limit' in q: rows = rows[:int(q['limit'][0])]
            return await J(route, 200, [pick(r, q.get('select', [''])[0]) for r in rows])
        if request.method == 'POST':
            body = json.loads(request.post_data or '[]'); body = [body] if isinstance(body, dict) else body; out = []
            for r in body:
                r = dict(r); r['server_ts'] = ts(); r['data'] = json.loads(json.dumps(r['data'], sort_keys=True)) if r.get('data') is not None else None
                SERVER[r['id']] = r; out.append(r)
            return await J(route, 201, [pick(r, q.get('select', [''])[0]) for r in out])
    return await route.fulfill(status=404, body='')

async def r2route(route, request):
    i = urlparse(request.url).path.split('/obj/')[1]
    h = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT', 'Access-Control-Allow-Headers': '*'}
    if request.method == 'OPTIONS': return await route.fulfill(status=200, headers=h)
    if request.method == 'PUT': R2[i] = request.post_data_buffer or b''; STATE['calls'].append(('r2_put', i)); return await route.fulfill(status=200, headers=h)
    if i in R2: return await route.fulfill(status=200, body=R2[i], content_type='image/jpeg', headers=h)
    return await route.fulfill(status=404, headers=h)

async def device(b, name, signed=True):
    c = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True, accept_downloads=True)
    init = "localStorage.setItem('inkwell.prefs', JSON.stringify({hwSearch:false}));"
    if signed: init += f"localStorage.setItem('inkwell-auth', {json.dumps(json.dumps(SESSION))});"
    await c.add_init_script(init)
    await c.route('**/*supabase.co/**', handler)
    await c.route('https://r2.fake/**', r2route)
    try: await c.route_web_socket(re.compile('.*supabase.*'), lambda ws: ws.close())
    except Exception: pass
    pg = await c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(f'{name}: {e}'))
    pg.on('console', lambda m: errs.append(f'{name} console: {m.text}') if m.type == 'error' and 'WebSocket' not in m.text and 'Failed to load resource' not in m.text else None)
    await pg.goto(URL); await pg.wait_for_timeout(3500)
    return c, pg, errs

async def sync(pg):
    return await pg.evaluate("""async () => { const S = __inkwell.Sync; await S.run(); for(let i = 0; i < 100 && (S.running || S.again); i++) await new Promise(r => setTimeout(r, 50)); return S.state + ' ' + S.msg; }""")

def jpeg(n):  # tiny distinct blobs
    return bytes([0xFF, 0xD8, 0xFF]) + os.urandom(n)

async def main():
    ok = True
    def check(cond, msg):
        nonlocal ok; print(('PASS ' if cond else 'FAIL ') + msg); ok = ok and bool(cond)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # ---------- A: R2 off (function says r2 false): pictures still go to Supabase ----------
        A, pa, ea = await device(b, 'A')
        await pa.evaluate("""async () => { const W = __inkwell; await W.newPage(); }""")
        aid = await pa.evaluate("""async () => { const W = __inkwell; const id = await W.saveAsset(new Blob([new Uint8Array([255,216,255,1,2,3])], {type:'image/jpeg'}));
            W.addItems([{t:'i', id:'i_pic', x:0, y:0, w:100, h:80, a:id}]); await W.flushSaves(); return id; }""")
        print('A sync:', await sync(pa))
        check(aid in SB_FILES and aid not in R2, 'R2 off: picture uploaded to Supabase storage')
        # ---------- B: R2 on: uploads to R2, old pictures migrate, reads come from R2 ----------
        STATE['r2'] = True
        SB_FILES['a-old1'] = jpeg(2000); SB_FILES['a-old2'] = jpeg(3000)
        await pa.evaluate("() => { __inkwell.Files.info = null; }")
        bid = await pa.evaluate("""async () => { const W = __inkwell; const id = await W.saveAsset(new Blob([new Uint8Array([255,216,255,9,9,9,9])], {type:'image/jpeg'}));
            W.addItems([{t:'i', id:'i_pic2', x:0, y:100, w:100, h:80, a:id}]); await W.flushSaves(); return id; }""")
        print('A sync:', await sync(pa))
        check(bid in R2 and bid not in SB_FILES, 'R2 on: new picture uploaded to R2 through a presigned link')
        await pa.wait_for_timeout(6000)   # background migration starts ~4 s after info
        check('a-old1' in R2 and 'a-old2' in R2 and aid in R2, 'old Supabase pictures copied to R2 in the background')
        info = await pa.evaluate("() => { const i = __inkwell.Files.info; return i && i.r2; }")
        check(info, 'Files.info says R2 is on')
        # second device reads a picture that exists only in R2
        B, pb, eb = await device(b, 'B')
        print('B sync:', await sync(pb))
        got = await pb.evaluate("""async id => { const r = await __inkwell.Sync.fetchAsset(id); return r ? r.blob.size : -1; }""", bid)
        check(got == 7, 'other device downloads the R2 picture (size %s)' % got)
        r2gets = [c for c in STATE['calls'] if c == ('files', 'get')]
        check(len(r2gets) >= 1, 'downloads ask the server for a link')
        # storage full: upload refused, sync explains, picture stays pending
        STATE['limit_mb'] = 0
        msg = await pb.evaluate("""async () => { const W = __inkwell; await W.newPage(); await W.saveAsset(new Blob([new Uint8Array(500)], {type:'image/jpeg'})); return 1; }""")
        st = await sync(pb)
        print('B sync with full storage:', st)
        check(st.startswith('synced'), 'a full cloud is not a sync error (notes keep syncing)')
        toast = await pb.text_content('#toastText')
        check('Cloud storage is full' in (toast or ''), 'a full cloud is explained: %s' % toast)
        info = await pb.text_content('#syncInfo')
        check('on this device only' in (info or ''), 'settings say how many pictures are on this device only')
        pend = await pb.evaluate("async () => ((await __inkwell.IDB.get('meta', 'pendingAssets')) || []).length")
        check(pend == 1, 'refused picture stays waiting on the device')
        STATE['limit_mb'] = None
        await pb.evaluate("() => { __inkwell.Files.full = null; }")   # the 30-minute retry wait, skipped for the test
        print('B sync:', await sync(pb))
        pend = await pb.evaluate("async () => ((await __inkwell.IDB.get('meta', 'pendingAssets')) || []).length")
        check(pend == 0, 'it uploads once there is room')
        # ---------- Page history ----------
        r = await pa.evaluate("""async () => { const W = __inkwell, c = W.cur;
            W.addItems([{t:'x', id:'x_h1', x:40, y:300, w:300, fs:1, html:'<p>first</p>'}]); await W.flushSaves();
            c.verAt = 1;   // pretend the last version is old: the next save keeps the state before it
            W.addItems([{t:'x', id:'x_h2', x:40, y:360, w:300, fs:1, html:'<p>second</p>'}]); await W.flushSaves();
            await new Promise(r => setTimeout(r, 300));
            const vs = await W.versionsOf(c.id); return {n: vs.length, items: vs[0] && vs[0].data.items.map(i => i.id)}; }""")
        print(' versions:', r)
        check(r['n'] >= 1 and 'x_h1' in r['items'] and 'x_h2' not in r['items'], 'a version keeps the page as it was before the editing session')
        await pa.evaluate("async () => { const W = __inkwell; W.removeItems(['x_h1', 'i_pic']); await W.flushSaves(); }")
        await pa.click('#moreBtn'); await pa.click('#mHistory'); await pa.wait_for_timeout(700)
        await pa.screenshot(path=D + 'shots/history.png')
        rows = await pa.evaluate("document.querySelectorAll('#histList .hist-item').length")
        check(rows >= 1 and await pa.is_visible('#histDlg'), 'Page history dialog lists versions')
        await pa.click('#histList .hist-item [data-act="restore"]'); await pa.wait_for_timeout(500)
        ids = await pa.evaluate("[...__inkwell.cur.items.keys()]")
        check('x_h1' in ids and 'i_pic' in ids and 'x_h2' not in ids, 'restore brings the old version back: %s' % ids)
        await pa.evaluate("() => document.getElementById('undo').click()"); await pa.wait_for_timeout(200)
        ids2 = await pa.evaluate("[...__inkwell.cur.items.keys()]")
        check('x_h2' in ids2 and 'x_h1' not in ids2, 'Undo returns to what was there before the restore')
        print('A sync:', await sync(pa))
        check(any(k.startswith('v_') for k in SERVER), 'versions are synced to the server')
        inmap = await pa.evaluate("[...__inkwell.docs.keys()].some(k => k.startsWith('v_'))")
        check(not inmap, 'versions stay out of the in-memory list')
        # ---------- Backup in parts with every picture, then restore on a fresh device ----------
        await pa.evaluate("() => { __inkwell.prefs; }")
        await pa.evaluate("async () => { await __inkwell.IDB.del('assets', arguments[0]); }", ) if False else None
        await pa.evaluate("""() => { document.getElementById('settingsBtn').click(); }"""); await pa.wait_for_timeout(500)
        await pa.click('#backupBtn'); await pa.wait_for_timeout(1500)
        info = await pa.text_content('#backupInfo'); print(' backup:', info)
        check(await pa.is_visible('#backupDlg') and 'pictures' in info, 'backup dialog shows what will be saved')
        async with pa.expect_download() as dl:
            await pa.click('#backupParts [data-bpart="0"]')
        d = await dl.value; path = D + 'backup_test.zip'; await d.save_as(path)
        z = zipfile.ZipFile(path); names = z.namelist(); print(' zip:', d.suggested_filename, len(names), 'entries')
        pics = [n for n in names if n.startswith('pictures/')]
        check('notes.json' in names and ('pictures/a-old1' in names) and ('pictures/' + bid) in names, 'zip holds notes and pictures, also ones only online')
        C, pc, ec = await device(b, 'C', signed=False)
        await pc.set_input_files('#restoreFile', path); await pc.wait_for_timeout(1500)
        res = await pc.evaluate("""async pid => { const W = __inkwell; const c = await W.IDB.get('docs', 'c_' + pid); const a = await W.IDB.get('assets', 'a-old1'); return {page: !!(c && c.data), pic: !!a}; }""", await pa.evaluate("__inkwell.cur.id"))
        check(res['page'] and res['pic'], 'restore from the zip brings back the page and its pictures')
        # ---------- Storage meter, near-full warning, Clean up ----------
        STATE['total_mb'] = 8000
        await pa.evaluate("() => { document.querySelectorAll('.modal').forEach(m => m.hidden = true); localStorage.removeItem('inkwell.cloudNote'); __inkwell.Files.info = null; }")
        await pa.evaluate("() => document.getElementById('settingsBtn').click()"); await pa.wait_for_timeout(1200)
        await pa.screenshot(path=D + 'shots/settings_cloud.png')
        vis = await pa.is_visible('#cloudRow'); txt = await pa.text_content('#cloudInfo'); near = await pa.evaluate("document.getElementById('cloudBar').classList.contains('near')")
        print(' meter:', txt)
        check(vis and 'everyone' in txt and near, 'Settings shows the storage bar, orange when nearly full')
        t2 = await pa.text_content('#toastText')
        check('89% full' in (t2 or ''), 'nearly-full heads-up: %s' % t2)
        await pa.click('#cleanupBtn'); await pa.wait_for_timeout(1200)
        await pa.screenshot(path=D + 'shots/cleanup.png')
        n = await pa.evaluate("document.querySelectorAll('#cuList input[type=checkbox]').length")
        check(n >= 1, 'Clean up lists pages with pictures (%d)' % n)
        await pa.click('#cuList input[type=checkbox]'); await pa.click('#cuDelete'); await pa.click('#cuDelete'); await pa.wait_for_timeout(500)
        gone = await pa.evaluate("document.querySelectorAll('#cuList input[type=checkbox]').length")
        check(gone == n - 1, 'Delete selected moves the page to Recently deleted')
        await pa.evaluate("() => { document.querySelectorAll('.modal').forEach(m => m.hidden = true); }")
        STATE['total_mb'] = None; STATE.pop('total_mb')
        await pa.evaluate("async () => { if(!__inkwell.cur) await __inkwell.newPage(); }")
        # ---------- Free up space covers R2 ----------
        FILES_ROWS['a-unused'] = 10; R2['a-unused'] = b'x' * 10
        plan = await pa.evaluate("async () => { const p = await __inkwell.cleanScan(); return p.server.map(r => r.id + (r.r2 ? ':r2' : '')); }")
        print(' clean plan:', plan)
        check('a-unused:r2' in plan and not any(x.startswith(bid) for x in plan), 'Free up space finds unused R2 pictures and keeps used ones')
        # ---------- leaving the app uploads right away ----------
        await pa.evaluate("async () => { const W = __inkwell; W.addItems([{t:'tp', id:'t_hide', x:0, y:0, w:20, h:10}]); }")
        await pa.evaluate("() => { Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'}); document.dispatchEvent(new Event('visibilitychange')); }")
        await pa.wait_for_timeout(1500)
        cid = 'c_' + await pa.evaluate("__inkwell.cur.id")
        check(any(i['id'] == 't_hide' for i in SERVER[cid]['data']['items']), 'leaving the app saves and uploads at once')
        errs = ea + eb + ec
        check(not errs, 'no page errors: %s' % errs[:4])
        await b.close()
    print('ALL OK' if ok else 'SOME FAILED')
    if not ok: raise SystemExit(1)
asyncio.run(main())
