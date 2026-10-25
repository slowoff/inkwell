# 1.60.2: sync fixes.
# (1) A pull no longer skips a row that became visible on the server after a later one (late commit).
# (2) Uploads go through docs_put, which refuses to overwrite a server copy newer than the one the device last saw;
#     the device merges the newer copy and uploads again, so crossing uploads cannot drop strokes.
#     With docs_put, a stroke erased on the other device no longer comes back.
# (3) The local database gets an index on 'dirty' (version 2); an old "dirty: true" doc is still uploaded, and a
#     sync no longer reads every doc.
# (4) A server without docs_put still syncs the old way.
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

LEGACY = """
if(!sessionStorage.getItem('legacy0')){
  sessionStorage.setItem('legacy0', '1');
  // an install from before 1.60.2: database version 1, one unsynced template stored with dirty: true
  const r = indexedDB.open('inkwell', 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('docs', {keyPath: 'id'}); d.createObjectStore('assets', {keyPath: 'id'}); d.createObjectStore('meta'); };
  r.onsuccess = () => {
    const d = r.result, t = d.transaction(['docs', 'meta'], 'readwrite');
    t.objectStore('docs').put({id: 'tmpl-legacy', kind: 'tmpl', data: {name: 'Legacy template', bg: {type: 'blank'}, items: []}, deleted: false, updated: 5, dirty: true});
    t.objectStore('docs').put({id: 'tmpl-synced', kind: 'tmpl', data: {name: 'Synced template', bg: {type: 'blank'}, items: []}, deleted: false, updated: 4, dirty: 0});
    t.oncomplete = () => d.close();
  };
}
"""

async def device(b, name, legacy=False):
    c = await b.new_context(viewport={'width': 1180, 'height': 820})
    init = "if(!sessionStorage.getItem('t0')){ sessionStorage.setItem('t0','1'); localStorage.setItem('inkwell.prefs', JSON.stringify({hwSearch:false})); localStorage.setItem('inkwell-auth', %s); }" % json.dumps(json.dumps(SESSION))
    await c.add_init_script(init)
    if legacy: await c.add_init_script(LEGACY)
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

async def main():
    fails = []
    def check(cond, msg):
        print(('ok   ' if cond else 'FAIL ') + msg)
        if not cond: fails.append(msg)
    async with async_playwright() as p:
        br = await p.chromium.launch()
        c1, d1, e1 = await device(br, 'dev1', legacy=True)

        # (3) the old database was upgraded, the old dirty: true doc is found and uploaded
        r = await d1.evaluate("""async () => { const W = __inkwell;
          const v = W.IDB.db.version, idx = W.IDB.db.transaction('docs').objectStore('docs').indexNames.contains('dirty');
          return {v, idx, mem: !!W.IDB.mem}; }""")
        check(r['v'] == 2 and r['idx'] and not r['mem'], f'database upgraded to version 2 with the dirty index ({r})')
        print(' dev1 sync:', await sync(d1))
        check('tmpl-legacy' in STORE, 'a doc stored as "dirty: true" by an older version is still uploaded')
        check('tmpl-synced' not in STORE, 'an already synced doc is not uploaded again')
        check(STATE['rpc'] > 0 and STATE['plain'] == 0, f'uploads go through docs_put (rpc {STATE["rpc"]}, plain {STATE["plain"]})')

        # a sync reads only the unsynced docs, not the whole database
        r = await d1.evaluate("""async () => { const W = __inkwell; let n = 0; const all = W.IDB.all;
          W.IDB.all = function(s){ if(s === 'docs') n++; return all.apply(this, arguments); };
          await W.Sync.run(); for(let i = 0; i < 100 && W.Sync.running; i++) await new Promise(r => setTimeout(r, 50));
          W.IDB.all = all; return n; }""")
        check(r == 0, f'a sync does not read every doc ({r} full reads)')

        # (1) late commit: a row that becomes visible with a time just before what the device already pulled
        print(' dev1 sync:', await sync(d1))
        cursor = await d1.evaluate(f"async () => await __inkwell.IDB.get('meta', 'pull:{UID}')")
        late_ts = fmt(int(key(cursor) // 1000000) - 20, 5)
        STORE['tmpl-late'] = {'id': 'tmpl-late', 'kind': 'tmpl', 'data': {'name': 'Late', 'bg': {'type': 'blank'}, 'items': []}, 'deleted': False, 'updated_at': int(time.time() * 1000), 'user_id': UID, 'server_ts': late_ts}
        print(' dev1 sync:', await sync(d1))
        got = await d1.evaluate("() => __inkwell.docs.has('tmpl-late')")
        check(got, 'a row that showed up late (time before the last pull) is still downloaded')

        # set up a page shared by both devices
        pid = await d1.evaluate(f"""async () => {{ const W = __inkwell, mk = {MK}; await W.newPage(); await new Promise(r => setTimeout(r, 300));
          W.addItems([mk('base1', 0)]); await W.flushSaves(); return W.cur.id; }}""")
        print(' dev1 sync:', await sync(d1))
        cid = 'c_' + pid
        check(cid in STORE, 'page uploaded')
        c2, d2, e2 = await device(br, 'dev2')
        print(' dev2 sync:', await sync(d2))
        await d2.evaluate(f"async () => {{ await __inkwell.openPage('{pid}'); await new Promise(r => setTimeout(r, 400)); }}")
        has = await d2.evaluate("() => __inkwell.cur && __inkwell.cur.items.has('base1')")
        check(has, 'second device has the page')

        # (2) crossing uploads: dev2's upload lands on the server between dev1's check and dev1's upload
        await d2.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('from2', 100)]); await W.flushSaves(); }}")
        await d1.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('from1', 200)]); await W.flushSaves(); }}")
        def dev2_lands():
            row = json.loads(json.dumps(STORE[cid]))
            b1 = next(i for i in row['data']['items'] if i['id'] == 'base1')
            row['data']['items'].append(dict(b1, id='from2'))
            row['server_ts'] = ts(); row['updated_at'] = int(time.time() * 1000)
            STORE[cid] = row
        STATE['inject'] = dev2_lands
        before = STATE['conflicts']
        r = await d1.evaluate("async () => { const W = __inkwell; const n = await W.Sync.push(); return n; }")
        ids = [i['id'] for i in STORE[cid]['data']['items']]
        check(STATE['conflicts'] > before, 'the crossing upload was refused by the server (conflict)')
        check('from1' in ids and 'from2' in ids and 'base1' in ids, f'after the conflict the server has both devices\' strokes ({ids})')
        screen = await d1.evaluate("() => ['from1', 'from2', 'base1'].filter(id => __inkwell.cur.items.has(id))")
        check(len(screen) == 3, f'device 1 shows both devices\' strokes ({screen})')
        dirty = await d1.evaluate(f"async () => (await __inkwell.IDB.get('docs', '{cid}')).dirty")
        check(dirty == 0, 'the page is synced afterwards')

        # (2b) erase on another device while this one is busy: the erased stroke stays erased (it came back in 1.59.1)
        await d1.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('erase_me', 300)]); await W.flushSaves(); }}")
        print(' dev1 sync:', await sync(d1))
        row = json.loads(json.dumps(STORE[cid]))
        row['data']['items'] = [i for i in row['data']['items'] if i['id'] != 'erase_me']
        row['server_ts'] = ts(); row['updated_at'] = int(time.time() * 1000); STORE[cid] = row
        await d1.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; W.addItems([mk('busy', 400)]); }}")
        print(' dev1 sync:', await sync(d1))
        await d1.evaluate("async () => { await __inkwell.flushSaves(); }")
        print(' dev1 sync:', await sync(d1))
        ids = [i['id'] for i in STORE[cid]['data']['items']]
        screen = await d1.evaluate("() => ['erase_me', 'busy'].filter(id => __inkwell.cur.items.has(id))")
        check('erase_me' not in ids and 'erase_me' not in screen, f'a stroke erased on the other device stays erased (server {ids}, screen {screen})')
        check('busy' in ids and 'busy' in screen, 'the stroke written meanwhile is kept')

        # (4) a server without docs_put: the device falls back to the plain upload and keeps syncing
        STATE['norpc'] = True
        c3, d3, e3 = await device(br, 'dev3')
        plain0 = STATE['plain']
        await d3.evaluate(f"async () => {{ const W = __inkwell, mk = {MK}; await W.newPage(); await new Promise(r => setTimeout(r, 300)); W.addItems([mk('old_server', 0)]); await W.flushSaves(); }}")
        st = await sync(d3)
        print(' dev3 sync:', st)
        check(st.startswith('synced') and STATE['plain'] > plain0, f'without docs_put the plain upload is used ({st})')
        check(any('old_server' in json.dumps(r.get('data')) for r in STORE.values()), 'and the page reaches the server')

        errs = e1 + e2 + e3
        check(not errs, f'no page errors {errs[:3]}')
        await br.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
