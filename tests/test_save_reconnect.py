# (1.90.4) iPadOS cut Inkwell off from its storage while it ran ("storage is full or blocked" with 30 GB free); every save
# failed until a restart. Now: a lost connection is opened again; if that fails, unsaved changes go to the cloud and Restart
# brings them back; the warning names the error.
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
STATE = {'norpc': False, 'inject': None, 'rpc': 0, 'plain': 0, 'conflicts': 0}
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


async def device(b, name):
    c = await b.new_context(viewport={'width': 1180, 'height': 820})
    init = "if(!sessionStorage.getItem('t0')){ sessionStorage.setItem('t0','1'); localStorage.setItem('inkwell.prefs', JSON.stringify({hwSearch:false})); localStorage.setItem('inkwell-auth', %s); }" % json.dumps(json.dumps(SESSION))
    await c.add_init_script(init)
    await c.route('**/*supabase.co/**', handler)
    try: await c.route_web_socket(re.compile('.*supabase.*'), lambda ws: ws.close())
    except Exception: pass
    pg = await c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(f'{name}: {e}'))
    await pg.goto(URL); await pg.wait_for_timeout(3000)
    await pg.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
    await pg.wait_for_timeout(2500)
    await pg.wait_for_function('window.__inkwell && window.__inkwell.Sync.user', timeout=15000)
    return c, pg, errs

async def sync(pg):
    return await pg.evaluate("""async () => { const S = __inkwell.Sync;
      for(let i = 0; i < 100 && (S.running || S.again); i++) await new Promise(r => setTimeout(r, 50));
      await S.run(); for(let i = 0; i < 200 && (S.running || S.again); i++) await new Promise(r => setTimeout(r, 50)); return S.state + ' ' + (S.msg || ''); }""")

MK = "(id, x) => ({t: 's', id, c: '#000', w: 2, hl: 0, p: [x, 10, .5, x + 5, 20, .5, x + 10, 10, .5]})"
WARN = "(() => { const e = document.getElementById('saveWarn'); return e && !e.hidden ? e.textContent : ''; })()"
STORED = "async cid => { const d = await __inkwell.IDB.get('docs', cid); return d ? d.data.items.map(i => i.id) : []; }"
# what iPadOS does when it cuts the app off from its storage: every step fails, and opening again fails too
BREAK = """() => {
  const err = () => new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
  IDBDatabase.prototype.transaction = function(){ throw err(); };
  indexedDB.open = function(){ const r = {}; setTimeout(() => { r.error = err(); r.onerror && r.onerror(); }, 0); return r; };
}"""

async def main():
    fails = []
    def check(cond, msg):
        print(('ok   ' if cond else 'FAIL ') + msg)
        if not cond: fails.append(msg)
    async with async_playwright() as p:
        br = await p.chromium.launch()
        c, d, errs = await device(br, 'dev')
        pid = await d.evaluate(f"""async () => {{ const W = __inkwell, mk = {MK}; await W.newPage(); await new Promise(r => setTimeout(r, 300));
          W.addItems([mk('s1', 0)]); await W.flushSaves(); return W.cur.id; }}""")
        cid = 'c_' + pid
        print(' sync:', await sync(d))
        check(cid in STORE, 'page uploaded')

        # 1. the connection is closed under the app: the next save opens it again, no warning, nothing lost
        await d.evaluate("() => __inkwell.IDB.db.close()")
        await d.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('s2', 30)]); await W.flushSaves(); }}")
        await d.wait_for_timeout(400)
        st = await d.evaluate(f"({STORED})('{cid}')")
        n = await d.evaluate("__inkwell.IDB.reopened")
        check('s2' in st and n >= 1, f'save after a lost connection: opened again ({n}) and saved ({st})')
        check(await d.evaluate(WARN) == '', 'no warning when reconnecting works')

        # 2. the browser reports the connection closed (close event): opened again on the next step
        await d.evaluate("() => __inkwell.IDB.db.dispatchEvent(new Event('close'))")
        check(await d.evaluate("__inkwell.IDB.db === null"), 'a close event drops the dead connection')
        await d.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('s3', 60)]); await W.flushSaves(); }}")
        await d.wait_for_timeout(400)
        st = await d.evaluate(f"({STORED})('{cid}')")
        check('s3' in st and await d.evaluate(WARN) == '', f'saved after a close event ({st})')
        print(' sync:', await sync(d))
        check(set(['s1', 's2', 's3']) <= set(i['id'] for i in STORE[cid]['data']['items']), 'syncing works after reconnecting')

        # 3. storage cut off for good: warning names the error, unsaved changes go to the cloud, Restart brings them back
        await d.evaluate(BREAK)
        await d.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('s4', 90)]); await W.flushSaves(); }}")
        await d.wait_for_timeout(600)
        w = await d.evaluate(WARN)
        check('UnknownError' in w and 'not saved on this device' in w, f'warning shows and names the error ({w!r})')
        check(not await d.is_visible('#saveWarn .sw-btn'), 'no Restart button before the cloud has it')
        await d.wait_for_function("(() => { const b = document.querySelector('#saveWarn .sw-btn'); return b && !b.hidden; })()", timeout=15000)
        w = await d.evaluate(WARN)
        ids = [i['id'] for i in STORE[cid]['data']['items']]
        check('s4' in ids, f'the unsaved stroke reached the cloud ({ids})')
        check('saved in the cloud' in w, f'warning says it is in the cloud and offers Restart ({w!r})')
        await d.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('s5', 120)]); await W.flushSaves(); }}")
        await d.wait_for_function(f"!document.querySelector('#saveWarn .sw-btn').hidden && document.getElementById('saveWarn').textContent.includes('cloud')", timeout=20000)
        await d.wait_for_timeout(500)
        for _ in range(40):
            if 's5' in [i['id'] for i in STORE[cid]['data']['items']]: break
            await d.wait_for_timeout(500)
        ids = [i['id'] for i in STORE[cid]['data']['items']]
        check('s5' in ids, f'a later stroke goes to the cloud too ({ids})')
        bx = await d.evaluate("(() => { const r = document.querySelector('#saveWarn .sw-btn').getBoundingClientRect(); return [r.width, r.height]; })()")
        await d.screenshot(path=os.environ.get('SHOT_DIR', '/tmp') + '/save_warn.png')
        await d.click('#saveWarn .sw-btn')
        await d.wait_for_timeout(3000)
        await d.wait_for_function('window.__inkwell && window.__inkwell.Sync.user', timeout=15000)
        print(' sync:', await sync(d))
        await d.evaluate(f"async () => {{ await __inkwell.newPage(); await new Promise(r => setTimeout(r, 300)); await __inkwell.openPage('{pid}'); await new Promise(r => setTimeout(r, 400)); }}")
        on = await d.evaluate("() => ['s1', 's2', 's3', 's4', 's5'].filter(id => __inkwell.cur.items.has(id))")
        check(len(on) == 5, f'after Restart the page has every stroke ({on})')
        st = await d.evaluate(f"({STORED})('{cid}')")
        check(set(['s4', 's5']) <= set(st) and await d.evaluate(WARN) == '', f'and the device saves again ({st})')
        check(not errs, f'no page errors ({errs})')
        await br.close()
    print('ALL PASSED' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
