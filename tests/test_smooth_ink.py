# 1.47: ink follows smooth curves between the recorded Pencil points (fast writing gave corners before).
# Rendering only: stored points unchanged. Checks on a coarse circle (12 points, like fast writing): the outline has
# no sharp bends, it stays on the circle (no overshoot), ends stay where the pen touched, slow (dense) strokes and
# tiny dots are unchanged, a written stroke saves the same points as before, and export/live drawing still work.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SHAPE = """(it) => { const s = __inkwell.strokeShape(it); return [s.xs, s.ys, s.rs]; }"""
def max_turn(xs, ys):
    worst = 0
    for i in range(1, len(xs) - 1):
        a = math.atan2(ys[i] - ys[i-1], xs[i] - xs[i-1]); b = math.atan2(ys[i+1] - ys[i], xs[i+1] - xs[i])
        d = abs((b - a + math.pi) % (2 * math.pi) - math.pi)
        if math.hypot(xs[i] - xs[i-1], ys[i] - ys[i-1]) > 1e-6 and math.hypot(xs[i+1] - xs[i], ys[i+1] - ys[i]) > 1e-6: worst = max(worst, d)
    return math.degrees(worst)

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

        # coarse circle: 13 points 30 degrees apart, radius 40 (fast writing)
        pts = []
        for k in range(13):
            a = math.radians(30 * k); pts += [100 + 40 * math.cos(a), 100 + 40 * math.sin(a), 0.5]
        it = {'t': 's', 'id': 'sx', 'c': 'auto', 'w': 3, 'hl': False, 'p': pts}
        xs, ys, rs = await page.evaluate(SHAPE, it)
        raw_turn = 30.0
        t = max_turn(xs, ys)
        check(len(xs) > 13 * 3, f'curve points are added between the recorded points ({len(xs)} from 13)')
        check(t < raw_turn / 2.5, f'no sharp bends on a fast curve (largest bend {t:.1f} deg, was {raw_turn:.0f})')
        dev = max(abs(math.hypot(x - 100, y - 100) - 40) for x, y in zip(xs, ys))
        check(dev < 2.5, f'the smooth line stays on the circle (off by at most {dev:.2f}, radius 40)')
        check(abs(xs[0] - pts[0]) < 1e-6 and abs(ys[0] - pts[1]) < 1e-6 and abs(xs[-1] - pts[-3]) < 1e-6 and abs(ys[-1] - pts[-2]) < 1e-6, 'start and end stay where the pen touched')
        check(all(r > 0 for r in rs) and all(math.isfinite(v) for v in xs + ys + rs), 'all widths positive, no broken numbers')
        # slow stroke (points < 1 px apart) is not changed
        slow = []
        for k in range(60): slow += [10 + 0.5 * k, 20 + 0.2 * k, 0.5]
        sx, sy, _ = await page.evaluate(SHAPE, {'t': 's', 'id': 's2', 'c': 'auto', 'w': 3, 'hl': False, 'p': slow})
        check(len(sx) == 60, f'slow, dense strokes keep their points ({len(sx)})')
        # repeated points and a dot
        dup = [50, 50, 0.5] * 4 + [80, 50, 0.5] * 3
        dx, dy, _ = await page.evaluate(SHAPE, {'t': 's', 'id': 's3', 'c': 'auto', 'w': 3, 'hl': False, 'p': dup})
        check(all(math.isfinite(v) for v in dx + dy), 'repeated points give no broken numbers')
        dot = await page.evaluate("() => __inkwell.strokePath({t: 's', id: 'd', c: 'auto', w: 3, hl: false, p: [5, 5, 0.5, 5.1, 5.1, 0.5]}, true)")
        check(dot.startswith('M') and 'NaN' not in dot, 'a dot still draws as a round dot')
        svg = await page.evaluate("(it) => __inkwell.strokePath(it, true)", it)
        check('NaN' not in svg and svg.endswith('Z'), 'outline for PDF export is valid')

        # write a fast stroke with the mouse: stored points are the recorded ones, not the extra curve points
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); }"); await page.wait_for_timeout(400)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        await page.mouse.move(st[0] + 60, st[1]); await page.mouse.down()
        for k in range(1, 13):
            a = math.radians(30 * k); await page.mouse.move(st[0] + 60 * math.cos(a), st[1] + 60 * math.sin(a))
        await page.mouse.up(); await page.wait_for_timeout(300)
        n = await page.evaluate("(() => { const s = [...__inkwell.cur.items.values()].filter(i => i.t === 's'); return s.length ? s[0].p.length / 3 : 0; })()")
        check(0 < n <= 14, f'the saved stroke has only the recorded points ({n})')
        await page.evaluate("() => __inkwell.flushSaves()"); await page.reload(); await page.wait_for_timeout(3000)
        n2 = await page.evaluate("(() => { const s = [...__inkwell.cur.items.values()].filter(i => i.t === 's'); return s.length ? s[0].p.length / 3 : 0; })()")
        check(n2 == n, f'same after a reload ({n2})')
        # the ink is drawn on screen (pixels under the circle)
        shot = await page.screenshot(clip={'x': st[0] - 70, 'y': st[1] - 70, 'width': 140, 'height': 140})
        from PIL import Image; import io
        im = Image.open(io.BytesIO(shot)).convert('L')
        dark = sum(1 for v in im.get_flattened_data() if v < 100)
        check(dark > 150, f'the stroke shows on screen ({dark} dark pixels)')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
