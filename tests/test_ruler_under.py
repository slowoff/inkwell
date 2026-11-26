# 2.9: no ink under the ruler / set square; a stroke that runs under it stops at its edge (edges still draw);
# holding the Pencil on the set square's degree scale puts one pen dot just outside the edge at that angle
# (numbers -> nearest 10 deg, both rows share the tick; tick marks -> nearest 1 deg).
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

ITEMS = "[...__inkwell.cur.items.values()].filter(i => i.t === 's').map(i => ({w: i.w, p: Array.from(typeof i.p === 'string' ? InkGeo.decode(i.p) : i.p)}))"

async def boot(page):
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await boot(page)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); const r = __inkwell.prefs.ruler; r.on = true; r.k = 'g'; r.a = 0; centerRuler(true); renderRuler(); }")
        await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.left, b.top]; })()")
        r = await page.evaluate("({...__inkwell.prefs.ruler})")
        cx, cy = st[0] + r['cx'], st[1] + r['cy']
        # local (lx, ly) of the set square -> page coordinates (angle 0)
        L = lambda lx, ly: (cx + lx, cy + ly)

        async def pen(pts, hold=0):
            await page.evaluate("""([pts, hold]) => new Promise(done => { const el = document.getElementById('stage');
              const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {pointerId: 9, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, pressure: .5, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1}));
              fire('pointerdown', pts[0][0], pts[0][1]); for(const [x, y] of pts.slice(1)) fire('pointermove', x, y);
              setTimeout(() => { const q = pts.at(-1); fire('pointerup', q[0], q[1]); done(); }, hold); })""", [pts, hold])
            await page.wait_for_timeout(200)
            return await page.evaluate(ITEMS)

        n0 = len(await page.evaluate(ITEMS))
        s = await pen([L(-40 + i * 4, -60 + (i % 3) * 3) for i in range(20)])
        check(len(s) == n0, f'writing inside the set square leaves no ink ({len(s) - n0} strokes)')
        s = await pen([L(-40, -120)], hold=900)
        check(len(s) == n0 and not await page.evaluate("!!document.querySelector('.wheel:not([hidden])')"), 'holding inside (off the scale): no dot, no Pencil menu')

        # a stroke from the left, outside, into the triangle: kept only up to the edge
        z = await page.evaluate("__inkwell.cam.z")
        s = await pen([L(-260 + i * 10, -150) for i in range(30)])
        if len(s) == n0 + 1:
            pts = s[-1]['p']; xs = pts[0::3]
            # the left leg crosses y = -150 at lx = -150; the last kept point must be left of it (in world px)
            wcx = await page.evaluate(f"__inkwell.toWorld ? __inkwell.toWorld({r['cx']} - 150, {r['cy']} - 150)[0] : null")
            if wcx is None: wcx = await page.evaluate(f"toWorld({r['cx']} - 150, {r['cy']} - 150)[0]")
            check(max(xs) <= wcx + 0.5, f'stroke into the set square stops at its edge (last x {max(xs):.1f} vs edge {wcx:.1f})')
        else: check(False, f'stroke from outside was kept ({len(s) - n0} new)')
        n1 = len(s)
        # edge drawing still works
        s = await pen([L(-150 + i * 10, 8 + (i % 2) * 4) for i in range(30)])
        check(len(s) == n1 + 1 and max(s[-1]['p'][1::3]) - min(s[-1]['p'][1::3]) < 0.5, 'drawing along the long edge still works')
        n1 = len(s)

        async def dot_at(lx, ly):
            s = await pen([L(lx, ly)], hold=700)
            if len(s) != dot_at.n + 1: return None
            dot_at.n = len(s)
            P = s[-1]['p']
            w0 = await page.evaluate(f"toWorld({r['cx']}, {r['cy']})")
            dx, dy = P[0] - w0[0], P[1] - w0[1]
            return math.degrees(math.atan2(-dy, dx)), math.hypot(dx, dy), len(P), s[-1]['w']
        dot_at.n = n1
        R = 186
        # on the number 30 (outer row, radius R-9) and its partner 150 (inner row, R-21) at the 30 deg tick
        a = math.radians(31)
        d = await dot_at((R - 9) * math.cos(a), -(R - 9) * math.sin(a))
        geoH = 300
        def outside(deg, dist): t = math.radians(deg); return dist * z > geoH / (abs(math.cos(t)) + abs(math.sin(t)))
        check(d and abs(d[0] - 30) < 0.3 and outside(d[0], d[1]) and d[2] == 3, f'hold on "30": one dot at 30 deg, outside the edge ({d})')
        a = math.radians(29)
        d = await dot_at((R - 21) * math.cos(a), -(R - 21) * math.sin(a))
        check(d and abs(d[0] - 30) < 0.3, f'hold on "150" (inner row, same tick): dot at 30 deg ({d and d[0]})')
        a = math.radians(47.2)
        d = await dot_at((R + 6) * math.cos(a), -(R + 6) * math.sin(a))
        check(d and abs(d[0] - 47) < 0.3 and outside(d[0], d[1]), f'hold on the tick marks: nearest degree, 47 ({d and d[0]})')
        a = math.radians(124)
        d = await dot_at((R + 6) * math.cos(a), -(R + 6) * math.sin(a))
        check(d and abs(d[0] - 124) < 0.3 and outside(d[0], d[1]), f'left half too: 124 deg ({d and d[0]})')
        # a short tap on the scale (no hold) does nothing
        n = dot_at.n
        s = await pen([L(R * math.cos(math.radians(60)), -R * math.sin(math.radians(60)))], hold=80)
        check(len(s) == n, 'a short tap on the scale makes no dot')

        # the straight ruler: a stroke across its middle is cut too
        await page.evaluate("() => { const r = __inkwell.prefs.ruler; delete r.k; centerRuler(true); renderRuler(); }")
        await page.wait_for_timeout(200)
        r = await page.evaluate("({...__inkwell.prefs.ruler})")
        cx, cy = st[0] + r['cx'], st[1] + r['cy']
        n = len(await page.evaluate(ITEMS))
        s = await pen([(cx + 100, cy - 120 + i * 8) for i in range(30)])
        if len(s) == n + 1:
            ys = s[-1]['p'][1::3]
            wtop = await page.evaluate(f"toWorld(0, {r['cy']} - 38)[1]")
            check(max(ys) <= wtop + 0.5, f'stroke into the ruler stops at its edge ({max(ys):.1f} vs {wtop:.1f})')
        else: check(False, 'stroke above the ruler kept')
        check(not errs, f'no page errors ({errs[:2]})')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
