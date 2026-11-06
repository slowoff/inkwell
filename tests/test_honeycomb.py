# 1.90: Shapes -> Honeycomb: rows and columns, then drag a box or tap. Regular hexagons, each edge once, one group, one undo.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
READ = """() => { const W = __inkwell; return {z: W.cam.z, ox: W.cam.ox, oy: W.cam.oy, tool: W.prefs.tool, sel: W.sel ? W.sel.ids.length : 0,
  s: [...W.cur.items.values()].filter(i => i.t === 's').map(i => ({g: i.g || null, p: Array.from(i.p)})) }; }"""
def analyse(r):
    pts = []
    for s in r['s']:
        P = s['p']; pts += [(P[i], P[i + 1]) for i in range(0, len(P), 3)]
    xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
    return min(xs), min(ys), max(xs), max(ys), pts
async def openmenu(page):
    await page.click('#shapeBtn'); await page.wait_for_selector('#shapePop', state='visible')
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); }"); await page.wait_for_timeout(400)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        await openmenu(page)
        check(await page.is_visible('#hcOpen') and await page.is_hidden('#hcPanel'), 'Honeycomb in Shapes, sizes folded')
        await page.click('#hcOpen'); await page.wait_for_timeout(100)
        check(await page.is_visible('#hcDraw'), 'pressing it shows rows, columns and Draw')
        fit = await page.evaluate("(() => { const r = document.getElementById('shapePop').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })()")
        check(fit, 'menu fits on screen')
        await page.click('#hcSteps .stepper[data-k="r"] button[data-d="1"]')       # 4 rows
        await page.click('#hcSteps .stepper[data-k="c"] button[data-d="-1"]')      # 3 columns
        check(await page.inner_text('#hcSize') == '4 × 3', 'steppers change the size')
        await page.screenshot(path=os.environ.get('SHOT_DIR', '/tmp') + '/hc_menu.png') if os.environ.get('SHOT_DIR') else None
        await page.click('#hcDraw'); await page.wait_for_timeout(100)
        x0, y0, x1, y1 = st[0] + 60, st[1] + 60, st[0] + 460, st[1] + 560
        await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, steps=6); await page.wait_for_timeout(60)
        await page.mouse.up(); await page.wait_for_timeout(200)
        r = await page.evaluate(READ)
        groups = {s['g'] for s in r['s']}
        check(len(r['s']) >= 1 and len(groups) == 1 and None not in groups or len(r['s']) == 1, f"one group ({len(r['s'])} strokes)")
        check(r['sel'] == len(r['s']) and r['tool'] == 'lasso', 'selected afterwards, like other shapes')
        L, T, R, B, pts = analyse(r)
        # 4 rows x 3 columns: width (3.5) * sqrt3 * s, height (1.5 * 4 + .5) * s
        s = (B - T) / 6.5
        w = 3.5 * math.sqrt(3) * s
        check(abs((R - L) - w) < 3, f'regular hexagons: width fits height ({R - L:.1f} vs {w:.1f})')
        bx0, by0, bx1, by1 = [(x0 - st[0] - r['ox']), (y0 - st[1] - r['oy']), (x1 - st[0] - r['ox']), (y1 - st[1] - r['oy'])]
        check(L >= bx0 - 1 and R <= bx1 + 1 and T >= by0 - 1 and B <= by1 + 1, 'stays inside the box')
        check(min(bx1 - R + (L - bx0), by1 - B + (T - by0)) < 3 and abs((L - bx0) - (bx1 - R)) < 3, 'as big as fits, centred')
        # every point lies on one of the 4x3 honeycomb's edges, and edges are drawn once
        total = sum(math.hypot(q[0] - a[0], q[1] - a[1]) for st_ in r['s'] for q, a in [((st_['p'][i], st_['p'][i + 1]), (st_['p'][i - 3], st_['p'][i - 2])) for i in range(3, len(st_['p']), 3)])
        # edges of 12 hexagons in this layout: count by cell
        cells = {(r_, c) for r_ in range(4) for c in range(3)}
        E = set()
        for r_, c in cells:
            x = 2 * c + (r_ & 1); y = 3 * r_
            P = [(x + 1, y), (x + 2, y + 1), (x + 2, y + 3), (x + 1, y + 4), (x, y + 3), (x, y + 1)]
            for i in range(6): E.add(tuple(sorted((P[i], P[(i + 1) % 6]))))
        check(abs(total - len(E) * s) < 0.02 * len(E) * s, f'each edge drawn once ({total:.0f} vs {len(E) * s:.0f}, {len(E)} edges in {len(r["s"])} strokes)')
        check(len(r['s']) < len(E) / 2, 'joined into long strokes')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(100)
        check(not (await page.evaluate(READ))['s'], 'one undo removes all of it')
        # tap = standard size
        await openmenu(page)
        check(await page.is_hidden('#hcPanel'), 'folded again on reopen')
        await page.click('#hcOpen'); await page.click('#hcDraw'); await page.wait_for_timeout(80)
        cx, cy = st[0] + 300, st[1] + 300
        await page.mouse.click(cx, cy); await page.wait_for_timeout(200)
        r = await page.evaluate(READ); L, T, R, B, _ = analyse(r)
        check(r['s'] and abs((L + R) / 2 + r['ox'] - (cx - st[0])) < 3 and abs((T + B) / 2 + r['oy'] - (cy - st[1])) < 3 and abs((B - T) - 6.5 * 22) < 3, f'tap: standard size around the tap ({B - T:.0f})')
        await page.evaluate("__inkwell.flushSaves()"); await page.wait_for_timeout(300)
        await page.reload(); await page.wait_for_timeout(3000); await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await openmenu(page)
        check(await page.inner_text('#hcSize') == '4 × 3', 'size remembered after reload')
        check(await page.inner_text('#gridSize') == '3 × 4', 'Grid size untouched')
        await page.evaluate("document.getElementById('shapePop').hidden = true")
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)
asyncio.run(main())
