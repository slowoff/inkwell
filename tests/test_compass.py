# 1.39: Shapes -> Compass. Press on the centre, drag out to the radius; let go = full circle,
# go around first = arc of that angle (either direction). Tap = standard circle. Guest mode.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

LAST = """() => { const W = __inkwell, its = [...W.cur.items.values()].filter(i => i.t === 's'); const s = its[its.length - 1];
  return s ? {n: its.length, p: Array.from(s.p), z: W.cam.z, ox: W.cam.ox, oy: W.cam.oy, tool: W.prefs.tool, sel: W.sel && W.sel.ids.length} : {n: 0}; }"""

def analyse(r, cx_s, cy_s):
    z, ox, oy = r['z'], r['ox'], r['oy']
    cx, cy = (cx_s - ox) / z, (cy_s - oy) / z
    P = r['p']; pts = [(P[i], P[i + 1]) for i in range(0, len(P), 3)]
    rad = [math.hypot(x - cx, y - cy) for x, y in pts]
    angs = [math.atan2(y - cy, x - cx) for x, y in pts]
    tot = 0
    for a, b in zip(angs, angs[1:]):
        d = b - a
        if d > math.pi: d -= 2 * math.pi
        if d < -math.pi: d += 2 * math.pi
        tot += d
    return min(rad), max(rad), math.degrees(tot), z

async def compass(page):
    await page.click('#shapeBtn')
    await page.wait_for_selector('#compassOpen', state='visible')
    await page.click('#compassOpen')

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
        box = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
        scx, scy = cx - box[0], cy - box[1]

        # 1. drag straight out and let go: full circle, radius = drag length
        await compass(page)
        await page.mouse.move(cx, cy); await page.mouse.down()
        for i in range(1, 11): await page.mouse.move(cx + 12 * i, cy)
        await page.mouse.up(); await page.wait_for_timeout(200)
        r = await page.evaluate(LAST)
        check(r['n'] == 1, f"one stroke for a full circle ({r['n']})")
        lo, hi, sweep, z = analyse(r, scx, scy)
        check(abs(lo * z - 120) < 2 and abs(hi * z - 120) < 2, f'radius follows the drag ({lo * z:.1f}..{hi * z:.1f} px)')
        check(abs(abs(sweep) - 360) < 6, f'full circle ({sweep:.0f} deg)')
        check(r['tool'] == 'lasso' and r['sel'] == 1, 'circle is selected afterwards like other shapes')

        # 2. out, then a quarter turn clockwise: arc of about 90 deg
        await compass(page)
        await page.mouse.move(cx, cy); await page.mouse.down()
        for i in range(1, 11): await page.mouse.move(cx + 10 * i, cy)
        for k in range(1, 31):
            a = math.radians(90 * k / 30); await page.mouse.move(cx + 100 * math.cos(a), cy + 100 * math.sin(a))
        await page.mouse.up(); await page.wait_for_timeout(200)
        r = await page.evaluate(LAST)
        lo, hi, sweep, z = analyse(r, scx, scy)
        check(r['n'] == 2, f"arc added ({r['n']})")
        check(abs(sweep - 90) < 6, f'arc of about 90 deg ({sweep:.0f})')
        check(abs(lo * z - 100) < 2 and abs(hi * z - 100) < 2, f'arc radius ({lo * z:.1f}..{hi * z:.1f})')

        # 3. the other way round, 180 deg counter-clockwise
        await compass(page)
        await page.mouse.move(cx, cy); await page.mouse.down()
        for i in range(1, 9): await page.mouse.move(cx + 10 * i, cy)
        for k in range(1, 41):
            a = -math.radians(180 * k / 40); await page.mouse.move(cx + 80 * math.cos(a), cy + 80 * math.sin(a))
        await page.mouse.up(); await page.wait_for_timeout(200)
        r = await page.evaluate(LAST)
        lo, hi, sweep, z = analyse(r, scx, scy)
        check(abs(sweep + 180) < 8, f'counter-clockwise half circle ({sweep:.0f})')

        # 4. tap: standard circle around the tap point
        await compass(page)
        await page.mouse.click(cx - 200, cy)
        await page.wait_for_timeout(200)
        r = await page.evaluate(LAST)
        lo, hi, sweep, z = analyse(r, scx - 200, scy)
        check(r['n'] == 4 and abs(lo * z - 60) < 2 and abs(abs(sweep) - 360) < 6, f'tap = circle of 60 px ({lo * z:.1f}, {sweep:.0f} deg)')

        # 5. saved with the page, other shapes unchanged
        await page.evaluate("__inkwell.flushSaves()")
        pid = await page.evaluate("__inkwell.cur.id")
        saved = await page.evaluate("async id => { const d = await __inkwell.IDB.get('docs', 'c_' + id); return d && d.data.items.length; }", pid)
        check(saved == 4, f'compass strokes saved ({saved})')
        await page.click('#shapeBtn'); await page.click('#shapeGrid button[data-shape="rect"]')
        await page.mouse.move(cx - 100, cy + 100); await page.mouse.down(); await page.mouse.move(cx, cy + 160, steps=5); await page.mouse.up()
        await page.wait_for_timeout(200)
        n = await page.evaluate("[...__inkwell.cur.items.values()].length")
        check(n == 5, f'rectangle still works ({n})')
        check(not errs, 'no page errors: ' + '; '.join(errs[:3]))
        await b.close()
    if fails: raise SystemExit(1)
    print('ALL OK')
asyncio.run(main())
