# 1.49: Shapes popover -> "Snap strokes to shapes" switch. Off = holding the pen still at the end of a stroke
# no longer straightens it (same as Settings -> Straighten shapes Off); on again = the speed used before. Guest mode.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

LAST = """() => { const its = [...__inkwell.cur.items.values()].filter(i => i.t === 's'); const s = its[its.length - 1];
  return s ? {n: its.length, p: Array.from(s.p)} : {n: 0}; }"""

def wobble(r):
    P = r['p']; pts = [(P[i], P[i + 1]) for i in range(0, len(P), 3)]
    (ax, ay), (bx, by) = pts[0], pts[-1]
    L = math.hypot(bx - ax, by - ay) or 1
    return max(abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / L for x, y in pts)

async def wobbly_line(page, x, y):
    # a slightly wavy line, then the pen held still for 1.2 s before lifting
    await page.mouse.move(x, y); await page.mouse.down()
    for i in range(1, 61):
        await page.mouse.move(x + 5 * i, y + 4 * math.sin(i / 4))
        await page.wait_for_timeout(8)
    await page.wait_for_timeout(1200)
    await page.mouse.up(); await page.wait_for_timeout(250)

async def state(page):
    return await page.evaluate("""() => ({hold: __inkwell.prefs.snapHold, on: document.getElementById('snapShapes').classList.contains('on'),
      seg: [...document.querySelectorAll('#setHold button.on')].map(b => b.dataset.v).join(',')})""")

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
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); }"); await page.wait_for_timeout(400)
        box = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        x0, y0 = box[0] + 120, box[1] + 150

        # 1. default: switch on, a held wavy line is straightened
        await page.click('#shapeBtn'); await page.wait_for_selector('#snapShapes', state='visible')
        s = await state(page)
        check(s['on'] and s['hold'] == 550, f'switch is on by default ({s})')
        await page.click('#shapeBtn'); await page.wait_for_timeout(200)
        await page.evaluate("__inkwell.setTool('pen')")
        await wobbly_line(page, x0, y0)
        r = await page.evaluate(LAST)
        check(r['n'] == 1 and wobble(r) < 0.5, f"on: held line straightened (n {r['n']}, wobble {wobble(r):.2f})")

        # 2. switch off in the Shapes popover: same line stays as drawn
        await page.click('#shapeBtn'); await page.wait_for_selector('#snapShapes', state='visible')
        await page.click('#snapShapes'); await page.wait_for_timeout(150)
        s = await state(page)
        check(not s['on'] and s['hold'] == 0 and s['seg'] == '0', f'switch off -> snapHold 0, Settings shows Off ({s})')
        await page.click('#shapeBtn'); await page.wait_for_timeout(200)
        await page.evaluate("__inkwell.setTool('pen')")
        await wobbly_line(page, x0, y0 + 80)
        r = await page.evaluate(LAST)
        check(r['n'] == 2 and wobble(r) > 2, f"off: held line keeps its shape (n {r['n']}, wobble {wobble(r):.2f})")
        check(await page.evaluate("document.getElementById('shapePop').hidden"), 'popover closed again')

        # 3. survives a reload
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        s = await state(page)
        check(not s['on'] and s['hold'] == 0, f'off after reload ({s})')

        # 4. Settings speed is remembered: pick Fast in Settings, switch off and on again -> Fast
        await page.evaluate("document.querySelector('#setHold button[data-v=\"350\"]').click()")
        s = await state(page)
        check(s['on'] and s['hold'] == 350, f'Settings Fast turns the switch on ({s})')
        await page.evaluate("document.getElementById('snapShapes').click()")
        await page.evaluate("document.getElementById('snapShapes').click()")
        s = await state(page)
        check(s['on'] and s['hold'] == 350 and s['seg'] == '350', f'off then on brings back Fast ({s})')

        # 5. popover layout: switch visible inside the popover, full width, not overlapping the grid
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        await page.click('#shapeBtn'); await page.wait_for_selector('#snapShapes', state='visible')
        g = await page.evaluate("""() => { const p = document.getElementById('shapePop').getBoundingClientRect(), t = document.getElementById('snapShapes').getBoundingClientRect(),
          gr = document.getElementById('shapeGrid').getBoundingClientRect(); return {inside: t.left >= p.left && t.right <= p.right && t.bottom <= p.bottom, below: t.top >= gr.bottom, h: t.height}; }""")
        check(g['inside'] and g['below'] and g['h'] >= 38, f'switch sits inside the popover under the shapes ({g})')
        if os.environ.get('SNAP_SHOT'): await page.screenshot(path=os.environ['SNAP_SHOT'])

        check(not errs, f'no page errors ({errs[:2]})')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
