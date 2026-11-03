# 1.79: new welcome page: replaces an untouched old one, never an edited one.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
GET = "async () => { const c = await __inkwell.IDB.get('docs', 'c_pg-welcome'); return {wv: c.data.wv, n: c.data.items.length, up: c.updated, first: c.data.items[0].html.slice(0, 80), ml: c.data.bg.ml}; }"
SET = """async ([up, wv]) => { const W = __inkwell, c = await W.IDB.get('docs', 'c_pg-welcome'); const d = {bg: {type: 'grid', sx: 19, sy: 19}, items: [{t: 'x', id: 'x-old', x: 0, y: 0, w: 300, fs: 1, html: '<p>OLD</p>'}]}; await W.IDB.put('docs', Object.assign({}, c, {updated: up, data: d})); }"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        async def start(reload=True):
            if reload: await page.reload()
            await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000); await page.wait_for_timeout(500)
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await page.wait_for_timeout(2500)
        await start(False)
        d = await page.evaluate(GET)
        check(d['wv'] == 2 and d['ml'] == 'red' and d['n'] >= 9, f'fresh install has the new page ({d})')
        await page.evaluate(SET, [1, 0]); await start()
        d = await page.evaluate(GET)
        check(d['wv'] == 2 and 'OLD' not in d['first'], f'untouched old page is replaced ({d})')
        await page.evaluate(SET, [1777000000000, 0]); await start()
        d = await page.evaluate(GET)
        check('OLD' in d['first'] and d['up'] == 1777000000000, f'edited page is left alone ({d})')
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
