# 1.69 fixes.
# (1) Highlighter "Stick to text": a drawing beside the text (ink in every row) no longer joins the lines around it into
#     one giant line; marking one word gives one band the height of that line (Rafael: marking "Ereignis-" next to a
#     cartoon covered half the page).
# (2) The ink layer is checked after drawing: if it holds none of the ink that was just drawn (the iPad dropped the
#     canvas's picture), it is replaced by a fresh canvas and drawn again. A frame step that throws no longer stops
#     later frames from drawing.
# (3) Sync: a page that is in Recently deleted on the server but restored/changed later on this device was refused on
#     every upload (three tries every 20 s, for good). Now the newer copy here is uploaded once and the loop ends.
import asyncio, json, re, base64, time, os
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(cond, msg):
    print(('ok   ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)

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


async def device(b, name, legacy=False):
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


SETUP_HL = """async () => {
  const W = __inkwell;
  await W.newPage(); await new Promise(r => setTimeout(r, 300));
  // page picture 1600 x 2000 px shown 800 x 1000 world at (40, 40); world = 40 + px / 2
  const c = document.createElement('canvas'); c.width = 1600; c.height = 2000;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1600, 2000); g.fillStyle = '#111';
  const words = {};
  const put = (txt, x, base, font) => {
    g.font = font; g.textBaseline = 'alphabetic';
    let cx = x;
    for(const wd of txt.split(' ')){
      const m = g.measureText(wd);
      g.fillText(wd, cx, base);
      words[wd] = [40 + (cx - m.actualBoundingBoxLeft) / 2, 40 + (base - m.actualBoundingBoxAscent) / 2, 40 + (cx + m.actualBoundingBoxRight) / 2, 40 + (base + m.actualBoundingBoxDescent) / 2];
      cx += m.width + g.measureText(' ').width;
    }
    return cx;
  };
  let e = 0;
  e = Math.max(e, put('Mit dem passe compose sprechen Sie', 100, 500, '34px serif'));
  e = Math.max(e, put('die sich in der Vergangenheit Ereignis', 100, 556, '34px serif'));
  e = Math.max(e, put('Wie das deutsche Perfekt setzt sich', 100, 612, '34px serif'));
  e = Math.max(e, put('aus zwei Verben zusammen dem Hilfsverb', 100, 668, '34px serif'));
  // a cartoon right next to the text: outlines and hatching with ink in every row from above line 1 to below line 4
  const L = e + 24;
  g.strokeStyle = '#111'; g.lineWidth = 4;
  g.strokeRect(L, 420, 300, 300);
  g.beginPath(); for(let y = 430; y < 720; y += 9){ g.moveTo(L + 10, y); g.lineTo(L + 120 + (y % 50), y + 4); } g.stroke();
  g.beginPath(); g.arc(L + 200, 520, 60, 0, Math.PI * 2); g.stroke();
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const a = await W.saveAsset(blob);
  W.addItems([{t: 'i', id: 'ipage', x: 40, y: 40, w: 800, h: 1000, a, doc: 1}]);
  W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.invalidate();
  W.setTool('hl'); W.prefs.hlSnap = true;
  window.__words = words;
}"""
LAST = "[...__inkwell.cur.items.values()].filter(i => i.t === 's' && i.hl).map(i => ({w: i.w, p: Array.from(i.p)}))"

async def part_hl(br):
    ctx = await br.new_context(viewport={'width': 1700, 'height': 900})
    await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
    page = await ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto(URL); await page.wait_for_timeout(3000)
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
    await page.evaluate(SETUP_HL)
    await page.wait_for_function("(() => { const el = document.querySelector('#worldBack [data-id=\"ipage\"]'); return el && el._loaded && el._img.complete; })()", timeout=10000)
    W = await page.evaluate("window.__words")
    st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
    async def stroke(pts):
        await page.mouse.move(st[0] + pts[0][0], st[1] + pts[0][1]); await page.mouse.down()
        for x, y in pts[1:]: await page.mouse.move(st[0] + x, st[1] + y, steps=4)
        await page.mouse.up(); await page.wait_for_timeout(300)
    def band(h):
        xs = h['p'][0::3]; y = h['p'][1]; r = h['w'] / 2
        return [min(xs) - r * 0.4, y - r, max(xs) + r * 0.4, y + r]
    t = W['Ereignis']; th = t[3] - t[1]; y = t[1] + th * 0.45
    await stroke([(t[0] + 2, y), ((t[0] + t[2]) / 2, y - 2), (t[2] - 2, y + 1)])
    hl = await page.evaluate(LAST)
    check(len(hl) == 1, f'one word next to a drawing: one band ({len(hl)})')
    if hl:
        bb = band(hl[-1])
        print('    word', [round(v) for v in t], 'band', [round(v) for v in bb])
        check(bb[3] - bb[1] < th * 1.7, f'band is about one line tall ({bb[3] - bb[1]:.0f} vs letters {th:.0f})')
        check(abs((bb[1] + bb[3]) / 2 - (t[1] + t[3]) / 2) < th * 0.25, 'band sits on the marked line')
        check(bb[0] > t[0] - 12 and bb[2] < t[2] + 12, f'band covers the word only ({bb[0] - t[0]:+.0f}, {bb[2] - t[2]:+.0f})')
    # a normal line away from the drawing still snaps to whole words
    t = W['Perfekt']; th = t[3] - t[1]; y = t[1] + th * 0.3
    await stroke([(t[0] + 8, y), (t[2] - 8, y - 2)])
    hl = await page.evaluate(LAST)
    bb = band(hl[-1])
    check(abs(bb[0] - t[0]) < 8 and abs(bb[2] - t[2]) < 8 and bb[3] - bb[1] < th * 1.6, f'plain word still snaps to the word ({bb[0] - t[0]:+.0f}, {bb[2] - t[2]:+.0f}, {bb[3] - bb[1]:.0f})')
    check(not errs, f'highlighter: no page errors {errs[:2]}')
    await ctx.close()

PROBE = """(pts) => { const cv = __inkwell.inkCv, g = cv.getContext('2d'), d = window.devicePixelRatio || 1, C = __inkwell.cam;
  return pts.map(([x, y]) => { const X = Math.round((x * C.z + C.ox) * d), Y = Math.round((y * C.z + C.oy) * d);
    const a = g.getImageData(X - 1, Y - 1, 3, 3).data; let m = 0; for(let i = 3; i < a.length; i += 4) m = Math.max(m, a[i]); return m; }); }"""

async def part_ink(br):
    ctx = await br.new_context(viewport={'width': 1180, 'height': 820})
    await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
    page = await ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto(URL); await page.wait_for_timeout(3000)
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
    pts = await page.evaluate("""async () => { const W = __inkwell; await W.newPage(); await new Promise(r => setTimeout(r, 300));
      W.cam.z = 1.8; W.cam.ox = 0; W.cam.oy = -66240 * 1.8;
      const its = [], pts = [];
      for(let k = 0; k < 6; k++){ const p = []; const x0 = 60 + k * 40, y0 = 66300;
        for(let i = 0; i <= 20; i++) p.push(x0 + i, y0 + 10 * Math.sin(i / 3), 0.5);
        its.push({t: 's', id: 'sprobe' + k, c: '#1f27ff', w: 2.2, hl: 0, p}); pts.push([p[30], p[31]]); }
      W.addItems(its); W.invalidate(); return pts; }""")
    await page.wait_for_timeout(800)
    a = await page.evaluate(PROBE, pts)
    check(all(v > 0 for v in a), f'strokes drawn ({a})')
    # pan around: no false alarms
    for dx in (40, -80, 40):
        await page.evaluate("dx => { __inkwell.cam.ox += dx; __inkwell.invalidate(); }", dx); await page.wait_for_timeout(600)
    h = await page.evaluate("__inkwell.InkCheck.heals")
    check(h == 0, f'no redraw needed while the ink is there ({h})')
    # the iPad drops the ink layer's picture: drawing on it does nothing for one frame (simulated)
    old = await page.evaluate("""() => { window.__oldInk = __inkwell.inkCv;
      const real = CanvasRenderingContext2D.prototype.fill; window.__skip = true;
      CanvasRenderingContext2D.prototype.fill = function(...a){ if(window.__skip && this.canvas.id === 'ink') return; return real.apply(this, a); };
      __inkwell.cam.ox -= 30; __inkwell.invalidate(); return true; }""")
    await page.wait_for_timeout(80)
    await page.evaluate("window.__skip = false")
    a = await page.evaluate(PROBE, pts)
    check(all(v == 0 for v in a), 'simulated loss: the ink layer is empty')
    await page.wait_for_timeout(900)
    a = await page.evaluate(PROBE, pts)
    r = await page.evaluate("[__inkwell.InkCheck.heals, document.getElementById('ink') !== window.__oldInk, document.querySelectorAll('#ink').length, document.getElementById('ink') === __inkwell.inkCv]")
    check(all(v > 0 for v in a), f'ink is back after the check ({a})')
    check(r[0] == 1 and r[1] and r[2] == 1 and r[3], f'ink layer replaced by one fresh canvas ({r})')
    # the new layer keeps working: draw a stroke with the mouse, it stays after lifting
    st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
    await page.evaluate("__inkwell.setTool('pen')")
    await page.mouse.move(st[0] + 500, st[1] + 300); await page.mouse.down()
    for i in range(1, 15): await page.mouse.move(st[0] + 500 + i * 6, st[1] + 300 + (i % 3) * 4)
    await page.mouse.up(); await page.wait_for_timeout(300)
    last = await page.evaluate("(() => { const s = [...__inkwell.cur.items.values()].filter(i => i.t === 's'); const p = s[s.length - 1].p; return [[p[12], p[13]]]; })()")
    a = await page.evaluate(PROBE, last)
    check(a[0] > 0, 'a new stroke is drawn on the fresh layer')
    check(await page.evaluate("getComputedStyle(document.getElementById('hlm')).mixBlendMode") == 'multiply', 'fresh highlighter layer still blends')
    # a frame step that throws does not stop the next frames from drawing the ink
    await page.evaluate("""() => { window.__thr = 1; const W = __inkwell; const o = W.cur.items.get('sprobe0');
      W.cur.items.set('sbad', {t: 's', id: 'sbad', c: '#000', w: 2, hl: 0, get p(){ if(window.__thr) throw new Error('bad stroke'); return [0,0,0.5]; }});
      W.cam.ox += 10; W.invalidate(); }""")
    await page.wait_for_timeout(200)
    a = await page.evaluate(PROBE, pts)
    check(all(v > 0 for v in a), 'a broken stroke does not stop the other strokes from being drawn')
    await page.evaluate("() => { __inkwell.cur.items.delete('sbad'); }")
    check(not [e for e in errs if 'bad stroke' not in e], f'ink: no page errors {errs[:2]}')
    await ctx.close()

async def part_sync(br):
    c, pg, errs = await device(br, 'A')
    await sync(pg)
    pid = await pg.evaluate("""async () => { const W = __inkwell; await W.newPage(); await new Promise(r => setTimeout(r, 300));
      W.addItems([{t: 's', id: 'sold', c: '#000', w: 2, hl: 0, p: [10, 10, .5, 20, 20, .5, 30, 10, .5]}]); await W.flushSaves(); return W.cur.id; }""")
    await sync(pg)
    cid = 'c_' + pid
    check(cid in STORE and not STORE[cid]['deleted'], 'page uploaded')
    # another device puts the page in Recently deleted (an older time than the edit made here afterwards)
    now_ms = await pg.evaluate("Date.now()")
    for i in (pid, cid):
        row = STORE[i]; d = dict(row['data'] or {}); d['_del'] = {'at': now_ms - 60000, 'g': pid}
        row.update(deleted=True, data=d, updated_at=now_ms - 60000, server_ts=ts())
    # ... while this device writes more on it
    await pg.evaluate("""async () => { const W = __inkwell; W.addItems([{t: 's', id: 'snew', c: '#000', w: 2, hl: 0, p: [40, 10, .5, 50, 20, .5, 60, 10, .5]}]); await W.flushSaves(); }""")
    STATE['conflicts'] = 0; STATE['rpc'] = 0
    await sync(pg)
    srv = STORE[cid]
    ids = [it['id'] for it in (srv['data'] or {}).get('items', [])]
    check(not srv['deleted'] and 'snew' in ids and 'sold' in ids, f'the newer copy here is uploaded and the page is back ({srv["deleted"]}, {ids})')
    r1 = (STATE['rpc'], STATE['conflicts'])
    STATE['conflicts'] = 0; STATE['rpc'] = 0
    await sync(pg); await sync(pg)
    check(STATE['conflicts'] == 0, f'no more refused uploads on the next syncs (first sync {r1}, then {STATE["conflicts"]} conflicts)')
    dirty = await pg.evaluate("async () => (await __inkwell.IDB.dirty()).map(d => d.id)")
    check(cid not in dirty, f'nothing left waiting to upload ({dirty})')
    check(not errs, f'sync: no page errors {errs[:2]}')
    await c.close()

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        await part_hl(br)
        await part_ink(br)
        await part_sync(br)
        await br.close()
    if fails: raise SystemExit(1)
    print('ALL OK')
asyncio.run(main())
