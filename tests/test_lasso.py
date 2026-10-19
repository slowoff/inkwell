# 1.41.1: a lasso loop around writing on an imported page selects the writing, not the whole page picture.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SETUP = """() => { const W = __inkwell, c = W.cam;
  const toW = (x, y) => [(x - c.ox) / c.z, (y - c.oy) / c.z];
  const [x0, y0] = toW(60, 40), [x1, y1] = toW(600, 520);
  const [sx, sy] = toW(300, 250), p = [];
  for(let k = 0; k <= 20; k++) p.push(sx + k * 3 / c.z, sy + Math.sin(k / 3) * 10 / c.z, 0.5);
  const [tx, ty] = toW(300, 330);
  W.addItems([{t: 'i', id: 'imgPage', x: x0, y: y0, w: x1 - x0, h: y1 - y0, a: 'none', doc: 1},
              {t: 's', id: 'ink1', c: 'auto', w: 2, hl: 0, p},
              {t: 'x', id: 'txt1', x: tx, y: ty, w: 60 / c.z, fs: 1, html: '<p>hi</p>'}]);
}"""

async def loop(page, box, cx, cy, rx, ry):
    await page.mouse.move(box[0] + cx + rx, box[1] + cy); await page.mouse.down()
    for k in range(1, 41):
        a = 2 * math.pi * k / 40
        await page.mouse.move(box[0] + cx + rx * math.cos(a), box[1] + cy + ry * math.sin(a))
    await page.mouse.up(); await page.wait_for_timeout(250)
    return await page.evaluate("() => (__inkwell.sel ? __inkwell.sel.ids.slice().sort() : [])")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await page.evaluate(SETUP); await page.wait_for_timeout(200)
        await page.evaluate("() => __inkwell.setTool('lasso')")
        box = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")

        s = await loop(page, box, 330, 250, 70, 40)
        check(s == ['ink1'], f'loop around writing in the middle of an imported page selects only the writing ({s})')
        s = await loop(page, box, 330, 300, 100, 90)
        check(s == ['ink1', 'txt1'], f'loop around writing and a text box selects both, not the page ({s})')
        s = await loop(page, box, 330, 280, 320, 270)
        check('imgPage' in s, f'loop around the whole page still selects the page ({s})')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
