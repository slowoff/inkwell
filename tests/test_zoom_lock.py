# 1.70: zoom % button. Hold = lock/unlock the max zoom at the current level; double-tap = lock/unlock
# zooming altogether (pinch only pans, Ctrl+wheel / Fit / 100 % tap do nothing); single tap = 100 %.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def pinch(page, x, y, d0, d1, dx=0, steps=12):
    await page.evaluate('''([x, y, d0, d1, dx, steps]) => {
      const st = document.getElementById('stage');
      const ev = (type, id, px, py) => st.dispatchEvent(new PointerEvent(type, {pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: px, clientY: py, bubbles: true, cancelable: true}));
      ev('pointerdown', 11, x - d0 / 2, y); ev('pointerdown', 12, x + d0 / 2, y);
      for(let i = 1; i <= steps; i++){ const d = d0 + (d1 - d0) * i / steps, o = dx * i / steps; ev('pointermove', 11, x - d / 2 + o, y); ev('pointermove', 12, x + d / 2 + o, y); }
      ev('pointerup', 11, x - d1 / 2 + dx, y); ev('pointerup', 12, x + d1 / 2 + dx, y);
    }''', [x, y, d0, d1, dx, steps])

async def wheel_zoom(page, n, sign=-1):
    await page.mouse.move(590, 410)
    await page.keyboard.down('Control')
    for _ in range(n): await page.mouse.wheel(0, 100 * sign); await page.wait_for_timeout(5)
    await page.keyboard.up('Control')

async def main():
    global bx, by
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        z = lambda: page.evaluate('window.__inkwell.cam.z')
        pr = lambda k: page.evaluate(f'window.__inkwell.prefs.{k}')
        cls = lambda: page.evaluate("document.getElementById('zoomBtn').className")
        vis = lambda c: page.evaluate(f"getComputedStyle(document.querySelector('#zoomBtn .{c}')).display !== 'none'")
        await page.locator('#zoomBtn').scroll_into_view_if_needed()   # the tool bar scrolls sideways at this width
        box = await page.locator('#zoomBtn').bounding_box()
        bx, by = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2

        async def hold(ms=800):
            await page.mouse.move(bx, by); await page.mouse.down(); await page.wait_for_timeout(ms); await page.mouse.up()
            await page.wait_for_timeout(400)
        async def tap():
            await page.mouse.click(bx, by); await page.wait_for_timeout(450)
        async def dbl():
            await page.mouse.click(bx, by); await page.wait_for_timeout(120); await page.mouse.click(bx, by); await page.wait_for_timeout(450)

        check((await page.evaluate("document.getElementById('zoomPct').textContent")) == '100%', 'button shows 100%')
        check(not await vis('zb-max') and not await vis('zb-lock'), 'no lock icons at start')

        # --- hold: lock the max at the current zoom
        while await z() < 2.5: await wheel_zoom(page, 1)
        here = round(await z(), 2)
        await hold()
        check(abs(await pr('zMax') - here) < 0.011, f'hold locks max at current zoom ({await pr("zMax")} vs {here})')
        check(abs(await z() - here) < 0.011, 'hold does not reset the zoom to 100%')
        check('z-max' in await cls() and await vis('zb-max'), 'max-lock icon shown')
        await wheel_zoom(page, 30)
        check(abs(await z() - await pr('zMax')) < 0.001, 'Ctrl+wheel stops at the locked max')
        await wheel_zoom(page, 10, 1)
        check(await z() < here - 0.2, 'zooming out still works under the max lock')
        await page.wait_for_timeout(500)
        check(abs(await page.evaluate("JSON.parse(localStorage.getItem('inkwell.prefs')).zMax") - here) < 0.011, 'max lock stored')
        # Settings shows it too
        await page.evaluate("document.getElementById('settingsBtn').click()")
        await page.wait_for_selector('#setZoomCur', state='visible')
        check(await page.evaluate("document.querySelector('#setZoom [data-v=cur]').classList.contains('on')"), 'Settings shows the max zoom as set')
        await page.click('#settingsDlg [data-close]'); await page.wait_for_timeout(300)
        # hold again: unlock
        await hold()
        check(await pr('zMax') == 8, 'second hold unlocks the max (800%)')
        check('z-max' not in await cls() and not await vis('zb-max'), 'max-lock icon gone')
        await wheel_zoom(page, 60)
        check(await z() > here + 1, f'can zoom past the old max again ({await z()})')

        # --- single tap: back to 100 %
        await tap()
        check(abs(await z() - 1) < 0.001, 'single tap goes back to 100%')

        # --- double tap: zoom lock
        await wheel_zoom(page, 12)
        zl = await z()
        await dbl()
        check(await pr('zLock') is True, 'double tap locks the zoom')
        check(abs(await z() - zl) < 0.001, 'double tap does not change the zoom')
        check('z-lock' in await cls() and await vis('zb-lock') and not await vis('zb-max'), 'padlock shown')
        await wheel_zoom(page, 20)
        check(abs(await z() - zl) < 0.001, 'Ctrl+wheel does not zoom while locked')
        ox0 = await page.evaluate('window.__inkwell.cam.ox')
        await pinch(page, 590, 410, 150, 600, dx=80)
        check(abs(await z() - zl) < 0.001, 'pinch does not zoom while locked')
        check(abs(await page.evaluate('window.__inkwell.cam.ox') - ox0 - 80) < 2, 'two fingers still move the page while locked')
        await tap()
        check(abs(await z() - zl) < 0.001, 'single tap does not reset while locked')
        await page.evaluate("window.__inkwell.prefs.zMax")  # noop
        await page.evaluate("document.getElementById('mFit').click()"); await page.wait_for_timeout(200)
        check(abs(await z() - zl) < 0.001, 'Fit to screen does not zoom while locked')
        # survives a reload
        await page.wait_for_timeout(500)
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.locator('#zoomBtn').scroll_into_view_if_needed()
        box = await page.locator('#zoomBtn').bounding_box(); bx, by = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        check(await pr('zLock') is True and 'z-lock' in await cls(), 'zoom lock kept after reload')
        await wheel_zoom(page, 10)
        zr = await z()
        await wheel_zoom(page, 10)
        check(abs(await z() - zr) < 0.001, 'still locked after reload')
        await dbl()
        check(await pr('zLock') is False and 'z-lock' not in await cls(), 'double tap again unlocks')
        await wheel_zoom(page, 5)
        check(await z() > zr + 0.05, 'zooming works again after unlocking')

        # --- touch (CDP): long press and double tap with a finger
        ctx2 = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx2.route('**/*.supabase.co/**', lambda r: r.abort())
        p2 = await ctx2.new_page()
        p2.on('pageerror', lambda e: errs.append(str(e)))
        await p2.goto(URL); await p2.wait_for_timeout(3000)
        await p2.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await p2.wait_for_timeout(1500)
        cdp = await ctx2.new_cdp_session(p2)
        await p2.locator('#zoomBtn').scroll_into_view_if_needed()
        bb = await p2.locator('#zoomBtn').bounding_box()
        tx, ty = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
        async def touch(kind, x=tx, y=ty):
            await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y}]})
        await p2.evaluate('window.__inkwell.cam.z = 2; window.__inkwell.invalidate()')
        await touch('touchStart'); await p2.wait_for_timeout(800); await touch('touchEnd'); await p2.wait_for_timeout(500)
        check(abs(await p2.evaluate('window.__inkwell.prefs.zMax') - 2) < 0.011, 'finger hold locks the max')
        check(abs(await p2.evaluate('window.__inkwell.cam.z') - 2) < 0.011, 'finger hold keeps the zoom')
        await touch('touchStart'); await p2.wait_for_timeout(60); await touch('touchEnd'); await p2.wait_for_timeout(120)
        await touch('touchStart'); await p2.wait_for_timeout(60); await touch('touchEnd'); await p2.wait_for_timeout(500)
        check(await p2.evaluate('window.__inkwell.prefs.zLock') is True, 'finger double tap locks the zoom')
        check(abs(await p2.evaluate('window.__inkwell.cam.z') - 2) < 0.011, 'finger double tap keeps the zoom')
        await touch('touchStart'); await p2.wait_for_timeout(60); await touch('touchEnd'); await p2.wait_for_timeout(120)
        await touch('touchStart'); await p2.wait_for_timeout(60); await touch('touchEnd'); await p2.wait_for_timeout(500)
        check(await p2.evaluate('window.__inkwell.prefs.zLock') is False, 'finger double tap unlocks')
        await touch('touchStart'); await p2.wait_for_timeout(60); await touch('touchEnd'); await p2.wait_for_timeout(500)
        check(abs(await p2.evaluate('window.__inkwell.cam.z') - 1) < 0.001, 'finger single tap goes to 100%')
        bb2 = await p2.locator('#zoomBtn').bounding_box()
        check(bb2['height'] >= 44, f'button is a 44 pt touch target ({bb2["height"]})')

        check(not errs, f'no page errors {errs}')
        await b.close()
    print('FAILED: ' + str(len(fails)) if fails else 'ALL OK')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
