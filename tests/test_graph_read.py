# 1.78.1: Shapes graphs: numbers also on the top and right edge with grid lines; numbered grid lines stronger when some have none.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
B = """o => { const its = __inkwell.buildGraph(Object.assign({type: 'q1', lx: 'x', ly: 'y', look: {}}, o), 100, 100);
  const nums = its.filter(i => i.t === 'm').map(i => i.tex), grid = its.filter(i => i.t === 's' && i.c === '#8A97A4');
  return {nums, n: its.length, widths: [...new Set(grid.map(i => +i.w.toFixed(3)))], grid: grid.length}; }"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }")
        small = dict(x0=0, x1=10, xs=1, y0=0, y1=10, ys=1, nums=True, grid=True)
        big = dict(x0=-50, x1=50, xs=2, y0=-50, y1=50, ys=2, nums=True, grid=True)
        d = await page.evaluate(B, small)
        check(d['nums'].count('5') == 4 and len(d['widths']) == 1, f'every line numbered: numbers on 4 sides, one line weight ({d["nums"].count("5")}, {d["widths"]})')
        d = await page.evaluate(B, {**small, 'grid': False})
        check(d['nums'].count('5') == 2, 'no grid: numbers only on the axes')
        d = await page.evaluate(B, big)
        check(len(d['widths']) == 2, f'big graph: two line weights ({d["widths"]})')
        d = await page.evaluate(B, {**big, 'nums': False})
        check(len(d['widths']) == 1, 'no numbers: one line weight')
        await page.evaluate("o => __inkwell.addItems(__inkwell.buildGraph(Object.assign({type: 'q4', lx: 'x', ly: 'y', look: {gridO: 50, bg: true}}, o), 100, 100))", big)
        await page.evaluate("() => { const W = __inkwell; W.cam.z = 1.6; W.cam.ox = -60; W.cam.oy = -60; W.invalidate(); }"); await page.wait_for_timeout(600)
        if os.environ.get('GSHOT'): await page.screenshot(path=os.environ['GSHOT'])
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
