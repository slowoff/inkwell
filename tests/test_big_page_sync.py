# 1.91.2: big pages upload less often (Supabase warned that the project was using up its disk IO budget: a page with
# ~12,000 strokes, 4.9 MB, was sent again after every pause in writing, about every 10 s).
# Checks: small pages still upload on every sync; a big page waits between uploads (stays dirty, sync line says so),
# comes back by itself when its wait is over, and goes up at once with Sync now or when the app goes to the
# background; other docs are not held up by a waiting big page; nothing is lost.
import asyncio, json, re, base64, time, os
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'

def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
UID = 'aaaaaaaa-1111-1111-1111-111111111111'
JWT = b64({'alg': 'HS256', 'typ': 'JWT'}) + '.' + b64({'sub': UID, 'exp': 4102444800, 'role': 'authenticated', 'aud': 'authenticated', 'email': 'a@gmail.com'}) + '.sig'
USER = {'id': UID, 'aud': 'authenticated', 'role': 'authenticated', 'email': 'a@gmail.com'}
SESSION = {'access_token': JWT, 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': 4102444800, 'refresh_token': 'rt-a', 'user': USER}

STORE = {}                       # id -> row
STATE = {'norpc': False, 'inject': None, 'rpc': 0, 'plain': 0, 'conflicts': 0, 'ids': []}
T0 = 1793000000.0
CLOCK = [0]
def fmt(sec, micro):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(sec)) + '.%06d+00:00' % micro
def ts():
    CLOCK[0] += 1
    return fmt(int(T0) + CLOCK[0], CLOCK[0] % 1000000)
def key(s):
    s = s.strip().replace(' ', '+')
    if s.endswith('Z'): s = s[:-1] + '+00:00'
    m = re.match(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?', s)
    base = datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp()
    frac = (m.group(2) or '.0')[1:]
    return int(base) * 1000000 + int((frac + '000000')[:6])
def parse_in(v):
    m = re.match(r'in\.\((.*)\)$', v); return [x.strip('"') for x in m.group(1).split(',')] if m else []
def pick(row, sel):
    cols = sel.split(',') if sel else list(row.keys()); return {c: row.get(c) for c in cols}
def J(route, status, obj): return route.fulfill(status=status, content_type='application/json', body=json.dumps(obj), headers={'Access-Control-Allow-Origin': '*'})
def put_row(r, exp):
    """docs_put for one row: returns server_ts or None (conflict)"""
    old = STORE.get(r['id'])
    if exp == 'new' and old: return None
    if exp not in (None, 'new') and old and key(old['server_ts']) != key(exp): return None
    row = {k: r.get(k) for k in ('id', 'kind', 'data', 'deleted', 'updated_at')}
    row['user_id'] = UID; row['server_ts'] = ts(); STORE[r['id']] = row
    return row['server_ts']

async def handler(route, request):
    u = urlparse(request.url); q = parse_qs(u.query, keep_blank_values=True); path = u.path
    if request.method == 'OPTIONS':
        return await route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
    if '/auth/v1/' in path:
        if path.endswith('/user'): return await J(route, 200, USER)
        return await J(route, 200, SESSION)
    if path.endswith('/functions/v1/files'):
        b = json.loads(request.post_data or '{}')
        if b.get('action') == 'info': return await J(route, 200, {'r2': True, 'used_mb': 0, 'total_mb': 0, 'cap_mb': 9000, 'google_client_id': 'cid', 'gdrive': None})
        return await J(route, 200, {})
    if '/functions/v1/' in path: return await J(route, 404, {'error': 'nf'})
    if path.endswith('/rest/v1/rpc/docs_put'):
        if STATE['norpc']:
            return await J(route, 404, {'code': 'PGRST202', 'message': 'Could not find the function public.docs_put(p_rows) in the schema cache'})
        STATE['rpc'] += 1
        if STATE['inject']:
            f = STATE['inject']; STATE['inject'] = None; f()
        body = json.loads(request.post_data or '{}')
        ok, bad = [], []
        for r in body.get('p_rows') or []:
            STATE['ids'].append(r['id'])
            t = put_row(r, r.get('exp'))
            if t: ok.append({'id': r['id'], 'server_ts': t})
            else: bad.append(r['id']); STATE['conflicts'] += 1
        return await J(route, 200, {'ok': ok, 'conflict': bad})
    if path.endswith('/rest/v1/docs'):
        if request.method == 'GET':
            rows = list(STORE.values())
            if 'server_ts' in q:
                op, v = q['server_ts'][0].split('.', 1)
                k = key(v)
                rows = [r for r in rows if (key(r['server_ts']) > k if op == 'gt' else key(r['server_ts']) >= k)]
            if 'id' in q: ids = set(parse_in(q['id'][0])); rows = [r for r in rows if r['id'] in ids]
            rows.sort(key=lambda r: key(r['server_ts']))
            if 'limit' in q: rows = rows[:int(q['limit'][0])]
            return await J(route, 200, [pick(r, q.get('select', [''])[0]) for r in rows])
        if request.method == 'POST':
            STATE['plain'] += 1
            body = json.loads(request.post_data or '[]'); body = [body] if isinstance(body, dict) else body; out = []
            for r in body:
                t = put_row(r, None); out.append({'id': r['id'], 'server_ts': t})
            return await J(route, 201, [pick(r, q.get('select', [''])[0]) for r in out])
    return await route.fulfill(status=404, body='')


async def device(b):
    c = await b.new_context(viewport={'width': 1180, 'height': 820})
    init = "if(!sessionStorage.getItem('t0')){ sessionStorage.setItem('t0','1'); localStorage.setItem('inkwell.prefs', JSON.stringify({hwSearch:false})); localStorage.setItem('inkwell-auth', %s); }" % json.dumps(json.dumps(SESSION))
    await c.add_init_script(init)
    await c.route('**/*supabase.co/**', handler)
    try: await c.route_web_socket(re.compile('.*supabase.*'), lambda ws: ws.close())
    except Exception: pass
    pg = await c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(URL); await pg.wait_for_timeout(3000)
    await pg.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
    await pg.wait_for_timeout(2500)
    await pg.wait_for_function('window.__inkwell && window.__inkwell.Sync.user', timeout=15000)
    return c, pg, errs

SYNC = """async force => { const S = __inkwell.Sync;
  for(let i = 0; i < 100 && (S.running || S.again); i++) await new Promise(r => setTimeout(r, 50));
  await S.run(force); for(let i = 0; i < 200 && (S.running || S.again); i++) await new Promise(r => setTimeout(r, 50)); return S.state; }"""
MK = "(id, x, n) => { const p = []; for(let k = 0; k < (n || 3); k++) p.push(x + k * 3, 10 + (k % 7) * 4, .5); return {t: 's', id, c: '#000', w: 2, hl: 0, p}; }"

def row_items(cid): return [i['id'] for i in STORE[cid]['data']['items']] if cid in STORE else []

async def main():
    fails = []
    def check(cond, msg):
        print(('ok   ' if cond else 'FAIL ') + msg)
        if not cond: fails.append(msg)
    async with async_playwright() as p:
        br = await p.chromium.launch()
        c, d, errs = await device(br)
        await d.evaluate(SYNC)
        pid = await d.evaluate(f"""async () => {{ const W = __inkwell, mk = {MK}; await W.newPage(); await new Promise(r => setTimeout(r, 300));
          W.addItems([mk('s0', 0)]); await W.flushSaves(); return W.cur.id; }}""")
        cid = 'c_' + pid
        await d.evaluate(SYNC)
        check('s0' in row_items(cid), 'small page uploaded')
        # small page: every sync uploads, no waiting
        for k in (1, 2):
            n0 = STATE['rpc']
            await d.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('s{k}', {k * 20})]); await W.flushSaves(); }}")
            await d.evaluate(SYNC)
            check(f's{k}' in row_items(cid) and STATE['rpc'] > n0, f'small page: edit {k} uploaded right away')
        check(not await d.evaluate("() => __inkwell.Sync.waiting"), 'nothing waiting for a small page')

        # make the page big (~ 400 KB): it uploads the first time
        await d.evaluate(f"""async () => {{ const W = __inkwell, mk = {MK}, a = [];
          for(let i = 0; i < 1500; i++) a.push(mk('b' + i, (i % 50) * 30, 40)); W.addItems(a); await W.flushSaves(); W.Sync.upAt.clear(); }}""")
        size = await d.evaluate(f"async () => JSON.stringify((await __inkwell.IDB.get('docs', '{cid}')).data).length")
        print(' page size', size)
        check(size > 256 * 1024, f'page is big ({size} chars)')
        await d.evaluate(SYNC)
        check('b1499' in row_items(cid), 'big page uploaded the first time')

        # an edit right after: saved on the device, not uploaded yet
        n0 = STATE['ids'].count(cid)
        await d.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('w1', 900)]); await W.flushSaves(); }}")
        st = await d.evaluate(SYNC)
        r = await d.evaluate(f"async () => ({{dirty: (await __inkwell.IDB.get('docs', '{cid}')).dirty, items: (await __inkwell.IDB.get('docs', '{cid}')).data.items.some(i => i.id === 'w1'), waiting: __inkwell.Sync.waiting, txt: document.getElementById('statusText').textContent}})")
        check('w1' not in row_items(cid) and STATE['ids'].count(cid) == n0, f'big page edited again within its wait: not uploaded (page uploads {n0} -> {STATE["ids"].count(cid)})')
        check(r['dirty'] and r['items'], 'the edit is saved on the device and still marked unsynced')
        check(r['waiting'] and st == 'synced', f'sync reports a waiting big page ({st})')
        check(r['txt'] == 'Saved here, syncs shortly', f'sync line: {r["txt"]!r}')

        # other docs still go up while the big page waits
        await d.evaluate("async () => { const W = __inkwell; W.prefs; await W.saveVersion('x-page', {bg: null, items: [{t: 's', id: 'v1', c: '#000', w: 2, hl: 0, p: [0,0,.5,1,1,.5]}]}, 'edit'); }")
        await d.evaluate(SYNC)
        check(any(k.startswith('v_x-page_') for k in STORE), 'a small doc saved meanwhile is uploaded without waiting')
        check('w1' not in row_items(cid), 'the big page is still waiting')

        # Sync now uploads it at once
        await d.evaluate(SYNC, True)
        check('w1' in row_items(cid), 'Sync now uploads the big page at once')
        check(not await d.evaluate("() => __inkwell.Sync.waiting"), 'nothing waiting after Sync now')
        txt = await d.evaluate("() => document.getElementById('statusText').textContent")
        check(txt.startswith('Synced'), f'sync line back to normal ({txt!r})')

        # the wait ends by itself: a later edit goes up without any other sync
        await d.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('w2', 950)]); await W.flushSaves(); }}")
        await d.evaluate(SYNC)
        check('w2' not in row_items(cid), 'edit after Sync now waits again')
        await d.evaluate(f"() => {{ const S = __inkwell.Sync; S.upAt.set('{cid}', Date.now() - 8500); }}")
        await d.evaluate(SYNC)   # recomputes the wait: about 1.5 s left
        await d.wait_for_timeout(4000)
        check('w2' in row_items(cid), 'when the wait is over the big page uploads by itself')

        # going to the background uploads it at once
        await d.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('w3', 980)]); await W.flushSaves(); }}")
        await d.evaluate(SYNC)
        check('w3' not in row_items(cid), 'edit waits again')
        await d.evaluate("""() => { Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
          Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); document.dispatchEvent(new Event('visibilitychange')); }""")
        for _ in range(60):
            if 'w3' in row_items(cid): break
            await d.wait_for_timeout(100)
        check('w3' in row_items(cid), 'leaving the app uploads the waiting big page right away')
        await d.evaluate("() => { delete document.visibilityState; delete document.hidden; }")

        # nothing lost: the server copy has every stroke the device has
        loc = await d.evaluate(f"async () => (await __inkwell.IDB.get('docs', '{cid}')).data.items.map(i => i.id)")
        check(set(loc) == set(row_items(cid)), f'server and device have the same {len(loc)} items')
        print(' page uploads in total:', STATE['ids'].count(cid))
        check(not errs, f'no page errors {errs[:3]}')
        await br.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
