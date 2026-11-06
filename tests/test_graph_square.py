# (1.90.5) Rafael: the graph's grid boxes should be square, not wide. Before, every graph was 380 x 270 whatever its ranges,
# so 0..10 by 0..10 gave boxes of 38 x 27. Now one step on x is as long as one step on y: every box is square, also with
# different steps on x and y; the graph keeps about its old area, the longer side at most 570 (x size). Checked through the
# Graph window (default, both types, Large, other ranges) and on buildGraph directly.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'

# grid boxes of the graph just inserted: spacing of the vertical and of the horizontal grid lines, and the graph's size
BOXES = """() => { const its = [...__inkwell.cur.items.values()].filter(i => i.t === 's' && i.c === '#8A97A4' && !i.ga);
  const ax = [...__inkwell.cur.items.values()].filter(i => i.ga);
  const xs = [], ys = [];
  for(const i of its){ const p = i.p, n = p.length / 3; if(n < 2) continue;
    const dx = Math.abs(p[(n - 1) * 3] - p[0]), dy = Math.abs(p[(n - 1) * 3 + 1] - p[1]);
    if(dx < 0.5 && dy > 30) xs.push(p[0]); else if(dy < 0.5 && dx > 30) ys.push(p[1]); }
  // the axes stand where a grid line would be
  for(const i of ax){ if(i.ga.k === 'y') xs.push(i.p[0]); else ys.push(i.p[1]); }
  const gaps = a => { a = [...new Set(a.map(v => Math.round(v * 10) / 10))].sort((u, v) => u - v); const g = []; for(let k = 1; k < a.length; k++) g.push(a[k] - a[k - 1]); return g; };
  const gx = gaps(xs), gy = gaps(ys);
  const X = ax.find(i => i.ga.k === 'x'), Y = ax.find(i => i.ga.k === 'y');
  return {gx, gy, w: X ? X.ga.len - 22 : 0}; }"""
CLEAR = "async () => { await __inkwell.newPage(); await new Promise(r => setTimeout(r, 250)); }"

async def main():
    fails = []
    def check(cond, msg):
        print(('ok   ' if cond else 'FAIL ') + msg)
        if not cond: fails.append(msg)
    def square(d, size, label):
        g = d['gx'] + d['gy']
        ok = len(d['gx']) >= 2 and len(d['gy']) >= 2 and all(abs(v - size) < 0.6 for v in g)
        check(ok, f"{label}: every box {size:.1f} x {size:.1f} ({[round(v, 1) for v in d['gx'][:3]]} / {[round(v, 1) for v in d['gy'][:3]]})")
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        await ctx.add_init_script("if(!sessionStorage.getItem('t0')){ sessionStorage.setItem('t0','1'); localStorage.setItem('inkwell.prefs', JSON.stringify({hwSearch:false})); }")
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

        async def insert(vals=None, typ=None, size=None):
            await page.evaluate(CLEAR)
            await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_selector('#graphDlg', state='visible')
            if typ: await page.click(f'#gType button[data-v="{typ}"]')
            if size: await page.click(f'#gSize button[data-v="{size}"]')
            for k, v in (vals or {}).items(): await page.fill('#' + k, str(v))
            await page.fill('#gFn', ''); await page.check('#gGrid')
            await page.wait_for_timeout(150)
            await page.click('#gInsert'); await page.wait_for_timeout(350)
            return await page.evaluate(BOXES)

        side = (380 * 270) ** 0.5   # 320.3: the old area as a square
        d = await insert(typ='q1', size='1')
        square(d, side / 10, 'default 0..10 by 0..10')
        check(abs(d['w'] - side) < 1, f"graph about as big as before ({d['w']:.0f} wide, old 380 x 270)")
        d = await insert(typ='q4')
        square(d, side / 10, 'all four quadrants -5..5')
        d = await insert({'gX0': -10, 'gX1': 10, 'gXs': 1, 'gY0': -5, 'gY1': 5, 'gYs': 1}, typ='q4')
        u = min((380 * 270 / 200) ** 0.5, 570 / 20)
        square(d, u, 'wide range 20 by 10 steps')
        check(abs(d['w'] - 20 * u) < 1, f"twice as wide as tall ({d['w']:.0f} wide)")
        d = await insert({'gX0': 0, 'gX1': 10, 'gXs': 1, 'gY0': 0, 'gY1': 100, 'gYs': 10}, typ='q1')
        square(d, side / 10, 'steps 1 on x and 10 on y: still square boxes')
        d = await insert({'gX0': 0, 'gX1': 10, 'gXs': 1, 'gY0': 0, 'gY1': 10, 'gYs': 1}, typ='q1', size='1.4')
        square(d, side * 1.4 / 10, 'Large')
        d = await insert({'gX0': 0, 'gX1': 40, 'gXs': 1, 'gY0': 0, 'gY1': 4, 'gYs': 1}, typ='q1', size='1')
        square(d, 570 / 40, 'very wide range: longer side capped at 570')
        # the inserted graph sits inside the view
        r = await page.evaluate("""() => { const W = __inkwell, its = [...W.cur.items.values()]; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for(const i of its) if(i.t === 's') for(let k = 0; k < i.p.length; k += 3){ x0 = Math.min(x0, i.p[k]); x1 = Math.max(x1, i.p[k]); y0 = Math.min(y0, i.p[k + 1]); y1 = Math.max(y1, i.p[k + 1]); }
          const c = W.cam, st = document.getElementById('stage').getBoundingClientRect();
          return [x0 * c.z + c.ox, y0 * c.z + c.oy, x1 * c.z + c.ox, y1 * c.z + c.oy, st.width, st.height]; }""")
        check(r[0] >= 0 and r[1] >= 0 and r[2] <= r[4] and r[3] <= r[5], f'inserted graph fits in the view ({[round(v) for v in r]})')
        # 3D graphs are unchanged
        await page.evaluate(CLEAR)
        n = await page.evaluate("() => __inkwell.buildGraph({type: '3d', lx: 'x', ly: 'y', lz: 'z', look: {}}, 0, 0).length")
        check(n > 10, f'3D graph still builds ({n} items)')
        # odd steps fall back to the old size instead of failing
        w = await page.evaluate("() => { const it = __inkwell.buildGraph({type: 'q1', x0: 0, x1: 10, xs: 0, y0: 0, y1: 10, ys: 1, grid: true, look: {}}, 0, 0).find(i => i.ga && i.ga.k === 'x'); return it.ga.len - 22; }")
        check(abs(w - 380) < 1, f'a step of 0 keeps the old 380 width ({w})')
        check(not errs, f'no page errors ({errs})')
        await b.close()
    print('ALL PASSED' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
