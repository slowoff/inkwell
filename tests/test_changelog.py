# 1.47: "See changes" next to the version in Settings opens the change log (1.47.1: in its own window on top of Settings); the newest entry must match
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
            check(await page.evaluate("document.getElementById('logDlg').hidden"), f'[{vw}px] change log window closed at first')
            btn = await page.evaluate("(() => { const b = document.getElementById('logBtn').getBoundingClientRect(), v = document.getElementById('verInfo').getBoundingClientRect(); return {b: [b.left, b.top, b.width, b.height], v: [v.left, v.top, v.right]}; })()")
            check(btn['b'][2] > 0 and abs(btn['b'][1] - btn['v'][1]) < 14, f'[{vw}px] "See changes" sits next to the version ({btn})')
            await page.click('#logBtn'); await page.wait_for_timeout(300)
            info = await page.evaluate("""(() => { const d = document.getElementById('logDlg'), c = document.getElementById('changelog'), dl = d.querySelector('.dlg'), r = dl.getBoundingClientRect();
              const top = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
              return {hidden: d.hidden, onTop: !!(top && top.closest('#logDlg')), first: c.querySelector('h4') && c.querySelector('h4').firstChild.textContent, n: c.querySelectorAll('h4').length,
                      top: r.top, bottom: r.bottom, right: r.right, vh: innerHeight, scroll: c.scrollHeight > c.clientHeight && dl.scrollHeight <= dl.clientHeight + 1, headTop: d.querySelector('h3').getBoundingClientRect().top, title: d.querySelector('h3').textContent,
                      settings: !document.getElementById('settingsDlg').hidden}; })()""")
            check(not info['hidden'] and info['onTop'], f'[{vw}px] tapping it opens a window on top ({info})')
            check(info['title'] == "What's new" and info['n'] >= 50, f'[{vw}px] window lists the versions ({info["n"]})')
            check(info['first'] == ver, f'[{vw}px] newest entry is the current version {ver} ({info["first"]})')
            check(info['top'] >= 0 and info['bottom'] <= info['vh'] + 0.5 and info['right'] <= vw + 0.5, f'[{vw}px] window fits the screen, nothing cut off ({info})')
            check(info['scroll'], f'[{vw}px] the long list scrolls inside the window, the title stays put')
            # 1.58.2: on the iPad the status bar (top) and home bar (bottom) areas are kept free
            ins = await page.evaluate("""(() => { const r = document.documentElement.style; r.setProperty('--sat', '24px'); r.setProperty('--sab', '20px');
              const b = document.querySelector('#logDlg .dlg').getBoundingClientRect(); const out = [b.top, b.bottom, innerHeight];
              r.removeProperty('--sat'); r.removeProperty('--sab'); return out; })()""")
            check(ins[0] >= 24 + 15.5 and ins[1] <= ins[2] - 20 - 15.5, f'[{vw}px] window stays clear of the status bar and home bar ({ins})')
            await page.evaluate("document.getElementById('changelog').scrollTop = 600"); await page.wait_for_timeout(100)
            ht = await page.evaluate("document.querySelector('#logDlg h3').getBoundingClientRect().top")
            check(abs(ht - info['headTop']) < 0.5, f'[{vw}px] title stays at the top while the list scrolls')
            vers = await page.evaluate("__inkwell.CHANGELOG.map(e => e[0])")
            check(len(vers) == len(set(vers)), 'no version listed twice')
            await page.click('#logDlg [data-close]'); await page.wait_for_timeout(200)
            st = await page.evaluate("[document.getElementById('logDlg').hidden, document.getElementById('settingsDlg').hidden]")
            check(st == [True, False], f'[{vw}px] closing it goes back to Settings ({st})')
            check(not errs, f'[{vw}px] no page errors {errs}')
            await ctx.close()
        await b.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
