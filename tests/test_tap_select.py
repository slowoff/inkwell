# 1.63 (Rafael: "on the select tool add a third option ... that allows me to tap something to select it").
# Select tool: Free | Box | Tap. In Tap mode a tap (Pencil/mouse or finger) adds what is under it to the selection,
# a tap on a selected thing drops it, a tap on empty space clears; a loop still selects. Also: a tap on writing over
# an imported page selects the writing, not the page (all modes).
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SETUP = """async () => {
  const W = __inkwell;
  await W.newPage(); await new Promise(r => setTimeout(r, 300));
  W.cam.ox = 0; W.cam.oy = 0; W.cam.z = 1; W.invalidate();
  const line = (id, x0, y0, x1, g) => { const p = []; for(let x = x0; x <= x1; x += 6) p.push(x, y0, .5); const s = {t: 's', id, c: '#000', w: 3, hl: 0, p}; if(g) s.g = g; return s; };
  // an imported page (picture) at 0..300 x 400..600 with a stroke written on it
  const c = document.createElement('canvas'); c.width = 300; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 200);
  const a = await W.saveAsset(await new Promise(r => c.toBlob(r, 'image/png')));
  W.addItems([{t: 'i', id: 'pg', x: 0, y: 400, w: 300, h: 200, a, doc: 1}]);
  W.addItems([line('A', 50, 100, 200), line('B', 50, 200, 200), line('G1', 400, 100, 520, 'grp'), line('G2', 400, 160, 520, 'grp'), line('onpage', 60, 500, 240)]);
  W.addItems([{t: 'x', id: 'T', x: 400, y: 340, w: 200, fs: 1, html: '<p>typed text</p>'}]);
  await new Promise(r => setTimeout(r, 800));
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('!!(window.__inkwell && window.__inkwell.cur)', timeout=15000)
        await page.evaluate(SETUP)
        cdp = await ctx.new_cdp_session(page)
        st = await page.evaluate("() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.x, r.y]; }")
        sel = lambda: page.evaluate("() => __inkwell.sel ? __inkwell.sel.ids.slice().sort() : []")
        async def click(x, y):
            await page.mouse.click(st[0] + x, st[1] + y); await page.wait_for_timeout(250)
        async def pen(x, y):
            for t in ('mousePressed', 'mouseReleased'):
                await cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': st[0] + x, 'y': st[1] + y, 'button': 'left', 'clickCount': 1, 'pointerType': 'pen'})
            await page.wait_for_timeout(250)
        async def finger(x, y):
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': st[0] + x, 'y': st[1] + y}]})
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            await page.wait_for_timeout(350)

        await page.evaluate("() => __inkwell.setTool('lasso')")
        btns = await page.evaluate("() => [...document.querySelectorAll('#lassoMode button')].map(b => b.textContent)")
        check(btns == ['Free', 'Box', 'Tap'], f'Select tool shows Free | Box | Tap ({btns})')

        # Free mode (unchanged): a finger tap does not select (fingers move the page)
        await finger(120, 100)
        check(await sel() == [], 'Free: a finger tap does not select (as before)')
        # all modes: a Pencil tap on writing over an imported page selects the writing, not the page
        await pen(150, 500)
        check(await sel() == ['onpage'], f'tap on writing over an imported page selects the writing ({await sel()})')
        await click(330, 330)

        await page.click('#lassoMode [data-m="tap"]'); await page.wait_for_timeout(200)
        on = await page.evaluate("() => [...document.querySelectorAll('#lassoMode button.on')].map(b => b.dataset.m)")
        check(on == ['tap'] and await page.evaluate("() => __inkwell.prefs.lassoMode") == 'tap', f'Tap chosen ({on})')

        await pen(120, 100)
        check(await sel() == ['A'], f'Tap: Pencil tap selects a stroke ({await sel()})')
        await pen(120, 200)
        check(await sel() == ['A', 'B'], f'Tap: another tap adds it ({await sel()})')
        await pen(120, 100)
        check(await sel() == ['B'], f'Tap: tapping a selected stroke drops it ({await sel()})')
        await finger(450, 100)
        check(await sel() == ['B', 'G1', 'G2'], f'Tap: a finger tap selects too, a group comes whole ({await sel()})')
        await click(480, 348)
        check('T' in await sel(), f'Tap: typed text box can be added ({await sel()})')
        await pen(150, 560)
        check('pg' in await sel() and 'onpage' not in await sel(), f'Tap: tapping the imported page away from the writing adds the page ({await sel()})')
        await finger(330, 330)
        check(await sel() == [], f'Tap: a tap on empty space clears ({await sel()})')
        await finger(150, 500)
        check(await sel() == ['onpage'], f'Tap: finger tap on writing over the page picks the writing ({await sel()})')
        await click(330, 330)

        # a loop still selects in Tap mode
        await page.mouse.move(st[0] + 30, st[1] + 80); await page.mouse.down()
        for x, y in [(230, 80), (230, 230), (30, 230), (30, 82)]:
            await page.mouse.move(st[0] + x, st[1] + y, steps=8)
        await page.mouse.up(); await page.wait_for_timeout(300)
        check(await sel() == ['A', 'B'], f'Tap: drawing a loop still selects ({await sel()})')
        # move the selection by dragging it (still works)
        before = await page.evaluate("() => __inkwell.cur.items.get('A').p[1]")
        await page.mouse.move(st[0] + 120, st[1] + 100); await page.mouse.down(); await page.mouse.move(st[0] + 120, st[1] + 160, steps=6); await page.mouse.up()
        await page.wait_for_timeout(300)
        after = await page.evaluate("() => __inkwell.cur.items.get('A').p[1]")
        check(abs(after - before - 60) < 2, f'Tap: dragging the selection still moves it ({before} -> {after})')

        # remembered after reload
        await page.evaluate("() => __inkwell.flushSaves()")
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('!!(window.__inkwell && window.__inkwell.cur)', timeout=15000)
        await page.evaluate("() => __inkwell.setTool('lasso')")
        on = await page.evaluate("() => [...document.querySelectorAll('#lassoMode button.on')].map(b => b.dataset.m)")
        check(on == ['tap'], f'Tap is remembered after reload ({on})')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
