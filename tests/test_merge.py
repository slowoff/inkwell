import asyncio, json, re, base64, time, sys
from urllib.parse import urlparse, parse_qs, unquote
from playwright.async_api import async_playwright
import os
PORT = os.environ.get('INKWELL_PORT', '8766')
OUT = os.environ.get('INKWELL_TEST_OUT', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')) + '/'
os.makedirs(OUT + 'shots', exist_ok=True)

URL = f'http://localhost:{PORT}/'
UID = '11111111-1111-1111-1111-111111111111'
SERVER = {}          # id -> row
CLOCK = [0]
LOG = []

def ts():
    CLOCK[0] += 1
    base = 1760000000 + CLOCK[0]
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(base)) + '.%06d+00:00' % (CLOCK[0] * 7 % 1000000)

def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
JWT = b64({'alg': 'HS256', 'typ': 'JWT'}) + '.' + b64({'sub': UID, 'exp': 4102444800, 'role': 'authenticated', 'aud': 'authenticated'}) + '.sig'
USER = {'id': UID, 'aud': 'authenticated', 'role': 'authenticated', 'email': 'r@example.com'}
SESSION = {'access_token': JWT, 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': 4102444800, 'refresh_token': 'rt', 'user': USER}

def parse_in(v):
    m = re.match(r'in\.\((.*)\)$', v)
    return [x.strip('"') for x in m.group(1).split(',')] if m else []

def pick(row, sel):
    cols = sel.split(',') if sel else list(row.keys())
    return {c: row.get(c) for c in cols}

async def handler(route, request):
    u = urlparse(request.url); q = parse_qs(u.query)
    path = u.path
    if '/auth/v1/' in path:
        return await route.fulfill(status=200, content_type='application/json', body=json.dumps(USER if path.endswith('/user') else SESSION))
    if '/storage/v1/' in path:
        return await route.fulfill(status=200, content_type='application/json', body='{"Key":"x"}')
    if path.endswith('/rest/v1/docs'):
        if request.method == 'GET':
            rows = list(SERVER.values())
            if 'server_ts' in q:
                cur = q['server_ts'][0][3:]
                rows = [r for r in rows if r['server_ts'] > cur]
            if 'id' in q:
                ids = set(parse_in(q['id'][0])); rows = [r for r in rows if r['id'] in ids]
            rows.sort(key=lambda r: r['server_ts'])
            if 'limit' in q: rows = rows[:int(q['limit'][0])]
            return await route.fulfill(status=200, content_type='application/json', body=json.dumps([pick(r, q.get('select', [''])[0]) for r in rows]))
        if request.method == 'POST':
            body = json.loads(request.post_data or '[]')
            if isinstance(body, dict): body = [body]
            out = []
            for r in body:
                r = dict(r); r['server_ts'] = ts()
                # jsonb reorders keys: mimic by sorting
                r['data'] = json.loads(json.dumps(r['data'], sort_keys=True)) if r.get('data') is not None else None
                SERVER[r['id']] = r; out.append(r)
                LOG.append(('push', r['id']))
            sel = q.get('select', [''])[0]
            return await route.fulfill(status=201, content_type='application/json', body=json.dumps([pick(r, sel) for r in out]))
    if '/functions/v1/' in path:
        return await route.fulfill(status=500, body='no')
    return await route.fulfill(status=404, body='')

async def device(b, name):
    c = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
    await c.add_init_script(f"localStorage.setItem('inkwell-auth', {json.dumps(json.dumps(SESSION))}); localStorage.setItem('inkwell.prefs', JSON.stringify({{hwSearch:false}}));")
    await c.route('**/*supabase.co/**', handler)
    try:
        await c.route_web_socket(re.compile('.*supabase.*'), lambda ws: ws.close())
    except Exception: pass
    pg = await c.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(f'{name}: {e}'))
    pg.on('console', lambda m: errs.append(f'{name} console: {m.text}') if m.type == 'error' and 'WebSocket' not in m.text and 'Failed to load resource' not in m.text else None)
    await pg.goto(URL); await pg.wait_for_timeout(3500)
    return c, pg, errs

async def sync(pg):
    await pg.evaluate("""async () => { const S = __inkwell.Sync; await S.run(); for(let i = 0; i < 100 && (S.running || S.again); i++) await new Promise(r => setTimeout(r, 50)); return S.state + ' ' + S.msg; }""")
    st = await pg.evaluate("__inkwell.Sync.state + ' ' + __inkwell.Sync.msg")
    return st

def stroke(id, x, c='auto'):
    return {'t': 's', 'id': id, 'c': c, 'w': 2, 'hl': 0, 'p': [x, 100, 0.5, x + 40, 120, 0.5, x + 80, 100, 0.5]}

async def items_of(pg, pid):
    return await pg.evaluate("""async pid => { const d = await __inkwell.IDB.get('docs', 'c_' + pid); return d && d.data ? d.data.items.map(i => i.id + '|' + (i.t === 'x' ? i.html : i.c)) : null; }""", pid)

async def mem_items(pg):
    return await pg.evaluate("""() => { const c = __inkwell.cur; return c ? [...c.items.values()].map(i => i.id + '|' + (i.t === 'x' ? i.html : i.c)) : null; }""")

async def main():
    ok = True
    def check(cond, msg):
        nonlocal ok
        print(('PASS ' if cond else 'FAIL ') + msg)
        if not cond: ok = False
    async with async_playwright() as p:
        b = await p.chromium.launch()
        A, pa, ea = await device(b, 'A')
        print('A first sync:', await sync(pa))
        # A: new page with items
        pid = await pa.evaluate("""async () => { const W = __inkwell; await W.newPage(); const c = W.cur;
            W.addItems([%s, {t:'x', id:'x_t0', x:40, y:200, w:300, fs:1, html:'<p>hello</p>'}, {t:'x', id:'x_t1', x:40, y:300, w:300, fs:1, html:'<p>second</p>'}]);
            await W.flushSaves(); return c.id; }""" % (json.dumps(stroke('s_s0', 40)),))
        print('A push:', await sync(pa))
        check(('c_' + pid) in SERVER, 'page content reached server')
        B, pb, eb = await device(b, 'B')
        print('B sync:', await sync(pb))
        check(sorted(await items_of(pb, pid) or []) == sorted(await items_of(pa, pid) or []), 'B has the same page as A')
        base = await pb.evaluate("async id => !!(await __inkwell.baseGet(id))", 'c_' + pid)
        check(base, 'B stored a merge base')
        # ---- Scenario 1: both devices have the page open, both offline, both edit ----
        await pb.evaluate("async pid => { await __inkwell.openPage(pid); }", pid)
        await A.set_offline(True); await B.set_offline(True)
        await pa.evaluate("""async () => { const W = __inkwell, c = W.cur;
            W.addItems([%s]);
            W.replaceItems([Object.assign({}, c.items.get('x_t0'), {html:'<p>hello from A</p>'})]);
            W.removeItems(['x_t1']); await W.flushSaves(); }""" % json.dumps(stroke('s_sA', 200)))
        await pb.evaluate("""async () => { const W = __inkwell, c = W.cur;
            W.addItems([%s]);
            W.replaceItems([Object.assign({}, c.items.get('x_t0'), {html:'<p>hello from B</p>'})]);
            W.replaceItems([Object.assign({}, c.items.get('s_s0'), {c:'#d03030'})]);
            await W.flushSaves(); }""" % json.dumps(stroke('s_sB', 300)))
        await A.set_offline(False); print('A sync:', await sync(pa))
        await B.set_offline(False); print('B sync:', await sync(pb))
        print('A sync:', await sync(pa))
        await pa.wait_for_timeout(500)
        ia, ib = sorted(await mem_items(pa)), sorted(await mem_items(pb))
        sa = sorted(await items_of(pa, pid)); sb = sorted(await items_of(pb, pid))
        srv = sorted(i['id'] + '|' + (i['html'] if i['t'] == 'x' else i['c']) for i in SERVER['c_' + pid]['data']['items'])
        print(' A screen:', ia); print(' B screen:', ib); print(' server  :', srv)
        check(ia == ib == sa == sb == srv, 'scenario 1: both devices and server agree')
        ids = [x.split('|')[0] for x in ia]
        check('s_sA' in ids and 's_sB' in ids, 'scenario 1: strokes from both devices kept')
        check('x_t1' not in ids, 'scenario 1: text deleted on A stays deleted')
        check(any(x == 's_s0|#d03030' for x in ia), 'scenario 1: recolour from B kept')
        texts = [x.split('|', 1)[1] for x in ia if x.startswith('x')]
        check('<p>hello from A</p>' in texts and '<p>hello from B</p>' in texts and len(texts) == 2, 'scenario 1: both text versions kept (one as a copy)')
        # ---- Scenario 2: B has another page open, page title renamed on A, moved content on B ----
        await pb.evaluate("async () => { await __inkwell.newPage(); await __inkwell.flushSaves(); }")
        print('B sync:', await sync(pb)); print('A sync:', await sync(pa))
        await A.set_offline(True); await B.set_offline(True)
        await pa.evaluate("""async () => { const W = __inkwell; W.addItems([%s]); await W.flushSaves();
            const p = W.docs.get(W.cur.id); p.data = Object.assign({}, p.data, {title: 'Renamed on A'}); await W.IDB.put('docs', Object.assign({}, p, {updated: Date.now(), dirty: 1})); W.docs.set(p.id, Object.assign({}, p, {updated: Date.now(), dirty: 1})); }""" % json.dumps(stroke('s_sA2', 400)))
        # B edits the (not open) page directly in storage, like a background change, plus its order
        await pb.evaluate("""async pid => { const W = __inkwell; const d = await W.IDB.get('docs', 'c_' + pid);
            d.data = Object.assign({}, d.data, {items: d.data.items.concat([{t:'tp', id:'t_tapeB', x:10, y:10, w:50, h:20}])}); d.updated = Date.now(); d.dirty = 1; await W.IDB.put('docs', d);
            const p = W.docs.get(pid); const np = Object.assign({}, p, {data: Object.assign({}, p.data, {order: -99}), updated: Date.now(), dirty: 1}); await W.IDB.put('docs', np); W.docs.set(pid, np); }""", pid)
        await A.set_offline(False); print('A sync:', await sync(pa))
        await B.set_offline(False); print('B sync:', await sync(pb))
        print('A sync:', await sync(pa))
        ia = sorted(await mem_items(pa)); sb = sorted(await items_of(pb, pid))
        print(' A screen:', ia); print(' B stored:', sb)
        check(ia == sb, 'scenario 2: open page on A and stored page on B agree')
        ids = [x.split('|')[0] for x in ia]
        check('s_sA2' in ids and 't_tapeB' in ids, 'scenario 2: additions from both kept')
        pa_doc = SERVER[pid]['data']
        check(pa_doc.get('title') == 'Renamed on A' and pa_doc.get('order') == -99, 'scenario 2: page title (A) and order (B) both kept: %s' % pa_doc)
        # ---- Scenario 3: no conflicts -> plain update, no copies ----
        n_before = len(ia)
        await pb.evaluate("async pid => { await __inkwell.openPage(pid); }", pid)
        await pb.evaluate("""async () => { const W = __inkwell; W.addItems([%s]); await W.flushSaves(); }""" % json.dumps(stroke('s_sB3', 500)))
        print('B sync:', await sync(pb)); print('A sync:', await sync(pa))
        ia = await mem_items(pa)
        check(len(ia) == n_before + 1 and any(x.startswith('s_sB3') for x in ia), 'scenario 3: simple edit shows up on the open page on A')
        # ---- Sanitizer ----
        res = await pa.evaluate("""() => { window.__pwn = 0; const W = __inkwell;
            const bad = '<p>ok <b>bold</b></p><img src=x onerror="window.__pwn=1"><svg><a><animate attributeName=href values="javascript:window.__pwn=2"/><text>x</text></a></svg><a class="pl" data-page="pg-1" href="javascript:alert(1)">link</a><a href="https://evil">plain</a><span style="color:red;background:url(https://e/x)">c</span><section><u>keep</u></section><math><mi>x</mi></math><iframe src="x"></iframe><div id="app" onclick="x()">d</div><ul class="check"><li class="done">t</li></ul>';
            const out = W.cleanHTML(bad); const t = W.htmlText(bad); return {out, t}; }""")
        await pa.wait_for_timeout(500)
        pwn = await pa.evaluate("window.__pwn")
        out = res['out']; print(' cleaned:', out); print(' text:', res['t'])
        check(pwn == 0, 'sanitizer: nothing ran (htmlText included)')
        check('<img' not in out and '<svg' not in out and 'onerror' not in out and 'href' not in out and 'iframe' not in out and '<math' not in out and 'onclick' not in out and 'id="app"' not in out, 'sanitizer: dangerous parts removed')
        check('<a class="pl" data-page="pg-1">link</a>' in out and 'plain' in out and '<a href' not in out, 'sanitizer: page links kept, other links unwrapped')
        check('<b>bold</b>' in out and '<u>keep</u>' in out and 'color:red' in out and 'url(' not in out and '<ul class="check"><li class="done">t</li></ul>' in out, 'sanitizer: formatting, checklists and colours kept')
        errs = ea + eb
        check(not errs, 'no page errors: %s' % errs[:5])
        await b.close()
    print('ALL OK' if ok else 'SOME FAILED')
    if not ok: raise SystemExit(1)

asyncio.run(main())
