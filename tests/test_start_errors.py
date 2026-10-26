# 1.64.2: if Inkwell fails to start, a box shows the error (file and step) with Reload; a normal start shows nothing.
import asyncio, os, re
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def run(p, broken):
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
    await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
    if broken:
        async def bad(route, request):
            r = await route.fetch(); body = await r.text()
            await route.fulfill(response=r, body="throw new Error('planted start failure');\n" + body)
        await ctx.route(re.compile(r'.*/app/07-binder\.js$'), bad)
        await ctx.add_init_script("navigator.serviceWorker && (navigator.serviceWorker.register = () => Promise.reject(new Error('no sw in this test')))")
    page = await ctx.new_page()
    await page.goto(URL); await page.wait_for_timeout(10500)
    box = await page.evaluate("() => { const m = document.getElementById('inkwellStuck'); return m ? m.innerText : null; }")
    booted = await page.evaluate("() => !!window.__inkwellBooted")
    await b.close()
    return box, booted

async def main():
    async with async_playwright() as p:
        box, booted = await run(p, False)
        check(box is None and booted, f'normal start: no box ({booted})')
        box, booted = await run(p, True)
        print(' box:', (box or '')[:300].replace('\n', ' | '))
        check(box is not None and 'did not start' in box, 'a file that fails to load: the box appears')
        check(box is not None and 'app/07-binder.js' in box and 'planted start failure' in box, 'it names the file and the error')
        check(box is not None and 'Reload' in box, 'with a Reload button')
asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
