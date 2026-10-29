# 1.70.3: Rafael tapped Check for update and got "Updates only work in the installed app": the service worker
# registration at start had failed (swallowed), so swReg stayed null for the whole session. Now Check for update
# retries the registration, and if it still fails says why and offers a plain reload.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

# (1.72) the failed registration is made in the page (register() rejects while window.__swBlock is set), not by
# blocking sw.js: the Playwright on GitHub (1.56) did not route a service worker's script, so it registered
# there and the test failed only on GitHub
BLOCK = """(() => { const real = ServiceWorkerContainer.prototype.register; window.__swBlock = true;
  ServiceWorkerContainer.prototype.register = function(...a){
    if(window.__swBlock) return Promise.reject(new TypeError('Failed to register a ServiceWorker: An unknown error occurred when fetching the script.'));
    return real.apply(this, a); }; })()"""

TOASTS = "(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; })()"

async def open_settings(pg):
    await pg.evaluate("() => { const b = document.getElementById('settingsBtn'); if(b) b.click(); }")
    await pg.wait_for_timeout(300)
    if await pg.evaluate("document.getElementById('settingsDlg').hidden"):
        await pg.evaluate("() => { document.getElementById('settingsDlg').hidden = false; }")
    await pg.evaluate("document.getElementById('updBtn').scrollIntoView()")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        await ctx.add_init_script(BLOCK)
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e) + ' @ ' + (e.stack or '')[:300]))
        await pg.goto(URL); await pg.wait_for_timeout(3000)
        st = await pg.evaluate("navigator.serviceWorker.getRegistration().then(r => !!r)")
        check(not st, f'first registration failed as staged ({st})')

        # still failing: the button explains and offers Reload, never the old message
        await open_settings(pg)
        await pg.click('#updBtn'); await pg.wait_for_timeout(1500)
        t = await pg.evaluate(TOASTS)
        check('installed app' not in t and 'Could not check for updates' in t and 'Reload' in t, f'failing check says why and offers Reload ({t!r})')
        check(await pg.evaluate("document.getElementById('updBtn').textContent") == 'Check for update' and not await pg.evaluate("document.getElementById('updBtn').disabled"), 'button usable again')

        # network back: the next tap registers and checks
        await pg.evaluate("window.__swBlock = false; document.getElementById('toast').hidden = true; window.__mark = 1")
        await pg.click('#updBtn'); await pg.wait_for_timeout(5000)
        st = await pg.evaluate("navigator.serviceWorker.getRegistration().then(r => !!r)")
        t = await pg.evaluate(TOASTS)
        check(st, 'tapping again registers the offline helper')
        reloaded = await pg.evaluate("!window.__mark")
        check(reloaded or 'latest version' in t, f'and the helper takes over: the app reloads into the newest version ({reloaded}, {t!r})')
        await ctx.close()

        # retry on coming back to the front (no tap needed)
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        await ctx.add_init_script(BLOCK)
        pg = await ctx.new_page()
        pg.on('pageerror', lambda e: errs.append(str(e) + ' @ ' + (e.stack or '')[:300]))
        await pg.goto(URL); await pg.wait_for_timeout(3000)
        await pg.evaluate("window.__swBlock = false; document.dispatchEvent(new Event('visibilitychange'))"); await pg.wait_for_timeout(2500)
        st = await pg.evaluate("navigator.serviceWorker.getRegistration().then(r => !!r)")
        check(st, 'coming back to the app retries the registration')
        await ctx.close()

        # normal start: unchanged
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        pg = await ctx.new_page()
        pg.on('pageerror', lambda e: errs.append(str(e) + ' @ ' + (e.stack or '')[:300]))
        await pg.goto(URL); await pg.wait_for_timeout(3500)
        await open_settings(pg)
        await pg.click('#updBtn'); await pg.wait_for_timeout(3000)
        t = await pg.evaluate(TOASTS)
        check('latest version' in t, f'normal start: Check for update says latest version ({t!r})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
