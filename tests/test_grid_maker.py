# 1.69: Shapes -> Grid. Rows/columns steppers (prefs.grid, remembered), drag a box = grid split into r x c,
# tap = standard cells of 56 x 36 screen px, one group, one undo step, saved, popover fits. Guest mode.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

STROKES = """() => { const W = __inkwell; return {z: W.cam.z, ox: W.cam.ox, oy: W.cam.oy, tool: W.prefs.tool,
  sel: W.sel ? W.sel.ids.length : 0,
  s: [...W.cur.items.values()].filter(i => i.t === 's').map(i => ({id: i.id, g: i.g || null, p: Array.from(i.p)})) }; }"""

def boxes(r, ids=None):
    out = []
    for s in r['s']:
        if ids is not None and s['id'] not in ids: continue
        P = s['p']; xs = [P[i] * r['z'] + r['ox'] for i in range(0, len(P), 3)]; ys = [P[i + 1] * r['z'] + r['oy'] for i in range(0, len(P), 3)]
        out.append((min(xs), min(ys), max(xs), max(ys)))
    return out

async def tap_step(page, k, d, n=1):
    for _ in range(n):
        await page.click(f'.stepper[data-k="{k}"] button[data-d="{d}"]')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        cx, cy = st[0] + st[2] / 2, st[1] + st[3] / 2

        # 1. popover: Grid button and steppers, default 3 x 4
        await page.click('#shapeBtn'); await page.wait_for_selector('#gridOpen', state='visible')
        t = await page.evaluate("[gridSize.textContent, gridR.textContent, gridC.textContent]")
        check(t == ['3 × 4', '3', '4'], f'default 3 × 4 ({t})')
        lay = await page.evaluate("""(() => { const p = document.getElementById('shapePop').getBoundingClientRect(), g = document.getElementById('shapeGrid').getBoundingClientRect();
          const els = [...document.querySelectorAll('#gridSteps button, #gridSteps b, #gridOpen')].map(e => e.getBoundingClientRect());
          return {inside: els.every(r => r.left >= p.left - 0.5 && r.right <= p.right + 0.5), wider: p.width - (g.width + 20), bottom: p.bottom, vh: innerHeight}; })()""")
        check(lay['inside'], 'grid controls fit inside the popover')
        check(abs(lay['wider']) < 2, f"popover not made wider by the grid row ({lay['wider']:.1f})")
        check(lay['bottom'] <= lay['vh'], 'popover fits on screen')

        # 2. steppers: 2 rows, 5 columns; minus disabled at 1
        await tap_step(page, 'r', '-1'); await tap_step(page, 'c', '1')
        t = await page.evaluate("[gridSize.textContent, gridR.textContent, gridC.textContent, __inkwell.prefs.grid]")
        check(t[:3] == ['2 × 5', '2', '5'] and t[3] == {'r': 2, 'c': 5}, f'steppers change rows/columns ({t})')
        check(await page.is_visible('#shapePop'), 'popover stays open while stepping')
        await tap_step(page, 'r', '-1')
        dis = await page.evaluate("document.querySelector('.stepper[data-k=r] [data-d=\"-1\"]').disabled")
        check(dis, 'minus disabled at 1 row')
        await tap_step(page, 'r', '1')

        # 3. drag a box 300 x 120 -> frame + 1 row line + 4 column lines, grouped, selected
        await page.click('#gridOpen'); await page.wait_for_timeout(100)
        check(not await page.is_visible('#shapePop'), 'popover closes when Grid is picked')
        x0, y0 = cx - 150, cy - 60
        await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x0 + 300, y0 + 120, steps=8); await page.mouse.up()
        await page.wait_for_timeout(250)
        r = await page.evaluate(STROKES)
        check(len(r['s']) == 6, f"6 strokes (frame + 1 + 4) ({len(r['s'])})")
        gs = set(s['g'] for s in r['s'])
        check(len(gs) == 1 and None not in gs, 'all lines in one group')
        check(r['tool'] == 'lasso' and r['sel'] == 6, f"grid selected afterwards ({r['tool']}, {r['sel']})")
        bx = boxes(r)
        frame = max(bx, key=lambda q: (q[2] - q[0]) * (q[3] - q[1]))
        check(all(abs(a - e) < 1.5 for a, e in zip(frame, (x0 - st[0], y0 - st[1], x0 - st[0] + 300, y0 - st[1] + 120))), f'frame follows the drag ({[round(v) for v in frame]})')
        hz = sorted(q for q in bx if q is not frame and q[3] - q[1] < 2)
        vt = sorted(q for q in bx if q is not frame and q[2] - q[0] < 2)
        check(len(hz) == 1 and abs(hz[0][1] - (frame[1] + 60)) < 1, f'row line in the middle ({[round(q[1]) for q in hz]})')
        check(len(vt) == 4 and all(abs(q[0] - (frame[0] + 60 * (i + 1))) < 1 for i, q in enumerate(vt)), f'column lines every 60 px ({[round(q[0]) for q in vt]})')
        check(all(abs(q[0] - frame[0]) < 1 and abs(q[2] - frame[2]) < 1 for q in hz) and all(abs(q[1] - frame[1]) < 1 and abs(q[3] - frame[3]) < 1 for q in vt), 'inner lines run edge to edge')

        # 4. dragging up-left works the same
        await page.keyboard.press('Escape')
        await page.click('#shapeBtn'); await page.click('#gridOpen')
        await page.mouse.move(cx + 200, cy + 250); await page.mouse.down(); await page.mouse.move(cx + 50, cy + 150, steps=6); await page.mouse.up()
        await page.wait_for_timeout(250)
        r = await page.evaluate(STROKES)
        check(len(r['s']) == 12, f"second grid from a reversed drag ({len(r['s'])})")

        # 5. one undo removes the whole grid
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(150)
        r = await page.evaluate(STROKES)
        check(len(r['s']) == 6, f"one undo removes the whole grid ({len(r['s'])})")

        # 6. tap: standard cells 56 x 36 around the tap point (2 x 5 -> 280 x 72)
        await page.click('#shapeBtn'); await page.click('#gridOpen')
        tx, ty = cx - 250, cy + 220
        await page.mouse.click(tx, ty); await page.wait_for_timeout(250)
        r = await page.evaluate(STROKES)
        new = [s['id'] for s in r['s']][6:]
        bx = boxes(r, set(new))
        fr = max(bx, key=lambda q: (q[2] - q[0]) * (q[3] - q[1]))
        w, h = fr[2] - fr[0], fr[3] - fr[1]
        mx, my = (fr[0] + fr[2]) / 2 + st[0], (fr[1] + fr[3]) / 2 + st[1]
        check(len(new) == 6 and abs(w - 280) < 1.5 and abs(h - 72) < 1.5, f'tap = 2 × 5 cells of 56 × 36 ({len(new)}, {w:.1f} × {h:.1f})')
        check(abs(mx - tx) < 1.5 and abs(my - ty) < 1.5, 'tap grid centred on the tap')

        # 7. a 1 x 1 grid is just a rectangle
        await page.click('#shapeBtn')
        await tap_step(page, 'r', '-1'); await tap_step(page, 'c', '-1', 4)
        await page.click('#gridOpen')
        await page.mouse.move(cx + 250, cy - 250); await page.mouse.down(); await page.mouse.move(cx + 350, cy - 200, steps=4); await page.mouse.up()
        await page.wait_for_timeout(250)
        r = await page.evaluate(STROKES)
        check(len(r['s']) == 13, f"1 × 1 grid = one stroke ({len(r['s'])})")

        # 8. upper limit 30
        await page.click('#shapeBtn')
        await tap_step(page, 'c', '1', 29)
        t = await page.evaluate("[gridC.textContent, document.querySelector('.stepper[data-k=c] [data-d=\"1\"]').disabled]")
        check(t == ['30', True], f'columns stop at 30 ({t})')
        await page.keyboard.press('Escape'); await page.mouse.click(st[0] + 5, st[1] + st[3] - 5)

        # 9. saved with the page; choice remembered after reload; junk prefs fall back
        await page.evaluate("__inkwell.flushSaves()")
        pid = await page.evaluate("__inkwell.cur.id")
        saved = await page.evaluate("async id => { const d = await __inkwell.IDB.get('docs', 'c_' + id); return d && d.data.items.length; }", pid)
        check(saved == 13, f'grid strokes saved ({saved})')
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        t = await page.evaluate("gridSize.textContent")
        check(t == '1 × 30', f'rows/columns remembered after reload ({t})')
        await page.evaluate("__inkwell.prefs.grid = {r: 'x', c: 999}")
        await page.click('#shapeBtn')
        t = await page.evaluate("gridSize.textContent")
        check(t == '3 × 4', f'bad stored values fall back to 3 × 4 ({t})')
        check(not errs, 'no page errors: ' + '; '.join(errs[:3]))
        await ctx.close()

        # 10. touch: stepper buttons 44 px, popover still fits
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await page.click('#shapeBtn'); await page.wait_for_selector('#gridOpen', state='visible')
        lay = await page.evaluate("""(() => { const p = document.getElementById('shapePop').getBoundingClientRect();
          const bs = [...document.querySelectorAll('#gridSteps button')].map(e => e.getBoundingClientRect());
          return {min: Math.min(...bs.map(r => Math.min(r.width, r.height))), inside: bs.every(r => r.left >= p.left - 0.5 && r.right <= p.right + 0.5), bottom: p.bottom, vh: innerHeight}; })()""")
        check(lay['min'] >= 44, f"stepper buttons 44 px on touch ({lay['min']})")
        check(lay['inside'] and lay['bottom'] <= lay['vh'], 'touch popover fits')
        if os.environ.get('GRID_SHOT'): await page.screenshot(path=os.environ['GRID_SHOT'])
        await b.close()
    if fails: raise SystemExit(1)
    print('ALL OK')
asyncio.run(main())
