# 1.58.11: Home Screen app on iPadOS 26 got a viewport short by about the status bar; the app is stretched to the
# real screen height then. Browser tab, split view (narrower than the screen) and big gaps (keyboard) are left alone.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def run(b, vw, vh, sw, sh, standalone):
    ctx = await b.new_context(viewport={'width': vw, 'height': vh})
    await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
    await ctx.add_init_script(f"""Object.defineProperty(screen, 'width', {{get: () => {sw}}}); Object.defineProperty(screen, 'height', {{get: () => {sh}}});
      Object.defineProperty(navigator, 'standalone', {{get: () => {'true' if standalone else 'false'}}});""")
    page = await ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto(URL); await page.wait_for_timeout(3000)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
    r = await page.evaluate("(() => { const a = document.querySelector('.app').getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect(); return [a.height, s.bottom]; })()")
    await ctx.close()
    return r, errs

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # iPad Air landscape: screen 820 x 1180 (portrait numbers), viewport short by 24
        r, e = await run(b, 1180, 796, 820, 1180, True)
        check(abs(r[0] - 820) < 1 and abs(r[1] - 820) < 1, f'Home Screen app, short viewport: app and page reach the screen bottom ({r})')
        check(not e, f'no errors {e}')
        r, e = await run(b, 820, 1156, 820, 1180, True)
        check(abs(r[0] - 1180) < 1, f'portrait too ({r})')
        r, e = await run(b, 1180, 796, 820, 1180, False)
        check(abs(r[0] - 796) < 1, f'in a browser tab nothing changes ({r})')
        r, e = await run(b, 700, 796, 820, 1180, True)
        check(abs(r[0] - 796) < 1, f'split view (narrower than the screen): nothing changes ({r})')
        r, e = await run(b, 1180, 500, 820, 1180, True)
        check(abs(r[0] - 500) < 1, f'big gap (keyboard): nothing changes ({r})')
        r, e = await run(b, 1180, 820, 820, 1180, True)
        check(abs(r[0] - 820) < 1, f'no gap: nothing changes ({r})')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
