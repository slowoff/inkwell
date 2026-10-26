# 1.64.3 (Rafael, morning 2026-10-26: no notes, Settings would not open; "I think the internet was down").
# config.js is fetched network-first by the service worker and loaded before everything else; on a connection that is
# up but not working the request hung and Inkwell never started. Now the stored copy is used after 2 s, and an answer
# that is not a script (a Wi-Fi login page) is neither used nor stored.
import asyncio, os, re
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
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, service_workers='allow')
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        cfg0 = await page.evaluate("() => JSON.stringify(window.INKWELL_CONFIG || null)")

        # 1) the connection hangs: config.js never answers
        hung = []
        async def hang(route, request):
            hung.append(request.url)
            await asyncio.sleep(30)
            try: await route.abort()
            except Exception: pass
        await ctx.route(re.compile(r'.*/config\.js(\?.*)?$'), hang)
        t0 = asyncio.get_event_loop().time()
        await page.reload(wait_until='commit')
        try:
            await page.wait_for_function('!!window.__inkwellBooted', timeout=12000)
            took = asyncio.get_event_loop().time() - t0
        except Exception:
            took = None
        check(took is not None and took < 9, f'with a hanging connection Inkwell still starts (in {took and round(took, 1)} s; the request was tried: {bool(hung)})')
        cfg1 = await page.evaluate("() => JSON.stringify(window.INKWELL_CONFIG || null)")
        check(cfg1 == cfg0 and cfg1 != 'null', 'and it uses the stored settings (sync keys)')
        opened = await page.evaluate("async () => { document.getElementById('settingsBtn').click(); await new Promise(r => setTimeout(r, 400)); return !document.getElementById('settingsDlg').hidden; }")
        check(opened, 'Settings opens')
        await ctx.unroute(re.compile(r'.*/config\.js(\?.*)?$'))

        # 2) a Wi-Fi login page answers instead of the file: not used, not stored
        async def portal(route, request):
            await route.fulfill(status=200, content_type='text/html', body='<html><body>Please log in to the Wi-Fi</body></html>')
        await ctx.route(re.compile(r'.*/config\.js(\?.*)?$'), portal)
        await page.reload(); await page.wait_for_timeout(500)
        await page.wait_for_function('!!window.__inkwellBooted', timeout=12000)
        cfg2 = await page.evaluate("() => JSON.stringify(window.INKWELL_CONFIG || null)")
        check(cfg2 == cfg0, 'a Wi-Fi login page instead of config.js is not used')
        await ctx.unroute(re.compile(r'.*/config\.js(\?.*)?$'))
        await ctx.set_offline(True)
        await page.reload(); await page.wait_for_timeout(500)
        await page.wait_for_function('!!window.__inkwellBooted', timeout=12000)
        cfg3 = await page.evaluate("() => JSON.stringify(window.INKWELL_CONFIG || null)")
        check(cfg3 == cfg0, 'and was not stored (offline afterwards the real settings are still there)')
        await ctx.set_offline(False)
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
