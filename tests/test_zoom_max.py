# 1.37: Settings → Max zoom. "Use current zoom" makes the zoom level you are at the highest one;
# pinch and Ctrl+wheel stop there. "No limit" goes back to 800 %. Guest mode (no account).
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def pinch(page, x, y, d0, d1, steps=12):
    # two touch pointers moving apart, sent straight to the stage
    await page.evaluate('''([x, y, d0, d1, steps]) => {
      const st = document.getElementById('stage');
      const ev = (type, id, px) => st.dispatchEvent(new PointerEvent(type, {pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: px, clientY: y, bubbles: true, cancelable: true}));
      ev('pointerdown', 11, x - d0 / 2); ev('pointerdown', 12, x + d0 / 2);
      for(let i = 1; i <= steps; i++){ const d = d0 + (d1 - d0) * i / steps; ev('pointermove', 11, x - d / 2); ev('pointermove', 12, x + d / 2); }
      ev('pointerup', 11, x - d1 / 2); ev('pointerup', 12, x + d1 / 2);
    }''', [x, y, d0, d1, steps])

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
        z = lambda: page.evaluate('window.__inkwell.cam.z')
        check(await page.evaluate('window.__inkwell.prefs.zMax') == 8, 'default max zoom is 800 %')
        # zoom in to about 250 % with Ctrl+wheel
        await page.mouse.move(590, 410)
        await page.keyboard.down('Control')
        while await z() < 2.5:
            await page.mouse.wheel(0, -100); await page.wait_for_timeout(5)
        await page.keyboard.up('Control')
        here = round(await z(), 2)
        check(2.5 <= here < 2.7, f'zoomed to {here}')
        # open Settings and tap "Use current zoom"
        await page.evaluate("document.getElementById('settingsBtn').click()")
        await page.wait_for_selector('#setZoomCur', state='visible')
        label = await page.evaluate("document.getElementById('setZoomCur').textContent")
        check(str(round(here * 100)) in label, f'button shows the current zoom: {label!r}')
        await page.click('#setZoomCur')
        zm = await page.evaluate('window.__inkwell.prefs.zMax')
        check(abs(zm - here) < 0.011, f'max zoom saved as {zm}')
        await page.wait_for_timeout(500)
        saved = await page.evaluate("JSON.parse(localStorage.getItem('inkwell.prefs')).zMax")
        check(abs(saved - here) < 0.011, 'max zoom stored on the device')
        check(await page.evaluate("document.querySelector('#setZoom [data-v=cur]').classList.contains('on')"), '"Use current zoom" marked as chosen')
        await page.click('#settingsDlg [data-close]'); await page.wait_for_timeout(300); await page.mouse.move(590, 410)
        # Ctrl+wheel past the max stops at it
        await page.keyboard.down('Control')
        for _ in range(40): await page.mouse.wheel(0, -100); await page.wait_for_timeout(5)
        await page.keyboard.up('Control')
        check(abs(await z() - zm) < 0.001, f'Ctrl+wheel stops at max ({await z()})')
        # pinch: zoom out, then pinch far in, stops at max
        await page.evaluate('window.__inkwell.cam.z = 1')
        await pinch(page, 590, 410, 100, 900)
        check(abs(await z() - zm) < 0.001, f'pinch stops at max ({await z()})')
        # zooming out still works
        await pinch(page, 590, 410, 600, 150)
        check(await z() < zm - 0.5, f'pinch out still works ({await z()})')
        # survives a reload
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        check(abs(await page.evaluate('window.__inkwell.prefs.zMax') - zm) < 0.001, 'max zoom kept after reload')
        await page.mouse.move(590, 410)
        await page.keyboard.down('Control')
        for _ in range(80): await page.mouse.wheel(0, -100); await page.wait_for_timeout(5)
        await page.keyboard.up('Control')
        check(abs(await z() - zm) < 0.001, 'max zoom still applies after reload')
        # No limit goes back to 800 %
        await page.evaluate("document.getElementById('settingsBtn').click()")
        await page.wait_for_selector('#setZoomCur', state='visible')
        await page.click('#setZoom [data-v=none]')
        check(await page.evaluate('window.__inkwell.prefs.zMax') == 8, '"No limit" resets to 800 %')
        await page.click('#settingsDlg [data-close]'); await page.wait_for_timeout(300); await page.mouse.move(590, 410)
        await page.keyboard.down('Control')
        for _ in range(60): await page.mouse.wheel(0, -100); await page.wait_for_timeout(5)
        await page.keyboard.up('Control')
        check(await z() > zm + 0.5, f'can zoom past the old max again ({await z()})')
        # old prefs without zMax and junk values fall back to 800 %
        await page.evaluate("localStorage.setItem('inkwell.prefs', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('inkwell.prefs')), {zMax: 'x'})))")
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.mouse.move(590, 410)
        await page.keyboard.down('Control')
        for _ in range(120): await page.mouse.wheel(0, -100); await page.wait_for_timeout(3)
        await page.keyboard.up('Control')
        check(abs(await z() - 8) < 0.001, f'bad stored value falls back to 800 % ({await z()})')
        check(not errs, 'no page errors: ' + '; '.join(errs[:3]))
        await b.close()
    if fails: raise SystemExit(1)
    print('ALL OK')
asyncio.run(main())
