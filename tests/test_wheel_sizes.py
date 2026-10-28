# 1.69: Pencil menu sizes. Holding a size (Thin / Medium / Thick) for 1.5 s puts the size set on the thickness slider
# into that place, for the current tool only; a quick tap still just picks the size; remembered after reload.
# Both ways of using the menu: Pencil held down since opening (slide onto the size and keep still), and a tap/press
# on the open menu.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SIZES = "(() => [...document.querySelectorAll('#wheel .wh-seg[data-w=\"s\"]')].map(b => +b.dataset.v))()"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); }"); await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        cdp = await ctx.new_cdp_session(page)
        async def pen(t, x, y):
            await cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': st[0] + x, 'y': st[1] + y, 'button': 'left', 'buttons': 1 if t != 'mouseReleased' else 0, 'clickCount': 1, 'pointerType': 'pen', 'force': 0.5})
        async def seg_center(slot):
            return await page.evaluate("""slot => { const g = document.querySelector(`#wheel .wh-seg[data-w="s"][data-slot="${slot}"]`);
              const ic = document.querySelector(`#wheel .wh-i[data-i="${g.dataset.i}"]`).getBoundingClientRect(); return [ic.left + ic.width / 2, ic.top + ic.height / 2]; }""", slot)
        async def set_slider(v):
            await page.evaluate("v => { const s = document.getElementById('size'); s.value = v; s.dispatchEvent(new Event('input')); }", v)
        wheel = lambda: page.evaluate("!document.getElementById('wheel').hidden")

        # 1. Pencil held down: hold still -> menu, slide onto Thick, keep still 1.8 s -> Thick = slider size
        await set_slider(23)
        x0, y0 = 600, 450
        await pen('mousePressed', x0, y0)
        for k in range(14):
            await page.wait_for_timeout(45); await pen('mouseMoved', x0 + (0.5 if k % 2 else -0.5), y0)
        check(await wheel(), 'Pencil menu opens on hold')
        check(await page.evaluate(SIZES) == [15, 40, 75], f'default sizes {await page.evaluate(SIZES)}')
        tx, ty = await seg_center(2)
        for k in range(1, 9): await pen('mouseMoved', x0 + (tx - st[0] - x0) * k / 8, y0 + (ty - st[1] - y0) * k / 8)
        await page.wait_for_timeout(1000)
        mid = await page.evaluate("__inkwell.prefs.wheelSizes")
        ring = await page.evaluate("!!document.querySelector('#wheel .wh-i.hold')")
        check(not mid and ring, f'after 1 s nothing saved yet, ring filling ({mid}, {ring})')
        await page.wait_for_timeout(800)
        r = await page.evaluate("[__inkwell.prefs.wheelSizes, document.getElementById('whLabel').textContent, !document.getElementById('wheel').hidden]")
        check(r[0] == {'pen': [15, 40, 23]}, f'Thick of the pen is now 23 ({r[0]})')
        check(r[1] == 'Thick is now 23' and r[2], f'menu stays open and says so ({r[1]!r})')
        check(await page.evaluate(SIZES) == [15, 40, 23], 'menu shows the new size')
        await page.wait_for_timeout(1700)
        check(await page.evaluate("__inkwell.prefs.wheelSizes.pen") == [15, 40, 23], 'no second save while still held')
        await pen('mouseReleased', tx - st[0], ty - st[1]); await page.wait_for_timeout(200)
        check(not await wheel() and await page.evaluate("__inkwell.prefs.pen.s") == 23, 'lifting picks it and closes the menu')
        n = await page.evaluate("[...__inkwell.cur.items.values()].length")
        check(n == 0, f'nothing drawn ({n})')

        # 2. open menu, quick tap on Thin: picks 15, nothing saved
        await page.evaluate("p => __inkwell.openWheel(p[0], p[1])", [st[0] + x0, st[1] + y0]); await page.wait_for_timeout(250)
        tx, ty = await seg_center(0)
        await page.mouse.click(tx, ty); await page.wait_for_timeout(200)
        r = await page.evaluate("[__inkwell.prefs.pen.s, __inkwell.prefs.wheelSizes.pen]")
        check(r == [15, [15, 40, 23]], f'quick tap picks Thin, saves nothing ({r})')

        # 3. press and hold 1 s on Medium then let go: too short, Medium picked, not changed
        await set_slider(31)
        await page.evaluate("p => __inkwell.openWheel(p[0], p[1])", [st[0] + x0, st[1] + y0]); await page.wait_for_timeout(250)
        tx, ty = await seg_center(1)
        await page.mouse.move(tx, ty); await page.mouse.down(); await page.wait_for_timeout(1000); await page.mouse.up(); await page.wait_for_timeout(200)
        r = await page.evaluate("[__inkwell.prefs.pen.s, __inkwell.prefs.wheelSizes.pen]")
        check(r == [40, [15, 40, 23]], f'held 1 s: Medium picked, not replaced ({r})')

        # 4. press and hold 1.8 s on Medium (menu tapped open): Medium becomes the slider size
        await set_slider(31)
        await page.evaluate("p => __inkwell.openWheel(p[0], p[1])", [st[0] + x0, st[1] + y0]); await page.wait_for_timeout(250)
        tx, ty = await seg_center(1)
        await page.mouse.move(tx, ty); await page.mouse.down(); await page.wait_for_timeout(1800)
        r = await page.evaluate("[__inkwell.prefs.wheelSizes.pen, !document.getElementById('wheel').hidden]")
        check(r == [[15, 31, 23], True], f'finger/mouse hold saves too ({r})')
        await page.mouse.up(); await page.wait_for_timeout(200)
        check(not await wheel() and await page.evaluate("__inkwell.prefs.pen.s") == 31, 'lifting closes the menu with that size')

        # 5. other tools keep their own sizes
        await page.evaluate("__inkwell.setTool('hl')")
        await page.evaluate("p => __inkwell.openWheel(p[0], p[1])", [st[0] + x0, st[1] + y0]); await page.wait_for_timeout(250)
        check(await page.evaluate(SIZES) == [15, 40, 75], 'highlighter keeps its own sizes')
        await page.evaluate("__inkwell.closeWheel()")

        # 6. remembered after reload; junk falls back
        await page.evaluate("__inkwell.flushSaves()"); await page.wait_for_timeout(400)
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("__inkwell.setTool('pen')")
        await page.evaluate("p => __inkwell.openWheel(p[0], p[1])", [st[0] + x0, st[1] + y0]); await page.wait_for_timeout(250)
        check(await page.evaluate(SIZES) == [15, 31, 23], f'kept after reload ({await page.evaluate(SIZES)})')
        await page.evaluate("__inkwell.closeWheel(); __inkwell.prefs.wheelSizes.pen = ['x', 500, 7]")
        await page.evaluate("p => __inkwell.openWheel(p[0], p[1])", [st[0] + x0, st[1] + y0]); await page.wait_for_timeout(250)
        check(await page.evaluate(SIZES) == [15, 40, 7], f'bad stored sizes fall back ({await page.evaluate(SIZES)})')
        check(not errs, 'no page errors: ' + '; '.join(errs[:3]))
        await b.close()
    if fails: raise SystemExit(1)
    print('ALL OK')
asyncio.run(main())
