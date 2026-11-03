# 1.80: Formulas window: lists formulas, changes one (one undo step), removes one; old curves are left alone.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
F = """() => { const o = {}; for(const it of __inkwell.cur.items.values()) if(it.gf){ const f = o[it.gf.src] || (o[it.gf.src] = {n: 0, m: 0, c: null, s: it.gf.s, g: it.g, ne: it.ne}); if(it.t === 'm') f.m++; else { f.n++; f.c = it.c; } } return o; }"""
ROWS = "() => [...document.querySelectorAll('#gaList .ga-row span')].map(e => e.textContent)"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, device_scale_factor=2)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_selector('#graphDlg', state='visible')
        await page.click('#gType [data-v="q4"]'); await page.fill('#gFn', 'x^2'); await page.click('#gInsert'); await page.wait_for_timeout(500)
        async def win():
            await page.click('#selGraph'); await page.wait_for_selector('#gAddDlg', state='visible'); await page.wait_for_timeout(200)
        await win()
        check(await page.evaluate(ROWS) == ['y = x^2'], 'the graph window formula is listed')
        await page.fill('#gaFn', '2x+1'); await page.click('#gaC [data-c="#C2362B"]'); await page.click('#gaAdd'); await page.wait_for_timeout(400)
        d = await page.evaluate(F)
        check(set(d) == {'x^2', '2x+1'} and d['2x+1']['c'] == '#C2362B', f'added formula remembered ({d})')
        await win()
        check(await page.evaluate(ROWS) == ['y = x^2', 'y = 2x+1'], 'both listed')
        check(await page.evaluate("document.getElementById('gaAdd').textContent") == 'Add', 'opens ready to add')
        await page.click('#gaList .ga-row:nth-child(2) [data-pick]'); await page.wait_for_timeout(100)
        st = await page.evaluate("() => ({v: gaFn.value, b: gaAdd.textContent, t: gaTitle.textContent, c: document.querySelector('#gaC .on').dataset.c, lbl: gaLbl.checked})")
        check(st == {'v': '2x+1', 'b': 'Save', 't': 'Change formula', 'c': '#C2362B', 'lbl': True}, f'tap fills in the formula ({st})')
        if os.environ.get('GSHOT'): await page.screenshot(path=os.environ['GSHOT'])
        before = await page.evaluate("() => __inkwell.cur.items.size")
        await page.fill('#gaFn', '-x+2'); await page.click('#gaC [data-c="#167A3C"]'); await page.click('#gaS [data-v="dash"]'); await page.click('#gaAdd'); await page.wait_for_timeout(400)
        d = await page.evaluate(F)
        check(set(d) == {'x^2', '-x+2'} and d['-x+2']['c'] == '#167A3C' and d['-x+2']['s'] == 'dash' and d['-x+2']['n'] > 3 and d['-x+2']['m'] == 1 and d['-x+2']['ne'] == 1, f'changed in place ({d})')
        check(d['x^2']['g'] == d['-x+2']['g'], 'still in the graph group')
        await page.keyboard.press('Control+z'); await page.wait_for_timeout(300)
        d = await page.evaluate(F)
        check(set(d) == {'x^2', '2x+1'} and d['2x+1']['c'] == '#C2362B' and await page.evaluate("() => __inkwell.cur.items.size") == before, f'one undo brings the old one back ({list(d)})')
        await page.evaluate("() => { const W = __inkwell, its = [...W.cur.items.values()]; W.setTool('lasso'); W.selectIds(its.filter(i => i.g === its.find(k => k.gf).g).map(i => i.id)); }"); await page.wait_for_timeout(300)
        await win()
        await page.click('#gaList .ga-row:nth-child(1) [data-pick]'); await page.fill('#gaFn', 'x+100'); await page.click('#gaAdd'); await page.wait_for_timeout(200)
        check('never shows' in await page.inner_text('#gaMsg') and 'x^2' in await page.evaluate(F), 'a bad change keeps the old one and says why')
        await page.click('#gaNew'); check(await page.evaluate("gaFn.value === '' && gaAdd.textContent === 'Add'"), 'New formula goes back to adding')
        await page.click('#gaList .ga-row:nth-child(1) [data-del]'); await page.wait_for_timeout(300)
        d = await page.evaluate(F)
        check(set(d) == {'2x+1'} and await page.evaluate(ROWS) == ['y = 2x+1'], f'remove takes it off the graph and the list ({list(d)})')
        await page.click('#gAddDlg [data-close]'); await page.wait_for_timeout(200)
        await page.evaluate("() => __inkwell.flushSaves()"); await page.wait_for_timeout(300)
        await page.reload(); await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000); await page.wait_for_timeout(800)
        d = await page.evaluate(F)
        check(set(d) == {'2x+1'}, 'formula known after a reload')
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
