# 1.44.1: with the Text tool a finger tap places a text box (before, only the Pencil or mouse could);
# a finger drag still moves the page, a tap while typing just closes the box, Formula opens its dialog.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await page.evaluate("() => __inkwell.setTool('text')")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        cdp = await ctx.new_cdp_session(page)
        async def tap(x, y):
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': st[0] + x, 'y': st[1] + y}]})
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            await page.wait_for_timeout(400)
        async def drag(x, y, dx, dy):
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': st[0] + x, 'y': st[1] + y}]})
            for k in range(1, 11):
                await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': st[0] + x + dx * k / 10, 'y': st[1] + y + dy * k / 10}]})
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            await page.wait_for_timeout(400)
        boxes = lambda: page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'x').length")
        typing = lambda: page.evaluate("!!document.querySelector('.it-text[contenteditable=true]')")

        await tap(200, 200)
        check(await boxes() == 1 and await typing(), 'finger tap with the Text tool makes a text box ready to type in')
        await page.keyboard.type('hello'); await page.wait_for_timeout(100)
        await tap(400, 450)
        check(await boxes() == 1 and not await typing(), 'a finger tap elsewhere while typing just closes the box (no second box)')
        await tap(400, 450)
        check(await boxes() == 2 and await typing(), 'the next finger tap makes a new box')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        n = await boxes()
        cam0 = await page.evaluate("[__inkwell.cam.ox, __inkwell.cam.oy]")
        await drag(300, 300, 0, -150)
        cam1 = await page.evaluate("[__inkwell.cam.ox, __inkwell.cam.oy]")
        check(await boxes() == n and abs(cam1[1] - cam0[1]) > 100, f'a finger drag still moves the page and makes no box ({cam0} -> {cam1})')
        await page.wait_for_timeout(600)
        await tap(203, 50)
        h = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'x').map(i => i.html).join('|')")
        check('hello' in h, 'tapping an existing box with a finger still edits it, not a new one')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(600)
        await page.evaluate("() => __inkwell.setTool('math')")
        await tap(500, 500)
        open_ = await page.evaluate("(() => { const d = document.getElementById('mathDlg'); return !!d && !d.hidden ; })()")
        check(open_, 'finger tap with the Formula tool opens the formula dialog')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
