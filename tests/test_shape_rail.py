# 1.92 (Rafael, iPad screenshot with the toolbar on the left: "compress the colors so u can fit add shape to the main bar
# as i use it alot"): with the toolbar on the side, a Shapes button (#shapeRail) sits at the foot of the column next to
# the zoom, and the colours are three to a row. Checks for left and right: the button shows and sits on the zoom's row
# (also with the widest zoom text + icon), it opens the Shapes menu beside the column and closes it again, the menu
# re-places from it when Grid opens, a shape can be drawn from it; colours are three to a row inside the column, don't
# overlap, and still pick a colour; the column is shorter than before for the pen. Top layout: no extra button.
import asyncio, os, json
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
BOX = "s => { const e = document.querySelector(s); if(!e || e.hidden || e.closest('[hidden]') || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return {l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height}; }"

async def run(b, side):
    ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
    await ctx.add_init_script("if(!sessionStorage.t){ sessionStorage.t = 1; localStorage.setItem('inkwell.prefs', JSON.stringify({barPos: '%s'})); }" % side)
    await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(URL)
    await pg.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await pg.wait_for_timeout(2500)
    await pg.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
    if side == 'top':
        check(await pg.evaluate(BOX, '#shapeRail') is None, 'top: no extra Shapes button in the tool bar')
        check(await pg.evaluate(BOX, '#shapeBtn') is not None, 'top: Shapes still in the top bar')
        await ctx.close(); return errs
    await pg.evaluate("__inkwell.setTool('pen')"); await pg.wait_for_timeout(200)
    col = await pg.evaluate(BOX, '#toolbar')
    sr = await pg.evaluate(BOX, '#shapeRail'); z = await pg.evaluate(BOX, '#zoomBtn')
    check(sr is not None and sr['w'] >= 44 and sr['h'] >= 44, f'{side}: Shapes button in the column, 44 px ({sr})')
    check(sr and z and abs(sr['t'] - z['t']) < 1 and sr['r'] <= z['l'] + 1, f'{side}: on the zoom row, left of it ({sr}, {z})')
    check(sr and z and sr['l'] >= col['l'] and z['r'] <= col['r'], f'{side}: inside the column ({col})')
    # widest zoom read-out: four digits' worth plus the max-zoom arrow
    await pg.evaluate("() => { document.getElementById('zoomPct').textContent = '800%'; document.querySelector('#zoomBtn .zb-max').removeAttribute('hidden'); }")
    await pg.wait_for_timeout(100)
    sr2 = await pg.evaluate(BOX, '#shapeRail'); z2 = await pg.evaluate(BOX, '#zoomBtn')
    fits = await pg.evaluate("() => { const b = document.getElementById('zoomBtn'); return b.scrollWidth <= b.clientWidth + 1; }")
    check(abs(sr2['t'] - z2['t']) < 1 and fits, f'{side}: "800%" + arrow still fits beside it ({sr2}, {z2}, fits {fits})')
    await pg.evaluate("() => { document.querySelector('#zoomBtn .zb-max').setAttribute('hidden', ''); }")
    # colours
    sw = await pg.evaluate("() => [...document.querySelectorAll('#swatches .swatch')].map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })")
    rows = sorted(set(round(s[1]) for s in sw))
    check(len(sw) == 6 and len(rows) == 2, f'{side}: 6 colours in 2 rows ({rows})')
    check(all(s[0] >= col['l'] and s[2] <= col['r'] for s in sw), f'{side}: colours inside the column')
    over = any(a is not b and a[0] < b[2] - .5 and b[0] < a[2] - .5 and a[1] < b[3] - .5 and b[1] < a[3] - .5 for a in sw for b in sw)
    check(not over, f'{side}: colours do not overlap')
    first = await pg.evaluate("() => { const e = document.querySelector('#swatches .swatch'); const r = e.getBoundingClientRect(); return [r.left, r.right]; }")
    edge = (first[0] - col['l']) if side == 'left' else (col['r'] - first[1])
    check(edge < 16, f'{side}: first colour by the outer edge ({edge:.0f} px)')
    c3 = await pg.evaluate("() => __inkwell.prefs.penFavs[2]")
    await pg.locator('#swatches .swatch').nth(2).tap(); await pg.wait_for_timeout(200)
    check(await pg.evaluate("() => __inkwell.prefs.pen.c") == c3 and await pg.evaluate("() => document.querySelectorAll('#swatches .swatch')[2].classList.contains('on')"), f'{side}: tapping the third colour picks it')
    await pg.evaluate("() => { const e = document.querySelectorAll('#swatches .swatch')[0]; e.click(); }")
    hl = await pg.evaluate("() => __inkwell.setTool('hl')"); await pg.wait_for_timeout(200)
    hs = await pg.evaluate("() => [...document.querySelectorAll('#swatches .swatch')].map(e => { const r = e.getBoundingClientRect(), s = e.firstElementChild.getBoundingClientRect(); return [r.left, r.right, s.left, s.right]; })")
    check(hs and all(h[2] >= h[0] - .5 and h[3] <= h[1] + .5 for h in hs), f'{side}: highlighter colours fit their buttons')
    await pg.evaluate("__inkwell.setTool('pen')"); await pg.wait_for_timeout(200)
    # menu
    await pg.tap('#shapeRail'); await pg.wait_for_timeout(300)
    pop = await pg.evaluate(BOX, '#shapePop')
    beside = pop and ((pop['l'] >= col['r'] - 1) if side == 'left' else (pop['r'] <= col['l'] + 1))
    check(pop is not None and beside, f'{side}: Shapes menu opens beside the column ({pop})')
    check(pop and pop['b'] <= 820 and pop['t'] >= 0, f'{side}: menu on screen')
    check(await pg.evaluate("document.getElementById('shapeRail').classList.contains('pop-open')"), f'{side}: button shows the menu is open')
    await pg.tap('#gridOpen'); await pg.wait_for_timeout(300)
    pop2 = await pg.evaluate(BOX, '#shapePop')
    beside2 = pop2 and ((pop2['l'] >= col['r'] - 1) if side == 'left' else (pop2['r'] <= col['l'] + 1))
    check(pop2 is not None and beside2 and pop2['b'] <= 821, f'{side}: after Grid opens the menu is still beside the column ({pop2})')
    await pg.tap('#shapeRail'); await pg.wait_for_timeout(300)
    check(await pg.evaluate(BOX, '#shapePop') is None, f'{side}: tapping it again closes the menu')
    # draw a rectangle from it
    n0 = await pg.evaluate("() => __inkwell.cur.items.size")
    await pg.tap('#shapeRail'); await pg.wait_for_timeout(300)
    await pg.locator('#shapeGrid button[data-shape]').first.tap(); await pg.wait_for_timeout(300)
    st = await pg.evaluate(BOX, '#stage')
    x0, y0 = st['l'] + st['w'] * .4, st['t'] + st['h'] * .4
    await pg.mouse.move(x0, y0); await pg.mouse.down(); await pg.mouse.move(x0 + 120, y0 + 80, steps=8); await pg.mouse.up(); await pg.wait_for_timeout(400)
    n1 = await pg.evaluate("() => __inkwell.cur.items.size")
    check(n1 > n0, f'{side}: a shape picked from it lands on the page ({n0} -> {n1})')
    await ctx.close()
    return errs

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        errs = []
        for side in ('left', 'right', 'top'): errs += await run(b, side)
        check(not errs, f'no page errors {errs[:3]}')
        await b.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)
asyncio.run(main())
