# 1.71.1: a finger whose "lifted" event iPadOS never sent stayed in the finger list until Inkwell was restarted.
# Every later pinch paired a real finger with that ghost: the zoom resisted and the page jumped.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

GHOST = """(id) => { const st = document.getElementById('stage');
  st.dispatchEvent(new PointerEvent('pointerdown', {pointerId: id, pointerType: 'touch', isPrimary: true, clientX: 200, clientY: 300, bubbles: true, cancelable: true})); }"""

async def pinch(page, x, y, d0, d1, primary=True, steps=12, ids=(11, 12)):
    await page.evaluate('''([x, y, d0, d1, primary, steps, a, b]) => {
      const st = document.getElementById('stage');
      const ev = (type, id, px, py) => st.dispatchEvent(new PointerEvent(type, {pointerId: id, pointerType: 'touch', isPrimary: primary && id === a, clientX: px, clientY: py, bubbles: true, cancelable: true}));
      ev('pointerdown', a, x - d0 / 2, y); ev('pointerdown', b, x + d0 / 2, y);
      for(let i = 1; i <= steps; i++){ const d = d0 + (d1 - d0) * i / steps; ev('pointermove', a, x - d / 2, y); ev('pointermove', b, x + d / 2, y); }
      ev('pointerup', a, x - d1 / 2, y); ev('pointerup', b, x + d1 / 2, y);
    }''', [x, y, d0, d1, primary, steps, ids[0], ids[1]])

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("__inkwell.prefs.zMax = 8; __inkwell.prefs.zLock = false; __inkwell.prefs.finger = false")
        z = lambda: page.evaluate('__inkwell.cam.z')
        async def setz(v):
            await page.evaluate(f"(() => {{ const c = __inkwell.cam; c.z = {v}; c.ox = 0; c.oy = 0; __inkwell.invalidate(); }})()")
        # 1) ghost, then a normal pinch (first finger is primary) zooms by the finger spread
        await setz(0.2)
        await page.evaluate(GHOST, 5)
        await pinch(page, 700, 450, 100, 300)
        r = await z() / 0.2
        check(abs(r - 3) < 0.15, f'ghost finger left over: pinch still zooms 3x with the fingers (got {r:.2f}x)')
        # 2) ghost and no primary flag on the fingers: the two newest fingers are used
        await setz(0.2)
        await page.evaluate(GHOST, 6)
        await pinch(page, 700, 450, 100, 250, primary=False, ids=(21, 22))
        r = await z() / 0.2
        check(abs(r - 2.5) < 0.15, f'ghost and no first-finger flag: pinch follows the two newest fingers (got {r:.2f}x)')
        # 3) the page under the pinch centre stays put (no jump)
        await setz(0.3)
        await page.evaluate(GHOST, 7)
        w0 = await page.evaluate("(() => { const c = __inkwell.cam, r = document.getElementById('stage').getBoundingClientRect(); return [(700 - r.left - c.ox) / c.z, (450 - r.top - c.oy) / c.z]; })()")
        await pinch(page, 700, 450, 120, 240, primary=False, ids=(31, 32))
        w1 = await page.evaluate("(() => { const c = __inkwell.cam, r = document.getElementById('stage').getBoundingClientRect(); return [(700 - r.left - c.ox) / c.z, (450 - r.top - c.oy) / c.z]; })()")
        check(math.hypot(w1[0] - w0[0], w1[1] - w0[1]) < 40, f'spot under the fingers stays put ({w0} -> {w1})')
        # 4) real touch end with no fingers left clears ghosts (safety net), then a non-primary pinch works
        await setz(0.2)
        await page.evaluate(GHOST, 8); await page.evaluate(GHOST, 9)
        cdp = await ctx.new_cdp_session(page)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': 900, 'y': 600}]})
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        await page.wait_for_timeout(200)
        await setz(0.2)
        await pinch(page, 700, 450, 100, 200, primary=False, ids=(41, 42))
        r = await z() / 0.2
        check(abs(r - 2) < 0.12, f'after all fingers lift, old ghosts are gone (got {r:.2f}x)')
        # 5) one finger pans normally after a ghost (no pinch with the ghost)
        await setz(1)
        await page.evaluate(GHOST, 10)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': 600, 'y': 400}]})
        for i in range(1, 9): await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': 600, 'y': 400 + 15 * i}]})
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        await page.wait_for_timeout(150)
        cam = await page.evaluate("[__inkwell.cam.z, __inkwell.cam.oy]")
        check(abs(cam[0] - 1) < 0.001 and abs(cam[1] - 120) < 10, f'one finger after a ghost pans, no zoom ({cam})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
