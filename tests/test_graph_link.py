# 2.6 (Rafael: "add a button that syncs horizontal from and to and vertical from and to so I only have to change one").
# Same from / to switch in the graph window: on copies horizontal to vertical, typing in one side changes the other,
# steps stay separate, off stops it, remembered after a restart, the inserted graph uses the synced range.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
V = "() => Object.fromEntries(['gX0','gX1','gXs','gY0','gY1','gYs'].map(id => [id, document.getElementById(id).value]))"

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
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(200)
        check(await page.is_visible('#gLink'), 'switch shown for 2D graphs')
        check(await page.get_attribute('#gLink', 'aria-pressed') == 'false', 'off by default')
        # off: no syncing
        await page.fill('#gX1', '30')
        v = await page.evaluate(V); check(v['gY1'] == '10', f'off: vertical to unchanged ({v})')
        # turn on: horizontal copied to vertical
        await page.fill('#gX0', '-3')
        await page.click('#gLink')
        v = await page.evaluate(V)
        check(await page.get_attribute('#gLink', 'aria-pressed') == 'true', 'on after tap')
        check(v['gY0'] == '-3' and v['gY1'] == '30', f'on: horizontal range copied to vertical ({v})')
        # type in horizontal → vertical follows; type in vertical → horizontal follows; steps separate
        await page.fill('#gX1', '12')
        v = await page.evaluate(V); check(v['gY1'] == '12', f'horizontal to → vertical to ({v})')
        await page.locator('#gY0').fill('')
        await page.locator('#gY0').type('-8')
        v = await page.evaluate(V); check(v['gX0'] == '-8', f'vertical from → horizontal from ({v})')
        await page.fill('#gXs', '2')
        v = await page.evaluate(V); check(v['gYs'] == '1', f'steps stay separate ({v})')
        # hover tip entry exists
        check(await page.evaluate("TIP_TEXT.some(t => t[0] === '#gLink')"), 'hover tip entry')
        # 4 quadrants: one number sets all four (typed box stays as typed)
        await page.click('#gType button[data-v="q4"]')
        await page.locator('#gY1').fill(''); await page.locator('#gY1').type('8')
        v = await page.evaluate(V); check((v['gX0'], v['gX1'], v['gY0'], v['gY1']) == ('-8', '8', '-8', '8'), f'q4: vertical to 8 -> all four ({v})')
        await page.locator('#gX0').fill(''); await page.locator('#gX0').type('-2,5')
        v = await page.evaluate(V); check((v['gX0'], v['gX1'], v['gY0'], v['gY1']) == ('-2,5', '2,5', '-2,5', '2,5'), f'q4: horizontal from -2,5 -> all four ({v})')
        await page.locator('#gY0').fill(''); await page.locator('#gY0').type('-')
        v = await page.evaluate(V); check(v['gX1'] == '2,5' and v['gY1'] == '2,5', f'q4: lone minus while typing changes nothing ({v})')
        await page.locator('#gY0').type('3')
        v = await page.evaluate(V); check((v['gX0'], v['gX1'], v['gY0'], v['gY1']) == ('-3', '3', '-3', '3'), f'q4: -3 -> all four ({v})')
        await page.click('#gLink'); await page.fill('#gX1', '9'); await page.click('#gLink')
        v = await page.evaluate(V); check((v['gX0'], v['gX1'], v['gY0'], v['gY1']) == ('-9', '9', '-9', '9'), f'q4: turning on mirrors horizontal to ({v})')
        # 3D hides it
        await page.click('#gType button[data-v="3d"]')
        check(not await page.is_visible('#gLink'), 'hidden for 3D graphs')
        await page.click('#gType button[data-v="q1"]')
        await page.fill('#gX1', '6')
        v = await page.evaluate(V); check(v['gY1'] == '6', f'still synced after changing type ({v})')
        # insert: axes use the synced range
        await page.click('#gInsert'); await page.wait_for_timeout(300)
        ga = await page.evaluate("() => [...__inkwell.cur.items.values()].filter(it => it.ga).map(it => it.ga)")
        check(len(ga) == 2 and all(g['v0'] == 0 and g['v1'] == 6 for g in ga), f'inserted graph uses 0..6 both ways ({ga})')
        # remembered after reload
        await page.wait_for_timeout(600)
        await page.reload(); await ready(page)
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(200)
        check(await page.get_attribute('#gLink', 'aria-pressed') == 'true', 'remembered after restart')
        # turn off: stops syncing
        await page.click('#gLink')
        await page.fill('#gX1', '50')
        v = await page.evaluate(V); check(v['gY1'] != '50', f'off again: no syncing ({v})')
        check(not errs, f'no page errors ({errs})')
        await b.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED'); raise SystemExit(1 if fails else 0)
asyncio.run(main())
