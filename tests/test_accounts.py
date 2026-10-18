# 1.36: each account has its own notes on a device. Signing out and in with another account must not show or upload
# the first account's notes there; signing back in brings them back. Notes made without an account go into the
# account that signs in first. Runs against a fake Supabase with two accounts.
import asyncio, json, re, base64, time, os
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'

def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
def user(uid, email):
    jwt = b64({'alg': 'HS256', 'typ': 'JWT'}) + '.' + b64({'sub': uid, 'exp': 4102444800, 'role': 'authenticated', 'aud': 'authenticated', 'email': email}) + '.sig'
    u = {'id': uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': email}
    return {'jwt': jwt, 'user': u, 'session': {'access_token': jwt, 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': 4102444800, 'refresh_token': 'rt-' + uid[:4], 'user': u}}
A = user('aaaaaaaa-1111-1111-1111-111111111111', 'a@gmail.com')
B = user('bbbbbbbb-2222-2222-2222-222222222222', 'b@gmail.com')
BY_JWT = {A['jwt']: A, B['jwt']: B}
SERVER = {A['user']['id']: {}, B['user']['id']: {}}
STATE = {'next': A}
CLOCK = [0]
def ts():
    CLOCK[0] += 1
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(1760000000 + CLOCK[0])) + '.%06d+00:00' % CLOCK[0]
def parse_in(v):
    m = re.match(r'in\.\((.*)\)$', v); return [x.strip('"') for x in m.group(1).split(',')] if m else []
def pick(row, sel):
    cols = sel.split(',') if sel else list(row.keys()); return {c: row.get(c) for c in cols}
def J(route, status, obj): return route.fulfill(status=status, content_type='application/json', body=json.dumps(obj), headers={'Access-Control-Allow-Origin': '*'})
def who(request):
    t = (request.headers.get('authorization') or '').replace('Bearer ', '')
    return BY_JWT.get(t)

async def handler(route, request):
    u = urlparse(request.url); q = parse_qs(u.query); path = u.path
    if '/auth/v1/' in path:
        if path.endswith('/verify'): return await J(route, 200, STATE['next']['session'])
        if path.endswith('/logout'): return await route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*'})
        w = who(request)
        if path.endswith('/user'): return await J(route, 200 if w else 401, w['user'] if w else {'msg': 'no'})
        return await J(route, 200, (w or STATE['next'])['session'])
    if path.endswith('/functions/v1/files'):
        if request.method == 'OPTIONS': return await route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*'})
        b = json.loads(request.post_data or '{}')
        if b.get('action') == 'glogin':
            n = STATE['next']['user']
            return await J(route, 200, {'token_hash': 'th', 'email': n['email'], 'created': False})
        if b.get('action') == 'info': return await J(route, 200, {'r2': True, 'used_mb': 0, 'total_mb': 0, 'cap_mb': 9000, 'google_client_id': 'cid', 'gdrive': None})
        return await J(route, 200, {})
    if '/functions/v1/' in path: return await J(route, 404, {'error': 'nf'})
    if path.endswith('/rest/v1/docs'):
        w = who(request)
        if not w: return await J(route, 401, {'message': 'JWT expired'})
        store = SERVER[w['user']['id']]
        if request.method == 'GET':
            rows = list(store.values())
            if 'server_ts' in q: rows = [r for r in rows if r['server_ts'] > q['server_ts'][0][3:]]
            if 'id' in q: ids = set(parse_in(q['id'][0])); rows = [r for r in rows if r['id'] in ids]
            rows.sort(key=lambda r: r['server_ts'])
            if 'limit' in q: rows = rows[:int(q['limit'][0])]
            return await J(route, 200, [pick(r, q.get('select', [''])[0]) for r in rows])
        if request.method == 'POST':
            body = json.loads(request.post_data or '[]'); body = [body] if isinstance(body, dict) else body; out = []
            for r in body:
                assert r['user_id'] == w['user']['id'], 'row for another account'
                if STATE.get('full') and r.get('id') in STATE['full']:
                    return await J(route, 400, {'code': 'P0001', 'message': 'notes_full'})
                r = dict(r); r['server_ts'] = ts(); store[r['id']] = r; out.append(r)
            return await J(route, 201, [pick(r, q.get('select', [''])[0]) for r in out])
    return await route.fulfill(status=404, body='')

async def device(b, name, session=None):
    c = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
    init = "if(!sessionStorage.getItem('t0')){ sessionStorage.setItem('t0','1'); localStorage.setItem('inkwell.prefs', JSON.stringify({hwSearch:false}));"
    if session: init += f"localStorage.setItem('inkwell-auth', {json.dumps(json.dumps(session))});"
    init += "}"
    await c.add_init_script(init)
    await c.route('**/*supabase.co/**', handler)
    async def gauth(route, request):
        qq = parse_qs(urlparse(request.url).query)
        return await route.fulfill(status=302, headers={'Location': qq['redirect_uri'][0] + '?code=gcode&state=' + qq['state'][0]})
    await c.route('https://accounts.google.com/**', gauth)
    try: await c.route_web_socket(re.compile('.*supabase.*'), lambda ws: ws.close())
    except Exception: pass
    pg = await c.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(f'{name}: {e}'))
    await pg.goto(URL); await pg.wait_for_timeout(3500)
    return c, pg, errs

async def sync(pg):
    return await pg.evaluate("""async () => { const S = __inkwell.Sync; await S.run(); for(let i = 0; i < 100 && (S.running || S.again); i++) await new Promise(r => setTimeout(r, 50)); return S.state + ' ' + S.msg; }""")

async def new_page(pg, title):
    return await pg.evaluate("""async t => { const W = __inkwell; await W.newPage(); const id = W.cur.id; const d = W.docs.get(id);
        document.getElementById('title').value = t; document.getElementById('title').dispatchEvent(new Event('input', {bubbles: true}));
        W.addItems([{t:'x', id:'x_' + t.replace(/\\W/g, ''), x:0, y:0, w:300, fs:1, html:'<p>' + t + '</p>'}]); await W.flushSaves(); return id; }""", title)

async def titles(pg):
    return await pg.evaluate("() => [...__inkwell.docs.values()].filter(d => d.kind === 'page' && !d.deleted && d.data).map(d => d.data.title)")

async def google_signin(pg, who_):
    STATE['next'] = who_
    await pg.evaluate("() => document.getElementById('settingsBtn').click()"); await pg.wait_for_timeout(600)
    await pg.click('#gLogin')
    await pg.wait_for_timeout(6000)

async def main():
    ok = True
    def check(cond, msg):
        nonlocal ok; print(('PASS ' if cond else 'FAIL ') + msg); ok = ok and bool(cond)
    async with async_playwright() as p:
        br = await p.chromium.launch()
        # 1. an install from before 1.36, signed in as A: its notes stay, nothing reloads, the database now belongs to A
        c, pg, errs = await device(br, 'dev', session=A['session'])
        await new_page(pg, 'A secret page')
        print(' sync:', await sync(pg))
        check(any((r.get('data') or {}).get('title') == 'A secret page' for r in SERVER[A['user']['id']].values()), 'A\'s page uploads to A')
        owner = await pg.evaluate("async () => await __inkwell.IDB.get('meta', 'owner')")
        check(owner == A['user']['id'], 'the local notes now belong to A')
        # 2. sign out: A's notes stay on the device (nothing deleted)
        await pg.evaluate("() => document.getElementById('settingsBtn').click()"); await pg.wait_for_timeout(500)
        await pg.click('#signOut'); await pg.wait_for_timeout(1500)
        check('A secret page' in await titles(pg), 'after signing out, A\'s notes are still on the device')
        await pg.evaluate("() => document.querySelectorAll('.modal').forEach(m => m.hidden = true)")
        # 3. sign in with Google as B: the app switches to B's own notes
        await google_signin(pg, B)
        await pg.wait_for_timeout(3000)
        print(' toast:', await pg.text_content('#toastText'))
        uid = await pg.evaluate("() => __inkwell.Sync.user && __inkwell.Sync.user.id")
        check(uid == B['user']['id'], 'signed in as B')
        print(' B sync:', await sync(pg))
        t = await titles(pg)
        check('A secret page' not in t, 'B does not see A\'s notes (%s)' % t)
        check(not any((r.get('data') or {}).get('title') == 'A secret page' for r in SERVER[B['user']['id']].values()), 'nothing of A was uploaded into B')
        await new_page(pg, 'B page')
        print(' B sync:', await sync(pg))
        check(any((r.get('data') or {}).get('title') == 'B page' for r in SERVER[B['user']['id']].values()), 'B\'s new page goes to B')
        check(not any((r.get('data') or {}).get('title') == 'B page' for r in SERVER[A['user']['id']].values()), 'B\'s page is not in A')
        # 4. sign out, back in as A: A's notes come back, B's stay away
        await pg.evaluate("() => document.getElementById('settingsBtn').click()"); await pg.wait_for_timeout(500)
        await pg.click('#signOut'); await pg.wait_for_timeout(1500)
        await pg.evaluate("() => document.querySelectorAll('.modal').forEach(m => m.hidden = true)")
        await google_signin(pg, A)
        await pg.wait_for_timeout(3000)
        print(' A sync:', await sync(pg))
        t = await titles(pg)
        check('A secret page' in t and 'B page' not in t, 'back in A: A\'s notes are there, B\'s are not (%s)' % t)
        dbs = await pg.evaluate("() => JSON.parse(localStorage.getItem('inkwell.dbs'))")
        check(dbs['cur'] == 'inkwell', 'A uses the original local database again (%s)' % dbs)
        # 5. notes limit: a refused doc does not block the others
        STATE['full'] = set()
        pid = await new_page(pg, 'too much')
        STATE['full'] = {'c_' + pid}
        await new_page(pg, 'small one')
        st = await sync(pg); print(' sync with a refused doc:', st)
        check('Notes storage full' in st, 'a full notes storage is explained (%s)' % st)
        check(any((r.get('data') or {}).get('title') == 'small one' for r in SERVER[A['user']['id']].values()), 'the other changes still upload')
        dirty = await pg.evaluate("async id => { const d = await __inkwell.IDB.get('docs', 'c_' + id); return d && d.dirty; }", pid)
        check(dirty, 'the refused page stays on the device, waiting')
        STATE['full'] = set()
        st = await sync(pg)
        check(st.startswith('synced'), 'once there is room it uploads (%s)' % st)
        check(not errs, 'no page errors: %s' % errs[:3])
        await c.close()
        # 6. a new device used without an account: its notes go into the account that signs in
        c2, p2, e2 = await device(br, 'guest')
        await new_page(p2, 'Guest notes')
        await google_signin(p2, B)
        await p2.wait_for_timeout(2000)
        print(' guest sync:', await sync(p2))
        check(any((r.get('data') or {}).get('title') == 'Guest notes' for r in SERVER[B['user']['id']].values()), 'notes made without an account upload into the account that signs in')
        check(await p2.evaluate("() => JSON.parse(localStorage.getItem('inkwell.dbs')).cur") == 'inkwell', 'no reload or switch for a device without an account')
        check(not e2, 'no page errors: %s' % e2[:3])
        await br.close()
    print('ALL OK' if ok else 'SOME FAILED')
    if not ok: raise SystemExit(1)
asyncio.run(main())
