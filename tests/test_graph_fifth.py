# 1.78.2: Shapes graphs: every fifth tick and grid line is longer.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
B = """o => { const its = __inkwell.buildGraph(Object.assign({type: 'q1', lx: 'x', ly: 'y', look: {}}, o), 100, 100);
  const box = i => { let a = 1e9, b = -1e9, c = 1e9, d = -1e9; for(let k = 0; k < i.p.length; k += 3){ a = Math.min(a, i.p[k]); b = Math.max(b, i.p[k]); c = Math.min(c, i.p[k+1]); d = Math.max(d, i.p[k+1]); } return [b - a, d - c]; };
  const s = its.filter(i => i.t === 's' && !i.fl);
  const grid = s.filter(i => i.c === '#8A97A4').map(box), tick = s.filter(i => i.c !== '#8A97A4').map(box);
  return {v: grid.filter(q => q[0] < 1).map(q => Math.round(q[1])), tv: tick.filter(q => q[0] < 1 && q[1] < 30).map(q => Math.round(q[1])), edge: its.filter(i => i.t === 'm').map(i => i.tex).filter(t => t === '10').length, widths: new Set(s.filter(i => i.c === '#8A97A4').map(i => i.w)).size}; }"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }")
        G = dict(x0=0, x1=20, xs=1, y0=0, y1=20, ys=1, nums=True, grid=True)
        d = await page.evaluate(B, G)
        vals = sorted(set(d['v']))
        check(len(vals) == 2 and vals[1] - vals[0] >= 14 and d['v'].count(vals[1]) == 4, f'grid: 5, 10, 15, 20 stick out ({vals}, {d["v"].count(vals[-1])})')
        t = sorted(set(d['tv']))
        check(len(t) == 2 and d['tv'].count(t[1]) == 4, f'ticks: every fifth longer ({t}, {d["tv"].count(t[-1])})')
        check(d['edge'] == 2 and d['widths'] == 1, f'numbers only on the axes, one line weight (reverted 1.78.1) ({d["edge"]}, {d["widths"]})')
        d = await page.evaluate(B, {**G, 'x0': -10, 'x1': 10, 'y0': -10, 'y1': 10})
        check(d['v'].count(max(d['v'])) == 4, 'counted from 0 on negative numbers too (-10, -5, 5, 10)')
        N = "o => __inkwell.buildGraph(Object.assign({type: 'q4', lx: 'x', ly: 'y', look: {}}, o), 100, 100).filter(i => i.t === 'm').map(i => i.tex)"
        n = await page.evaluate(N, dict(x0=-30, x1=30, xs=1, y0=-30, y1=30, ys=1, nums=True))
        nums = [int(t) for t in n if t.lstrip('-').isdigit()]
        check(nums and all(v % 5 == 0 for v in nums) and len(set(nums)) >= 11, f'big graph: numbers on the fifth lines ({sorted(set(nums))})')
        n = await page.evaluate(N, dict(x0=0, x1=10, xs=1, y0=0, y1=10, ys=1, nums=True))
        check(all(str(v) in n for v in range(1, 11)), f'small graph: every line keeps its number ({n})')
        n = await page.evaluate(N, dict(x0=-100, x1=100, xs=1, y0=-100, y1=100, ys=1, nums=True))
        nums = [int(t) for t in n if t.lstrip('-').isdigit()]
        check(all(v % 15 == 0 for v in nums), f'huge graph: numbers still on long lines ({sorted(set(nums))})')
        await page.evaluate("o => __inkwell.addItems(__inkwell.buildGraph(Object.assign({type: 'q1', lx: 'x', ly: 'y', look: {gridO: 50, bg: true}}, o), 100, 100))", G)
        await page.evaluate("() => { const W = __inkwell; W.cam.z = 1.5; W.cam.ox = -20; W.cam.oy = -20; W.invalidate(); }"); await page.wait_for_timeout(600)
        if os.environ.get('GSHOT'): await page.screenshot(path=os.environ['GSHOT'])
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
