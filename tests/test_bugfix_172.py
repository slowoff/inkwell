# 1.72 (bug hunt 2026-10-29): each fix checked here.
# 1. Every switch and setting says what it did in a short message at the bottom (Rafael); it never hides a message
#    with a button (Undo, Reload) and sits just above one.
# 2. "Finger draws" (and "Stick to text") show the same icon at every width, and tell screen readers on/off.
# 3. Server load: the storage info was fetched again after every sync (every 20 s, also with Settings closed);
#    now only when Settings opens. The daily Google Drive picture check ran 4-5 times at once; now one at a time.
#    The Drive copy of the notes no longer reads every note each minute when nothing changed.
# 4. A change from another device that came in while the open page was being left was dropped on this device.
# 5. Redo while typing in a text box: the box is finished first (like Undo), the typed text is kept.
# 6. Ink self-check: no false "ink lost" on sharp little zigzags at high zoom (it replaced the ink layers for nothing).
# 7. Escape closes the window on top (Settings, What's new, …), also while typing in one of its fields.
import asyncio, json, re, base64, time, os
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

NOTE = "(() => { const n = document.getElementById('note'); return {shown: !n.hidden, text: n.textContent}; })()"

async def boot(b, ctx):
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(URL); await pg.wait_for_timeout(3000)
    await pg.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
    await pg.wait_for_timeout(2500)
    await pg.wait_for_function('!!(window.__inkwell && window.__inkwellBooted && window.__inkwell.cur)', timeout=15000)
    return pg, errs

async def part_local(b):
    ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
    await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
    pg, errs = await boot(b, ctx)

    # ---- 1. switches say what they did
    await pg.evaluate("__inkwell.setTool('pen')"); await pg.wait_for_timeout(150)
    was = await pg.evaluate("!!__inkwell.prefs.finger")
    await pg.click('#fingerBtn'); await pg.wait_for_timeout(100)
    n = await pg.evaluate(NOTE)
    aria = await pg.evaluate("document.getElementById('fingerBtn').getAttribute('aria-pressed')")
    check(n['shown'] and n['text'].startswith('Finger draws ' + ('off' if was else 'on')), f'Finger draws: message at the bottom ({n})')
    check(aria == ('false' if was else 'true'), f'Finger draws: aria-pressed follows the switch ({aria})')
    await pg.click('#fingerBtn'); await pg.wait_for_timeout(100)
    n = await pg.evaluate(NOTE)
    check(n['shown'] and n['text'].startswith('Finger draws ' + ('on' if was else 'off')), f'Finger draws back: message says so ({n})')
    box = await pg.evaluate("(() => { const r = document.getElementById('note').getBoundingClientRect(); return {b: innerHeight - r.bottom, h: r.height, w: r.width, cx: r.left + r.width / 2}; })()")
    check(10 <= box['b'] <= 40 and box['h'] <= 40 and abs(box['cx'] - 590) < 2, f'message is small, centred, at the bottom ({box})')
    await pg.wait_for_timeout(2100)
    check(not (await pg.evaluate(NOTE))['shown'], 'message goes away by itself after about 2 s')

    await pg.evaluate("__inkwell.setTool('hl')"); await pg.wait_for_timeout(150)
    hl = await pg.evaluate("!!__inkwell.prefs.hlSnap")
    await pg.click('#hlSnap'); await pg.wait_for_timeout(100)
    n = await pg.evaluate(NOTE)
    aria = await pg.evaluate("document.getElementById('hlSnap').getAttribute('aria-pressed')")
    check(n['text'] == 'Stick to text ' + ('off' if hl else 'on') and aria == ('false' if hl else 'true'), f'Stick to text: message and aria-pressed ({n}, {aria})')
    await pg.click('#hlSnap'); await pg.wait_for_timeout(100)

    await pg.evaluate("__inkwell.setTool('lasso')"); await pg.wait_for_timeout(150)
    await pg.click('#lassoMode [data-m="box"]'); await pg.wait_for_timeout(100)
    n = await pg.evaluate(NOTE)
    check(n['shown'] and 'box' in n['text'], f'Select mode: message ({n})')
    await pg.click('#lassoMode [data-m="free"]')
    await pg.evaluate("__inkwell.setTool('pen')")

    # a message with a button stays; the short message sits just above it; a new big message hides the short one
    r = await pg.evaluate("""async () => { toast('Page deleted', 'Undo', () => {}); note('Finger draws on');
      await new Promise(r => setTimeout(r, 250));
      const t = document.getElementById('toast'), n = document.getElementById('note');
      const a = t.getBoundingClientRect(), c = n.getBoundingClientRect();
      const out = {toast: !t.hidden, note: !n.hidden, gap: a.top - c.bottom};
      toast('Something else'); out.after = !n.hidden; t.hidden = true; return out; }""")
    check(r['toast'] and r['note'] and 0 <= r['gap'] <= 20, f'message with a button kept, short message just above it ({r})')
    check(not r['after'], f'a new big message hides the short one ({r})')

    # Settings: a change says what it did; the same choice again says nothing
    await pg.evaluate("noteHide()")
    await pg.click('#settingsBtn'); await pg.wait_for_timeout(400)
    await pg.click('#setTheme button[data-v="dark"]'); await pg.wait_for_timeout(100)
    n = await pg.evaluate(NOTE)
    check(n['shown'] and n['text'] == 'Theme: Dark', f'Settings → Theme: message ({n})')
    await pg.evaluate("noteHide()")
    await pg.click('#setTheme button[data-v="dark"]'); await pg.wait_for_timeout(100)
    check(not (await pg.evaluate(NOTE))['shown'], 'choosing the same theme again: no message')
    await pg.click('#setTheme button[data-v="auto"]'); await pg.wait_for_timeout(100)
    n = await pg.evaluate(NOTE)
    check(n['text'].startswith('Theme: Auto'), f'Theme back to Auto: message ({n})')

    # ---- 7. Escape closes the window on top
    await pg.click('#logBtn'); await pg.wait_for_timeout(300)
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150)
    r = await pg.evaluate("[document.getElementById('logDlg').hidden, document.getElementById('settingsDlg').hidden]")
    check(r == [True, False], f"Escape closes What's new first, Settings stays open ({r})")
    await pg.evaluate("(() => { const i = document.querySelector('#settingsDlg input:not([type=checkbox]):not([hidden])') || document.querySelector('#settingsDlg button'); i.focus(); })()")
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150)
    check(await pg.evaluate("document.getElementById('settingsDlg').hidden"), 'Escape closes Settings, also with focus inside it')
    await pg.keyboard.press('Escape')   # nothing open: no error

    # ---- 5. redo while typing in a text box
    r = await pg.evaluate("""async () => { const W = __inkwell; await W.newPage(); await new Promise(r => setTimeout(r, 300));
      const c = W.cam, x = (300 - c.ox) / c.z, y = (300 - c.oy) / c.z;
      W.addItems([{t: 'x', id: 'tx172', x, y, w: 300, fs: 1, html: 'one'}]);
      const it = W.cur.items.get('tx172');
      W.replaceItems([Object.assign({}, it, {html: 'two'})]);
      W.undo();
      const before = W.cur.items.get('tx172').html;
      startEditing('tx172');
      const el = elMap.get('tx172'); el.innerHTML = 'three'; el.dispatchEvent(new InputEvent('input', {bubbles: true}));   // typed
      W.redo();
      finishEditing();
      const after = W.cur.items.get('tx172').html;
      W.undo();
      const undone = W.cur.items.get('tx172').html;
      // tapped into the box without typing, then Redo: the redo shows (the box's old text used to come back over it)
      W.replaceItems([Object.assign({}, W.cur.items.get('tx172'), {html: 'four'})]); W.undo();
      startEditing('tx172'); W.redo(); finishEditing();
      const redone = W.cur.items.get('tx172').html, shown = elMap.get('tx172').textContent;
      return {before, after, undone, redone, shown}; }""")
    check(r['before'] == 'one' and 'three' in r['after'], f'redo while typing: the typed text is kept ({r})')
    check(r['undone'] == 'one', f'undo after that goes back to the text before typing ({r})')
    check(r['redone'] == 'four' and r['shown'] == 'four', f'tapped into a box, then Redo: the redone text stays ({r})')

    # ---- 6. ink self-check on sharp little zigzags at high zoom
    r = await pg.evaluate("""async () => { const W = __inkwell; await W.newPage(); await new Promise(r => setTimeout(r, 300));
      W.cam.z = 4; W.cam.ox = 0; W.cam.oy = -66240 * 4;
      const its = [], raw = [];
      for(let k = 0; k < 6; k++){ const p = [], x0 = 20 + k * 25, y0 = 66300;
        for(let i = 0; i <= 20; i++) p.push(x0 + i * 2, y0 + (i % 2 ? 2.5 : -2.5), 0.5);
        its.push({t: 's', id: 'zig' + k, c: '#1f27ff', w: 0.8, hl: 0, p}); raw.push([p[30], p[31]]); }
      const h0 = W.InkCheck.heals;
      W.addItems(its); W.invalidate();
      await new Promise(r => setTimeout(r, 1000));
      const cv = W.inkCv, g = cv.getContext('2d'), d = devicePixelRatio || 1;
      const at = ([x, y]) => { const a = g.getImageData(Math.round((x * 4 + W.cam.ox) * d) - 1, Math.round((y * 4 + W.cam.oy) * d) - 1, 3, 3).data; let m = 0; for(let i = 3; i < a.length; i += 4) m = Math.max(m, a[i]); return m; };
      const mid = its.map(it => at(shapePoint(it.p, 10)));
      return {heals: W.InkCheck.heals - h0, rawInk: raw.map(at), midInk: mid}; }""")
    check(all(v == 0 for v in r['rawInk']), f'(the raw recorded points lie beside the drawn ink: the old check looked there) {r["rawInk"]}')
    check(all(v > 0 for v in r['midInk']), f'the point the check uses now has ink {r["midInk"]}')
    check(r['heals'] == 0, f'no false "ink lost": the ink layers are not replaced ({r["heals"]})')

    check(not errs, f'no page errors {errs}')
    await ctx.close()

# ---------------------------------------------------------------- signed in, fake server
def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
UID = 'aaaaaaaa-1111-1111-1111-111111111172'
JWT = b64({'alg': 'HS256', 'typ': 'JWT'}) + '.' + b64({'sub': UID, 'exp': 4102444800, 'role': 'authenticated', 'aud': 'authenticated', 'email': 'a@gmail.com'}) + '.sig'
USER = {'id': UID, 'aud': 'authenticated', 'role': 'authenticated', 'email': 'a@gmail.com'}
SESSION = {'access_token': JWT, 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': 4102444800, 'refresh_token': 'rt-a', 'user': USER}
STORE = {}
COUNT = {'info': 0}
CLOCK = [0]
def ts():
    CLOCK[0] += 1
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(1793000000 + CLOCK[0])) + '.%06d+00:00' % CLOCK[0]
def J(route, status, obj): return route.fulfill(status=status, content_type='application/json', body=json.dumps(obj), headers={'Access-Control-Allow-Origin': '*'})

async def handler(route, request):
    u = urlparse(request.url); q = parse_qs(u.query, keep_blank_values=True); path = u.path
    if request.method == 'OPTIONS':
        return await route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
    if '/auth/v1/' in path:
        return await J(route, 200, USER if path.endswith('/user') else SESSION)
    if path.endswith('/functions/v1/files'):
        body = json.loads(request.post_data or '{}')
        if body.get('action') == 'info':
            COUNT['info'] += 1
            return await J(route, 200, {'r2': True, 'used_mb': 0, 'total_mb': 0, 'cap_mb': 9000, 'google_client_id': 'cid', 'gdrive': None})
        return await J(route, 200, {})
    if '/functions/v1/' in path: return await J(route, 404, {'error': 'nf'})
    if path.endswith('/rest/v1/rpc/docs_put'):
        body = json.loads(request.post_data or '{}'); ok = []
        for r in body.get('p_rows') or []:
            row = {k: r.get(k) for k in ('id', 'kind', 'data', 'deleted', 'updated_at')}; row['user_id'] = UID; row['server_ts'] = ts()
            STORE[r['id']] = row; ok.append({'id': r['id'], 'server_ts': row['server_ts']})
        return await J(route, 200, {'ok': ok, 'conflict': []})
    if path.endswith('/rest/v1/rpc/db_size'): return await J(route, 200, 1.5)
    if path.endswith('/rest/v1/docs') and request.method == 'GET':
        return await J(route, 200, [])
    return await route.fulfill(status=404, body='')

async def part_server(b):
    ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
    init = "if(!sessionStorage.getItem('t0')){ sessionStorage.setItem('t0','1'); localStorage.setItem('inkwell.prefs', JSON.stringify({hwSearch:false})); localStorage.setItem('inkwell-auth', %s); }" % json.dumps(json.dumps(SESSION))
    await ctx.add_init_script(init)
    await ctx.route('**/*supabase.co/**', handler)
    try: await ctx.route_web_socket(re.compile('.*supabase.*'), lambda ws: ws.close())
    except Exception: pass
    pg, errs = await boot(b, ctx)
    await pg.wait_for_function('window.__inkwell.Sync.user', timeout=15000)
    await pg.wait_for_timeout(1500)
    sync = """async () => { const S = __inkwell.Sync;
      for(let i = 0; i < 100 && (S.running || S.again); i++) await new Promise(r => setTimeout(r, 50));
      await S.run(); for(let i = 0; i < 200 && (S.running || S.again); i++) await new Promise(r => setTimeout(r, 50)); return S.state; }"""

    # ---- 3a. storage info: not after every sync
    n0 = COUNT['info']
    for _ in range(3): await pg.evaluate(sync)
    await pg.wait_for_timeout(300)
    check(COUNT['info'] == n0, f'three syncs with Settings closed: storage info not fetched again ({COUNT["info"] - n0} requests)')
    await pg.click('#settingsBtn'); await pg.wait_for_timeout(800)
    n1 = COUNT['info']
    check(n1 == n0 + 1, f'opening Settings fetches it once ({n1 - n0})')
    for _ in range(2): await pg.evaluate(sync)
    await pg.wait_for_timeout(300)
    check(COUNT['info'] == n1, f'syncs while Settings is open use the fresh copy ({COUNT["info"] - n1})')
    await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)

    # ---- 3b. Drive picture check: one at a time
    r = await pg.evaluate("""async () => { const G = __inkwell.GD, real = G.checkNow; let n = 0;
      G.checkNow = async () => { n++; await new Promise(r => setTimeout(r, 200)); return 'done'; };
      const a = G.check(), b2 = G.check(true), c = G.check();
      const same = a === b2 && b2 === c; const res = await Promise.all([a, b2, c]);
      const d = await G.check(); G.checkNow = real; return {n, same, res, d}; }""")
    check(r['n'] == 2 and r['same'] and r['res'] == ['done'] * 3 and r['d'] == 'done', f'Drive check: three at once run once, a later one runs again ({r})')

    # ---- 3c. Drive copy of the notes: nothing read when nothing changed
    r = await pg.evaluate("""async () => { const W = __inkwell, I = W.IDB, F = W.Files, G = W.GD, keep = F.info, realAll = I.all; let reads = 0;
      I.all = function(s){ if(s === 'docs') reads++; return realAll.apply(this, arguments); };
      try {
        F.info = Object.assign({}, keep, {gdrive: {folder: 'f'}});
        const d = (await realAll.call(I, 'docs')).filter(d => !d.deleted && d.data);
        const sig = d.length + ':' + d.reduce((m, x) => Math.max(m, x.updated || 0), 0) + ':' + W.Sync.user.id;
        localStorage.setItem('inkwell.gdNotes', JSON.stringify({id: 'x', uid: W.Sync.user.id, sig, saved: Date.now()}));
        await G.saveNotes(); const r1 = reads;
        await G.saveNotes(); await G.saveNotes(); const r2 = reads;
        await I.put('docs', {id: 'zz172', kind: 'tmpl', data: null, deleted: true, updated: 1, dirty: 0});
        await G.saveNotes(); const r3 = reads;
        return {r1, r2, r3};
      } finally { I.all = realAll; F.info = keep; localStorage.removeItem('inkwell.gdNotes'); await I.del('docs', 'zz172'); } }""")
    check(r['r1'] == 1 and r['r2'] == 1 and r['r3'] == 2, f'Drive copy: notes read once, not again while unchanged, again after a change ({r})')

    # ---- 4. a change from another device arriving while the open page is left
    r = await pg.evaluate("""async () => { const W = __inkwell;
      const A = W.cur.id; await W.newPage(); await new Promise(r => setTimeout(r, 300)); const B = W.cur.id;
      await W.openPage(A); await new Promise(r => setTimeout(r, 300));
      const c = W.cam, x = (400 - c.ox) / c.z, y = (300 - c.oy) / c.z;
      W.addItems([{t: 's', id: 'loc172', c: '#000', w: 2, hl: 0, p: [x, y, .5, x + 40, y + 5, .5, x + 80, y, .5]}]);   // written here, not saved yet
      const remote = {t: 's', id: 'rem172', c: '#C2362B', w: 2, hl: 0, p: [x, y + 60, .5, x + 40, y + 65, .5, x + 80, y + 60, .5]};
      const realSV = window.saveVersion;
      window.saveVersion = async (...a) => { const r = await realSV(...a); await W.openPage(B); return r; };   // the page is left meanwhile
      const row = {id: 'c_' + A, kind: 'content', data: {bg: W.cur.bg, items: [ser(remote)]}, deleted: false, updated_at: Date.now() + 5000, server_ts: '2026-10-29T10:00:00.000001+00:00'};
      let res;
      try { res = await W.mergeCurrent(row, null); } finally { window.saveVersion = realSV; }
      await W.flushSaves(); await new Promise(r => setTimeout(r, 300));
      const rec = await W.IDB.get('docs', 'c_' + A), ids = ((rec && rec.data && rec.data.items) || []).map(i => i.id);
      return {res, onB: W.cur.id === B, remote: ids.includes('rem172'), local: ids.includes('loc172')}; }""")
    check(r['onB'], f'(the page was left while the backup copy was saved) {r}')
    check(r['remote'] and r['local'], f'the change from the other device is kept on this device, with the stroke written here ({r})')

    check(not errs, f'no page errors {errs}')
    await ctx.close()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        await part_local(b)
        await part_server(b)
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
