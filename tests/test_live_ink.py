# 1.61: the stroke being written.
# (1) Long strokes are drawn in pieces (only the end is rebuilt each frame). The pieces must look exactly like the
#     whole stroke drawn at once: same pixels, no seams, also for the highlighter and at another zoom.
# (2) Fewer full rebuilds: a long stroke rebuilds far fewer points per frame than it has.
# (3) Drawing ahead of the Pencil: the lead follows a straight fast line, never on a turn or when slowing,
#     disappears when the Pencil stops, and is never stored (the saved stroke ends where the pen lifted).
# (4) Writing with the mouse still makes the same strokes as before (points stored unchanged).
import asyncio, os, json
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

COMPARE = """async ([n, hl, z, wave]) => {
  const W = __inkwell, L = W.Live;
  const cam = W.cam, keep = {...cam};
  cam.z = z; cam.ox = 40; cam.oy = 30;
  const cv = document.getElementById('live'), ctx = cv.getContext('2d');
  const pts = [];
  for(let i = 0; i < n; i++){
    const t = i / 6;
    pts.push(60 + i * 1.1 + (wave ? 14 * Math.cos(t) : 0), 200 + (wave ? 24 * Math.sin(t * 1.7) : 0) + (i % 7) * 0.15, 0.35 + 0.4 * Math.abs(Math.sin(t / 3)));
  }
  const a = {id: 'cmp' + n + hl + z, kind: 'stroke', c: '#000000', w: 2.6, hl: hl ? 1 : 0, pts: [], tool: hl ? 'hl' : 'pen'};
  let rebuilt = 0;
  const shape = W.strokeShape;
  // grow the stroke a few points at a time like real writing, drawing each frame
  for(let i = 0; i < n; i++){
    a.pts.push(pts[i*3], pts[i*3+1], pts[i*3+2]);
    if(i % 3 === 2 || i === n - 1){
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
      L.draw(a, '#000000');
    }
  }
  const got = ctx.getImageData(0, 0, cv.width, cv.height).data;
  // the whole stroke at once
  const ref = document.createElement('canvas'); ref.width = cv.width; ref.height = cv.height;
  const rc = ref.getContext('2d'), dpr = cv.width / cv.clientWidth;
  rc.setTransform(dpr * z, 0, 0, dpr * z, dpr * 40, dpr * 30); rc.fillStyle = '#000000';
  rc.fill(W.strokePath({t: 's', c: '#000', w: 2.6, hl: hl ? 1 : 0, p: pts}, false));
  const want = rc.getImageData(0, 0, ref.width, ref.height).data;
  let diff = 0, big = 0, ink = 0, maxd = 0, gap = 0, soft = 0;
  for(let i = 3; i < got.length; i += 4){
    const d = Math.abs(got[i] - want[i]);
    if(want[i] === 255 && got[i] < 180) gap++;   // ink clearly missing inside the stroke (a seam or a hole)
    if(want[i] === 255 && got[i] < 250) soft++;  // a little lighter: two edges crossing on one pixel (canvas antialiasing)
    if(want[i] > 0 || got[i] > 0) ink++;
    if(d > 0){ diff++; if(d > maxd) maxd = d; }
    if(d > 60) big++;
  }
  Object.assign(cam, keep);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    // the shape itself: every piece must be the same as in the whole stroke
  const full = shape({w: 2.6, hl: hl ? 1 : 0, p: pts});
  let geo = 0;
  for(const [A0, B0] of [[0, Math.floor(n / 3)], [Math.floor(n / 3), Math.floor(2 * n / 3)], [Math.floor(2 * n / 3), n - 1]]){
    const {sh, w0} = L.win({w: 2.6, hl: hl ? 1 : 0, pts}, A0, Math.min(B0, n - 1 - 7));
    const s0 = sh.at[A0 - w0], s1 = sh.at[Math.min(B0, n - 1 - 7) - w0], f0 = full.at[A0];
    for(let k = s0; k <= s1; k++) geo = Math.max(geo, Math.hypot(sh.xs[k] - full.xs[f0 + k - s0], sh.ys[k] - full.ys[f0 + k - s0]) + Math.abs(sh.rs[k] - full.rs[f0 + k - s0]));
  }
  return {ink, diff, big, maxd, gap, soft, geo, baked: L.upto};
}"""

COST = """async () => {
  const W = __inkwell, L = W.Live;
  const a = {id: 'cost', kind: 'stroke', c: '#000', w: 2.2, hl: 0, pts: [], tool: 'pen'};
  let total = 0, frames = 0;
  // count how many points strokeShape is asked to work on per frame
  const orig = L.win.bind(L);
  L.win = (aa, f, t, e) => { const r = orig(aa, f, t, e); total += r.sh.n; return r; };
  for(let i = 0; i < 1200; i++){
    a.pts.push(100 + i, 300 + 10 * Math.sin(i / 9), 0.5);
    if(i % 3 === 2){ frames++; L.draw(a, '#000'); }
  }
  L.win = orig;
  const full = W.strokeShape({w: 2.2, hl: 0, p: a.pts}).n;
  return {perFrame: total / frames, full};
}"""

PRED = """async () => {
  const W = __inkwell, L = W.Live;
  const out = {};
  const mk = () => ({id: 'p' + Math.random(), kind: 'stroke', c: '#000', w: 2, hl: 0, pts: [], tool: 'pen'});
  const ev = (t, type) => ({pointerType: type || 'pen', timeStamp: t, clientX: 0, clientY: 0});
  const SR = document.getElementById('stage').getBoundingClientRect();
  const run = (path, type) => {   // path: [[sx, sy, t], ...] in stage px
    const a = mk();
    for(const [x, y, t] of path){ a.pts.push(...W.toWorld ? W.toWorld(x, y) : [x, y], 0.5); L.predict(a, ev(t, type), x, y); }
    return a;
  };
  const toScreen = p => [p[0] * W.cam.z + W.cam.ox, p[1] * W.cam.z + W.cam.oy];
  // straight fast line to the right: 1 px/ms
  let path = []; for(let i = 0; i < 12; i++) path.push([100 + i * 8, 300, 1000 + i * 8]);
  let a = run(path);
  out.straight = a.pred ? toScreen(a.pred).map(v => +v.toFixed(1)) : null;
  // a sharp turn at the end
  path = []; for(let i = 0; i < 8; i++) path.push([100 + i * 8, 300, 2000 + i * 8]);
  for(let i = 1; i <= 3; i++) path.push([156, 300 + i * 8, 2056 + i * 8]);
  a = run(path); out.turn = !!a.pred;
  // slowing to a stop
  path = []; let x = 100; for(let i = 0; i < 10; i++){ x += Math.max(0.2, 8 - i * 1.2); path.push([x, 300, 3000 + i * 8]); }
  a = run(path); out.slow = !!a.pred;
  // mouse: never
  path = []; for(let i = 0; i < 12; i++) path.push([100 + i * 8, 300, 4000 + i * 8]);
  a = run(path, 'mouse'); out.mouse = !!a.pred;
  // very fast: capped
  path = []; for(let i = 0; i < 12; i++) path.push([100 + i * 40, 300, 5000 + i * 8]);
  a = run(path); out.fastLead = a.pred ? +(toScreen(a.pred)[0] - (100 + 11 * 40)).toFixed(1) : null;
  // (1.61.2) on a curve the lead follows the curve (1.61 went straight on, up to ~9 px off it)
  let worst = 0, on = 0;
  for(const [R, v] of [[25, 1.2], [40, 1.5], [80, 1.5]]){
    const b = mk(); let ang = 0;
    for(let k = 0; k < 40; k++){
      ang += v * 8 / R;
      const x = 300 + R * Math.cos(ang), y = 300 + R * Math.sin(ang);
      b.pts.push(...W.toWorld(x, y), .5); L.predict(b, ev(6000 + R * 100 + k * 8), x, y);
      if(k > 5 && b.pred){ on++; const q = toScreen(b.pred); worst = Math.max(worst, Math.abs(Math.hypot(q[0] - 300, q[1] - 300) - R)); }
    }
  }
  out.curveOff = +worst.toFixed(2); out.curveOn = on;
  return out;
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, device_scale_factor=2)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.Live', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(500)

        # (1) pieces = whole stroke
        for n, hl, z, wave, name in [(400, 0, 1, True, 'pen, wavy, 400 points'), (900, 0, 2.5, True, 'pen, zoomed 250 %, 900 points'),
                                     (500, 1, 1, False, 'highlighter, 500 points'), (130, 0, 0.6, True, 'pen just over the limit, zoomed out')]:
            r = await page.evaluate(COMPARE, [n, hl, z, wave])
            check(r['baked'] > 0, f'{name}: drawn in pieces (baked up to point {r["baked"]})')
            check(r['geo'] < 1e-9, f'{name}: every piece has exactly the shape of the whole stroke (largest difference {r["geo"]})')
            share = r['diff'] / max(1, r['ink'])
            check(r['gap'] == 0 and r['soft'] <= max(3, r['ink'] * 0.002), f'{name}: no seams or holes inside the stroke ({r["gap"]} missing, {r["soft"]} single pixels a little lighter)')
            # (1.61.1) a stroke that folds anywhere is filled as overlapping pieces; the preview's earlier parts may still
            # use the plain outline, which differs only by antialiasing on the outer edge (missing ink is checked above)
            check(r['maxd'] <= 110 and share < 0.08, f'{name}: outer edge as smooth as the whole stroke ({r["diff"]} of {r["ink"]} edge pixels slightly different, largest step {r["maxd"]}/255)')

        # (2) work per frame
        r = await page.evaluate(COST)
        check(r['perFrame'] < r['full'] * 0.25, f'long stroke: about {r["perFrame"]:.0f} of {r["full"]} shape points rebuilt per frame on average')

        # (3) lead
        await page.evaluate("() => { __inkwell.toWorld = (x, y) => [(x - __inkwell.cam.ox) / __inkwell.cam.z, (y - __inkwell.cam.oy) / __inkwell.cam.z]; }")
        r = await page.evaluate(PRED)
        st = r['straight']
        check(st is not None and 100 + 11 * 8 + 4 < st[0] <= 100 + 11 * 8 + 12.1 and abs(st[1] - 300) < 0.5, f'fast straight line: the preview runs a few px ahead ({st})')
        check(not r['turn'], 'no lead on a sharp turn')
        check(r['curveOn'] > 50 and r['curveOff'] < 1.0, f'on a curve the lead follows the curve (at most {r["curveOff"]} px off, on {r["curveOn"]} times)')
        check(not r['slow'], 'no lead while slowing to a stop')
        check(not r['mouse'], 'no lead for the mouse')
        check(r['fastLead'] is not None and r['fastLead'] <= 12.1, f'lead capped at 12 px ({r["fastLead"]})')

        # the lead disappears by itself when the Pencil stops (no more move events)
        r = await page.evaluate("""async () => { const W = __inkwell, L = W.Live;
          const a = {id: 'stop', kind: 'stroke', c: '#000', w: 2, hl: 0, tool: 'pen', pts: [], pred: [500, 300, .5], predAt: performance.now()};
          for(let i = 0; i < 20; i++) a.pts.push(300 + i * 8, 300, .5);
          const cv = document.getElementById('live'), c = cv.getContext('2d'), dpr = cv.width / cv.clientWidth, z = W.cam.z;
          const px = x => Math.round((x * z + W.cam.ox) * dpr), py = Math.round((300 * z + W.cam.oy) * dpr);
          const at = x => c.getImageData(px(x), py, 1, 1).data[3];
          c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,cv.width,cv.height); L.draw(a, '#000'); const early = at(470);
          await new Promise(r => setTimeout(r, 80));
          c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,cv.width,cv.height); L.draw(a, '#000'); const late = at(470), body = at(400);
          c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,cv.width,cv.height);
          return {early, late, body}; }""")
        check(r['early'] > 100 and r['late'] == 0 and r['body'] > 100, f'the lead shows, then goes away when the Pencil stops ({r})')

        # (4) real writing with the mouse (ordinary pointer events): stored points as drawn, nothing extra
        await page.evaluate("() => { delete __inkwell.toWorld; __inkwell.setTool('pen'); }")
        box = await page.evaluate("() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.x, r.y]; }")
        n0 = await page.evaluate("() => __inkwell.cur.items.size")
        await page.mouse.move(box[0] + 200, box[1] + 300); await page.mouse.down()
        for i in range(1, 260):
            await page.mouse.move(box[0] + 200 + i * 2.5, box[1] + 300 + 20 * ((i // 20) % 2), steps=1)
        await page.mouse.up(); await page.wait_for_timeout(400)
        r = await page.evaluate("""() => { const W = __inkwell, its = [...W.cur.items.values()].filter(i => i.t === 's');
          const s = its[its.length - 1]; let xmax = -1e9; for(let i = 0; i < s.p.length; i += 3) xmax = Math.max(xmax, s.p[i]);
          const live = document.getElementById('live'); return {n: W.cur.items.size, pts: s.p.length / 3, xmax, op: live.style.opacity}; }""")
        x_end = await page.evaluate(f"() => ({box[0]} + 200 + 259 * 2.5 - __inkwell.cam.ox - document.getElementById('stage').getBoundingClientRect().x) / __inkwell.cam.z")
        check(r['n'] == n0 + 1 and r['pts'] > 150, f'a long mouse stroke is saved as one stroke ({r["pts"]} points)')
        check(r['xmax'] <= x_end + 0.5, f'the saved stroke ends where the pen lifted (x {r["xmax"]:.1f}, pen at {x_end:.1f})')
        check(r['op'] == '', 'live layer back to normal after the stroke')

        # highlighter: see-through while drawing, normal afterwards
        await page.evaluate("() => __inkwell.setTool('hl')")
        await page.mouse.move(box[0] + 200, box[1] + 420); await page.mouse.down()
        for i in range(1, 40): await page.mouse.move(box[0] + 200 + i * 4, box[1] + 420)
        op = await page.evaluate("() => document.getElementById('live').style.opacity")
        await page.mouse.up(); await page.wait_for_timeout(300)
        op2 = await page.evaluate("() => document.getElementById('live').style.opacity")
        check(op in ('0.4', '0.34') and op2 == '', f'highlighter preview is see-through while drawing ({op}), normal after ({op2!r})')

        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
