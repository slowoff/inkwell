# 1.47: "See changes" next to the version in Settings opens the change log in place; the newest entry must match
# VERSION in sw.js (so a release without a change log entry fails here).
import asyncio, os, re
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def main():
    ver = re.search(r"VERSION = 'inkwell-([\d.]+)'", open(os.path.join(os.path.dirname(__file__), '..', 'sw.js')).read()).group(1)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for vw in (1180, 390):
            ctx = await b.new_context(viewport={'width': vw, 'height': 820})
            await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
            page = await ctx.new_page()
            errs = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            await page.goto(URL); await page.wait_for_timeout(3000)
            await page.evaluate("() => document.getElementById('settingsBtn') ? document.getElementById('settingsBtn').click() : null")
            await page.wait_for_timeout(200)
            if await page.evaluate("document.getElementById('settingsDlg').hidden"):
                await page.evaluate("() => { document.getElementById('settingsDlg').hidden = false; }")
            await page.evaluate("() => document.getElementById('logBtn').scrollIntoView()")
            check(await page.evaluate("document.getElementById('changelog').hidden"), f'[{vw}px] change log closed at first')
            btn = await page.evaluate("(() => { const b = document.getElementById('logBtn').getBoundingClientRect(), v = document.getElementById('verInfo').getBoundingClientRect(); return {b: [b.left, b.top, b.width, b.height], v: [v.left, v.top, v.right]}; })()")
            check(btn['b'][2] > 0 and abs(btn['b'][1] - btn['v'][1]) < 14, f'[{vw}px] "See changes" sits next to the version ({btn})')
            await page.click('#logBtn'); await page.wait_for_timeout(200)
            info = await page.evaluate("(() => { const c = document.getElementById('changelog'), r = c.getBoundingClientRect(); return {hidden: c.hidden, first: c.querySelector('h4') && c.querySelector('h4').firstChild.textContent, n: c.querySelectorAll('h4').length, w: r.width, right: r.right, sw: document.documentElement.scrollWidth, label: document.getElementById('logBtn').textContent}; })()")
            check(not info['hidden'] and info['n'] >= 50, f'[{vw}px] tapping it shows the list ({info["n"]} versions)')
            check(info['first'] == ver, f'[{vw}px] newest entry is the current version {ver} ({info["first"]})')
            check(info['label'] == 'Hide changes', f'[{vw}px] button says Hide changes')
            check(info['right'] <= vw + 0.5, f'[{vw}px] list fits the screen ({info})')
            vers = await page.evaluate("__inkwell.CHANGELOG.map(e => e[0])")
            check(len(vers) == len(set(vers)), 'no version listed twice')
            await page.click('#logBtn'); await page.wait_for_timeout(100)
            check(await page.evaluate("document.getElementById('changelog').hidden"), f'[{vw}px] tapping again hides it')
            check(not errs, f'[{vw}px] no page errors {errs}')
            await ctx.close()
        await b.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
