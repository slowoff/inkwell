# 1.98: highlighter has six colours (set A). A device with the old four gets the new six once; a colour not in the
# new set falls back to yellow; changes made afterwards are kept on the next start.
import asyncio, json, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
A = ['#FFE45C', '#8EE89A', '#FF9EC7', '#8CCBFF', '#FFB870', '#C9A8FF']
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        old = {'tool': 'hl', 'hl': {'c': '#E24B4A', 's': 30}, 'hlFavs': ['#FFFF88', '#A8F5A8', '#E24B4A', '#7AB8F0'], 'barPos': 'right'}
        await ctx.add_init_script(f"if(!sessionStorage.getItem('seeded')){{localStorage.setItem('inkwell.prefs', {json.dumps(json.dumps(old))}); sessionStorage.setItem('seeded','1');}}")
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500); await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(500)
        st = await page.evaluate("[__inkwell.prefs.hlFavs, __inkwell.prefs.hl.c, __inkwell.prefs.hl.s, document.querySelectorAll('#swatches .swatch').length, !!document.querySelector('#swatches .swatch.on')]")
        check(st[0] == A, f'old four replaced by the six ({st[0]})')
        check(st[1] == '#FFE45C' and st[2] == 30, f'red not in the set falls back to yellow, size kept ({st[1]}, {st[2]})')
        check(st[3] == 6 and st[4], f'six swatches shown, one selected ({st[3]})')
        cols = await page.evaluate("getComputedStyle(document.getElementById('swatches')).gridTemplateColumns.split(' ').length")
        check(cols == 3, f'three to a row in the side bar like the pen ({cols})')
        # a later change sticks after a restart
        await page.evaluate("() => { __inkwell.prefs.hlFavs[5] = '#123456'; }"); await page.wait_for_timeout(800)
        await page.evaluate("() => localStorage.setItem('inkwell.prefs', JSON.stringify(__inkwell.prefs))")
        await page.reload(); await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        again = await page.evaluate("__inkwell.prefs.hlFavs[5]")
        check(again == '#123456', f'switch happens only once ({again})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
