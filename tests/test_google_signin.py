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
GDRIVE = {}
DRIVE_ROWS = {}
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
    if '/auth/v1/' in path:
        if path.endswith('/verify'): STATE['verify'] = json.loads(request.post_data or '{}')
        if path.endswith('/user') and not STATE.get('authed', True): return await J(route, 401, {'msg': 'no'})
        return await J(route, 200, USER if path.endswith('/user') else SESSION)
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
        if a == 'glogin':
            STATE['glogin'] = b; STATE['glogin_auth'] = request.headers.get('authorization', ''); STATE['glogin_key'] = request.headers.get('apikey', '')
            if STATE.get('glogin_fail'): return await J(route, 400, {'error': 'g_scope', 'message': 'Inkwell needs your Google Drive to save your notes and pictures. Sign in again and leave the Google Drive box ticked.'})
            STATE['gd'] = {'on': True, 'email': 'r@gmail.com', 'broken': False}; STATE['authed'] = True
            return await J(route, 200, {'token_hash': 'th123', 'email': 'r@gmail.com', 'created': STATE.get('created', False)})
        if a == 'gcheck':
            STATE['gchecks'] = STATE.get('gchecks', 0) + 1
            return await J(route, 200, {'total': len(DRIVE_ROWS), 'missing': STATE.get('gmissing', 0), 'missing_ids': [], 'folder_ok': not STATE.get('gfolder_gone'), 'r2_left': 0})
        if a == 'gconnect':
            STATE['gd'] = {'on': True, 'email': 'r@gmail.com', 'broken': False}; STATE['gconnect'] = b; return await J(route, 200, {'email': 'r@gmail.com'})
        if a == 'gtoken':
            if STATE.get('gd_revoked'): STATE['gd']['on'] = False; STATE['gd']['broken'] = True; return await J(route, 409, {'error': 'g_revoked', 'message': 'x'})
            return await J(route, 200, {'access_token': 'gat', 'expires_in': 3600, 'folder': 'fold1'})
        if a == 'gset': STATE['gd']['on'] = b['on']; return await J(route, 200, {'on': b['on']})
        if a == 'gdone': DRIVE_ROWS[b['id']] = b['gid']; FILES_ROWS.pop(b['id'], None); return await J(route, 200, {'ok': True})
        if a == 'gmove':
            todo = [i for i in FILES_ROWS if i in R2][:b.get('n', 5)]
            for i in todo:
                gid = 'g' + i.replace('-', '') + 'xxxxxxxx'; GDRIVE[gid] = R2.pop(i); FILES_ROWS.pop(i); DRIVE_ROWS[i] = gid
            return await J(route, 200, {'moved': len(todo), 'left': len([i for i in FILES_ROWS if i in R2])})
        if a == 'info': return await J(route, 200, {'r2': STATE['r2'], 'used_mb': sum(FILES_ROWS.values()) / 1048576, 'limit_mb': None, 'total_mb': STATE.get('total_mb', sum(FILES_ROWS.values()) / 1048576), 'cap_mb': 9000, 'claude_usd': 0.12, 'claude_limit': None, 'google_client_id': 'cid.apps.googleusercontent.com', 'gdrive': ({**STATE['gd'], 'mb': len(DRIVE_ROWS) * 0.01} if STATE.get('gd') else None)})
        if a == 'put' and STATE.get('gd') and not STATE['gd']['broken']: return await J(route, 200, {'drive': True})
        if a == 'put': return await J(route, 409, {'error': 'need_drive', 'message': 'Sign in with Google'})
        if a == 'put_old':
            if STATE['limit_mb'] is not None and sum(FILES_ROWS.values()) + b['size'] > STATE['limit_mb'] * 1048576:
                return await J(route, 413, {'error': 'cloud_full', 'total_mb': 9500, 'cap_mb': 9500})
            FILES_ROWS[b['id']] = b['size']; return await J(route, 200, {'url': 'https://r2.fake/obj/' + b['id']})
        if a == 'get': return await J(route, 200, {'urls': {i: ({'g': DRIVE_ROWS[i]} if i in DRIVE_ROWS else 'https://r2.fake/obj/' + i if i in FILES_ROWS else None) for i in b['ids']}})
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

NOTES = {}
async def gauth(route, request):
    q = parse_qs(urlparse(request.url).query)
    STATE['gauth'] = q
    return await route.fulfill(status=302, headers={'Location': q['redirect_uri'][0] + '?code=gcode&state=' + q['state'][0]})
async def gapi(route, request):
    h = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH'}
    if request.method == 'OPTIONS': return await route.fulfill(status=200, headers=h)
    if request.headers.get('authorization') != 'Bearer gat': return await route.fulfill(status=401, headers=h, body='{}')
    u = urlparse(request.url)
    if request.method == 'GET' and u.path.endswith('/drive/v3/files'):
        q = parse_qs(u.query).get('q', [''])[0]; STATE['notes_q'] = q
        hits = [k for k in NOTES if "name='Inkwell notes.json'" in q and "'fold1' in parents" in q]
        return await route.fulfill(status=200, headers=h, content_type='application/json', body=json.dumps({'files': [{'id': k} for k in hits]}))
    if request.method == 'PATCH' and '/upload/drive/v3/files/' in u.path:
        nid = u.path.split('/')[-1]
        if nid not in NOTES: return await route.fulfill(status=404, headers=h, body='{}')
        NOTES[nid] = request.post_data_buffer or b''; STATE['calls'].append(('notes_patch', nid))
        return await route.fulfill(status=200, headers=h, content_type='application/json', body=json.dumps({'id': nid}))
    if '/upload/drive/v3/files' in u.path and b'Inkwell notes.json' in (request.post_data_buffer or b''):
        body = request.post_data_buffer
        assert b'fold1' in body
        nid = 'notes' + str(len(NOTES)).zfill(10); NOTES[nid] = body.split(b'Content-Type: application/json\r\n\r\n', 1)[1].rsplit(b'\r\n--', 1)[0]
        STATE['calls'].append(('notes_create', nid))
        return await route.fulfill(status=200, headers=h, content_type='application/json', body=json.dumps({'id': nid}))
    if '/upload/drive/v3/files' in u.path:
        body = request.post_data_buffer or b''
        assert b'multipart' in request.headers.get('content-type', '').encode() and b'fold1' in body
        gid = 'gid' + str(len(GDRIVE)).zfill(12); GDRIVE[gid] = body
        STATE['calls'].append(('drive_up', gid))
        return await route.fulfill(status=200, headers=h, content_type='application/json', body=json.dumps({'id': gid}))
    gid = u.path.split('/')[-1]
    if gid in GDRIVE: return await route.fulfill(status=200, headers=h, body=b'\xff\xd8\xff' + b'x' * 4, content_type='image/jpeg')
    return await route.fulfill(status=404, headers=h, body='{}')

async def device(b, name, signed=True):
    c = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True, accept_downloads=True)
    init = "localStorage.setItem('inkwell.prefs', JSON.stringify({hwSearch:false}));"
    if signed: init += f"localStorage.setItem('inkwell-auth', {json.dumps(json.dumps(SESSION))});"
    await c.add_init_script(init)
    await c.route('**/*supabase.co/**', handler)
    await c.route('https://r2.fake/**', r2route)
    await c.route('https://accounts.google.com/**', gauth)
    await c.route('https://www.googleapis.com/**', gapi)
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
        STATE['r2'] = True
        # old pictures still in the shared storage, to be moved
        FILES_ROWS['a-old1'] = 10; R2['a-old1'] = b'y' * 10
        FILES_ROWS['a-old2'] = 12; R2['a-old2'] = b'z' * 12
        STATE['authed'] = False
        A, pa, ea = await device(b, 'A', signed=False)
        await pa.evaluate("() => document.getElementById('settingsBtn').click()"); await pa.wait_for_timeout(800)
        check(await pa.is_visible('#gLogin') and not await pa.is_visible('#authEmail') and not await pa.is_visible('#authSignup'), 'signed out: Settings shows only Sign in with Google (no email/password)')
        await pa.screenshot(path=D + 'shots/glogin_signedout.png')
        # failure path: Drive box unticked
        STATE['glogin_fail'] = True
        await pa.click('#gLogin'); await pa.wait_for_timeout(5000)
        msg = await pa.text_content('#gLoginMsg')
        check('Google Drive box ticked' in (msg or '') and await pa.is_visible('#gLogin'), 'if Drive was not allowed, it says so and stays signed out')
        STATE['glogin_fail'] = False
        await pa.click('#gLogin'); await pa.wait_for_timeout(5000)
        q = STATE.get('gauth', {})
        check(q.get('state', [''])[0].startswith('gl-') and 'drive.file' in q.get('scope', [''])[0], 'one Google screen asks for sign-in and Drive together')
        check(STATE.get('glogin', {}).get('code') == 'gcode' and not STATE.get('glogin_auth') and STATE.get('glogin_key', '').startswith('sb_publishable_'), 'the code goes to the server without an Inkwell session (new publishable key, no Bearer)')
        check(STATE.get('verify', {}).get('token_hash') == 'th123', 'the app finishes the sign-in with the one-time token')
        await pa.wait_for_timeout(4000)
        user = await pa.evaluate("() => __inkwell.Sync.user && __inkwell.Sync.user.id")
        check(user == UID, 'signed in to the same Inkwell account (%s)' % user)
        t = await pa.text_content('#toastText'); print(' toast:', t)
        check('Signed in as r@gmail.com' in (t or ''), 'an existing account is opened (no new-account warning)')
        await pa.wait_for_timeout(9000)
        check('a-old1' in DRIVE_ROWS and 'a-old2' in DRIVE_ROWS and not R2, 'old pictures move to Google Drive by themselves')
        check(len(NOTES) == 1, 'notes copy made in Drive after sign-in')
        await pa.evaluate("() => document.getElementById('settingsBtn').click()"); await pa.wait_for_timeout(1500)
        st = await pa.text_content('#gdState'); print(' state:', st)
        check(not await pa.is_visible('#cloudRow') and not await pa.is_visible('#gdToggle') and not await pa.is_visible('#gdMove') and await pa.is_visible('#cleanupBtn'), 'no shared storage bar or switches; Clean up is still there')
        check('r@gmail.com' in st and 'notes copied at' in st, 'Settings shows the Google account and the notes copy')
        check(STATE.get('gchecks', 0) >= 1 and 'pictures checked' in st, 'after the move the app checks the pictures are in Drive')
        STATE['gmissing'] = 3
        await pa.evaluate("async () => { await __inkwell.GD.check(true); }")
        t = await pa.text_content('#toastText'); print(' check toast:', t)
        check('3 pictures are missing' in (t or ''), 'missing Drive pictures are reported')
        STATE['gmissing'] = 0
        await pa.evaluate("() => document.getElementById('gdBox').scrollIntoView({block: 'center'})"); await pa.wait_for_timeout(300)
        await pa.screenshot(path=D + 'shots/glogin_settings.png')
        await pa.evaluate("() => document.querySelectorAll('.modal').forEach(m => m.hidden = true)")
        aid = await pa.evaluate("""async () => { const W = __inkwell; await W.newPage(); const id = await W.saveAsset(new Blob([new Uint8Array([255,216,255,7,7,7])], {type:'image/jpeg'}));
            W.addItems([{t:'i', id:'i_g', x:0, y:0, w:100, h:80, a:id}]); await W.flushSaves(); return id; }""")
        print('A sync:', await sync(pa))
        check(aid in DRIVE_ROWS and aid not in R2, 'a new picture goes to Google Drive')
        # Drive access lost: new pictures wait on the device, nothing goes to shared storage
        STATE['gd']['broken'] = True
        await pa.evaluate("async () => { __inkwell.GD.tok = null; await __inkwell.Files.on(true); }")
        aid2 = await pa.evaluate("""async () => { const W = __inkwell; const id = await W.saveAsset(new Blob([new Uint8Array([255,216,255,8,8])], {type:'image/jpeg'})); W.addItems([{t:'i', id:'i_g2', x:0, y:100, w:100, h:80, a:id}]); await W.flushSaves(); return id; }""")
        st2 = await sync(pa); print(' sync with Drive lost:', st2)
        pend = await pa.evaluate("async () => (await __inkwell.IDB.get('meta', 'pendingAssets')) || []")
        check(aid2 in pend and aid2 not in R2 and aid2 not in DRIVE_ROWS, 'without Drive a new picture waits on the device')
        check('synced' in st2 or 'Google' in st2, 'notes still sync (%s)' % st2)
        await pa.evaluate("() => document.getElementById('settingsBtn').click()"); await pa.wait_for_timeout(1000)
        check(await pa.is_visible('#gdConnect') and (await pa.text_content('#gdConnect')) == 'Connect again', 'Settings offers Connect again')
        # reconnect -> waiting picture uploads
        STATE['gd']['broken'] = False
        await pa.click('#gdConnect'); await pa.wait_for_timeout(6000)
        print(' after reconnect:', await sync(pa))
        pend = await pa.evaluate("async () => (await __inkwell.IDB.get('meta', 'pendingAssets')) || []")
        check(aid2 in DRIVE_ROWS and not pend, 'after connecting again, the waiting picture goes to Drive')
        # another device: Google sign-in opens the same notes
        STATE['authed'] = False
        B, pb, eb = await device(b, 'B', signed=False)
        await pb.evaluate("() => document.getElementById('settingsBtn').click()"); await pb.wait_for_timeout(500)
        STATE['created'] = True
        await pb.click('#gLogin'); await pb.wait_for_timeout(2500)
        t = await pb.text_content('#toastText'); print(' B toast:', t)
        check('New Inkwell account made' in (t or ''), 'signing in with a Google account that has no Inkwell account yet says so')
        await pb.wait_for_timeout(6500)
        print('B sync:', await sync(pb))
        got = await pb.evaluate("async id => { const r = await __inkwell.Sync.fetchAsset(id); return r ? r.blob.size : -1; }", aid)
        hasPage = await pb.evaluate("() => [...__inkwell.docs.values()].length")
        check(got == 7 and hasPage > 3, 'second device signs in with Google and gets the notes and pictures')
        check(not (ea + eb), 'no page errors: %s' % (ea + eb)[:3])
        await b.close()
    print('ALL OK' if ok else 'SOME FAILED')
    if not ok: raise SystemExit(1)
asyncio.run(main())
