# 1.65 (Rafael: "make it remember the graph settings so I don't have to type them in every time").
# The graph window keeps what was typed (type, axis names, ranges, steps, function, numbers, grid) on this device,
# also after the app restarts. Picking another type still puts that type's usual ranges in.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

VALUES = {'gLx': 't', 'gLy': 's', 'gX0': '0', 'gX1': '20', 'gXs': '2', 'gY0': '-5', 'gY1': '5', 'gYs': '0.5', 'gFn': '0.5*x-3'}
READ = "() => ({type: [...document.querySelectorAll('#gType button.on')].map(b => b.dataset.v)[0], v: Object.fromEntries(['gLx','gLy','gX0','gX1','gXs','gY0','gY1','gYs','gFn'].map(id => [id, document.getElementById(id).value])), nums: document.getElementById('gNums').checked, grid: document.getElementById('gGrid').checked})"

async def ready(page):
    await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
    await page.wait_for_timeout(300)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await ready(page)
        await page.evaluate("async () => { await __inkwell.newPage(); }")

        # first time ever: the usual defaults
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(200)
        r = await page.evaluate(READ)
        check(r['type'] == 'q1' and r['v']['gX1'] == '10' and r['v']['gLx'] == 'x', f'first time: usual defaults ({r})')
        # type in our own graph
        await page.click('#gType button[data-v="q4"]')
        for k, v in VALUES.items(): await page.fill('#' + k, v)
        if not await page.is_checked('#gGrid'): await page.click('#gGrid')
        await page.click('#gInsert'); await page.wait_for_timeout(500)

        # restart the app
        await page.evaluate("() => __inkwell.flushSaves()")
        await page.reload(); await page.wait_for_timeout(1500); await ready(page)
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(300)
        r = await page.evaluate(READ)
        check(r['type'] == 'q4', f'after a restart: the graph type is remembered ({r["type"]})')
        check(r['v'] == {**{k: v for k, v in VALUES.items()}}, f'axis names, ranges, steps and function are remembered ({r["v"]})')
        check(r['grid'] and r['nums'], f'numbers and grid are remembered ({r["nums"]}, {r["grid"]})')
        # inserting with the remembered values works
        n0 = await page.evaluate("() => __inkwell.cur.items.size")
        await page.click('#gInsert'); await page.wait_for_timeout(500)
        n1 = await page.evaluate("() => __inkwell.cur.items.size")
        check(n1 > n0, f'inserting the remembered graph works ({n0} -> {n1})')
        # picking another type still gives its usual ranges, and that is remembered too
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(200)
        await page.click('#gType button[data-v="q1"]'); await page.wait_for_timeout(600)
        r = await page.evaluate(READ)
        check(r['v']['gX0'] == '0' and r['v']['gX1'] == '10' and r['v']['gLx'] == 't' and r['v']['gFn'] == '0.5*x-3', f'another type puts its usual ranges in, names and function stay ({r["v"]})')
        await page.keyboard.press('Escape')
        await page.evaluate("() => document.querySelectorAll('.modal').forEach(m => m.hidden = true)")
        await page.reload(); await page.wait_for_timeout(1500); await ready(page)
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(300)
        r = await page.evaluate(READ)
        check(r['type'] == 'q1' and r['v']['gX1'] == '10', f'the last change is remembered even without inserting ({r["type"]}, {r["v"]["gX1"]})')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
