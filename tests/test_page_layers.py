# 2.5: layers on every page (Writing, Highlights, Notes, Extra); highlights go on Highlights by themselves.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

LY = "[...__inkwell.cur.items.values()].map(i => Tech.lyOf(i, false))"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500); await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate("async () => { const W = __inkwell; await W.newPage(); W.prefs.pageLayer = 'd'; W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.setTool('pen'); W.invalidate(); }")
        check(not await page.evaluate("document.getElementById('layerBtn').hidden"), 'normal page: Layers button shown with the pen')
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        async def drag(pts):
            await page.mouse.move(st[0] + pts[0][0], st[1] + pts[0][1]); await page.mouse.down()
            for x, y in pts[1:]: await page.mouse.move(st[0] + x, st[1] + y, steps=6)
            await page.mouse.up(); await page.wait_for_timeout(250)
        await drag([(100, 200), (200, 230), (300, 205)])
        # an old highlight without a layer, as older versions saved it
        await page.evaluate("""() => { const W = __inkwell; W.cur.items.set('sold1', {t: 's', id: 'sold1', c: 'yellow', w: 20, hl: true, p: [100, 300, .5, 300, 300, .5]}); W.invalidate(); }""")
        await page.evaluate("__inkwell.setTool('hl')")
        await drag([(100, 400), (200, 405), (300, 400)])
        hls = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.hl).map(i => i.ly || '')")
        check(hls.count('h') >= 1, f'new highlight saved on Highlights ({hls})')
        lys = await page.evaluate(LY)
        check(lys.count('h') == 2 and lys.count('d') == 1, f'old highlight counts as Highlights ({lys})')
        await page.evaluate("__inkwell.setTool('pen'); document.getElementById('layerBtn').click()"); await page.wait_for_timeout(150)
        rows = await page.evaluate("[...document.querySelectorAll('#layerList .layer-name b')].map(b => b.textContent)")
        check(rows == ['Writing', 'Highlights', 'Notes', 'Extra'], f'four page layers listed ({rows})')
        check(await page.evaluate("document.getElementById('layerShowAll').hidden"), 'no Show all while nothing is hidden')
        # hide Highlights
        await page.evaluate("document.querySelector('#layerList [data-eye=\"h\"]').click()"); await page.wait_for_timeout(300)
        hide = await page.evaluate("__inkwell.docs.get(__inkwell.cur.id).data.lyHide")
        check(hide == ['h'], f'hidden layers saved with the page ({hide})')
        check(not await page.evaluate("document.getElementById('layerShowAll').hidden"), 'Show all appears')
        hid = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => Tech.hidden(i)).length")
        check(hid == 2, f'both highlights hidden ({hid})')
        # pick Notes and draw there
        await page.evaluate("document.querySelector('#layerList [data-ly=\"n\"]').click(); closePops()")
        check(await page.evaluate("__inkwell.prefs.pageLayer") == 'n', 'Notes chosen')
        await drag([(100, 500), (200, 520), (300, 505)])
        n = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.ly === 'n').length")
        check(n == 1, f'new stroke on Notes ({n})')
        # a highlight while on Notes still goes on Highlights and shows it again
        await page.evaluate("__inkwell.setTool('hl')")
        await drag([(100, 600), (200, 605), (300, 600)])
        hide = await page.evaluate("__inkwell.docs.get(__inkwell.cur.id).data.lyHide")
        check(hide == [], f'highlighting shows Highlights again ({hide})')
        # select box skips a hidden layer
        await page.evaluate("__inkwell.setTool('pen'); document.getElementById('layerBtn').click()"); await page.wait_for_timeout(100)
        await page.evaluate("document.querySelector('#layerList [data-eye=\"n\"]').click()"); await page.wait_for_timeout(300)
        await page.evaluate("closePops(); __inkwell.setTool('lasso'); __inkwell.prefs.lassoMode = 'box'")
        await drag([(60, 150), (300, 400), (380, 560)])
        selly = await page.evaluate("(__inkwell.sel ? __inkwell.sel.ids : []).map(id => Tech.lyOf(__inkwell.cur.items.get(id), false)).sort().join(',')")
        check('n' not in selly and 'd' in selly, f'hidden Notes not selected ({selly})')
        # Show all
        await page.evaluate("clearSel(); __inkwell.setTool('pen'); document.getElementById('layerBtn').click()"); await page.wait_for_timeout(100)
        await page.evaluate("document.getElementById('layerShowAll').click()"); await page.wait_for_timeout(300)
        hide = await page.evaluate("__inkwell.docs.get(__inkwell.cur.id).data.lyHide")
        check(hide == [], f'Show all layers ({hide})')
        await page.evaluate("__inkwell.prefs.pageLayer = 'd'")
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
