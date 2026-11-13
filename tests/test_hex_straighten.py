# 1.89: Hex paper, "Straighten lines": straight strokes land on the corners of the honeycomb; curves and writing stay.
import asyncio, os, math, random
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
S = 40.0      # bond length in world px
W = math.sqrt(3) * S
def v(r, c, top=True):
    # corner of the hexagon in row r, column c: top corner, or (top=False) upper-right corner
    cx = c * W + (W / 2 if r & 1 else 0); cy = r * 1.5 * S
    return (cx, cy - S) if top else (cx + W / 2, cy - S / 2)
LAST = "() => { const a = [...__inkwell.cur.items.values()].filter(i => i.t === 's'); const s = a[a.length - 1]; return s ? {n: a.length, p: Array.from(s.p)} : {n: 0, p: []}; }"
def pts(p): return [(p[i], p[i + 1]) for i in range(0, len(p), 3)]
def near(q, t, e=0.6): return math.hypot(q[0] - t[0], q[1] - t[1]) <= e
def dev(P):
    (ax, ay), (bx, by) = P[0], P[-1]; L = math.hypot(bx - ax, by - ay) or 1
    return max(abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / L for x, y in P)
async def draw(page, world, wob=2.0, seed=3, step=7):
    rnd = random.Random(seed)
    st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(), c = __inkwell.cam; return [r.left, r.top, c.ox, c.oy, c.z]; })()")
    sc = lambda x, y: (st[0] + st[2] + x * st[4], st[1] + st[3] + y * st[4])
    path = []
    for (a, b) in zip(world, world[1:]):
        n = max(2, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        path += [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n)]
    path.append(world[-1])
    x, y = sc(*path[0]); await page.mouse.move(x, y); await page.mouse.down()
    for q in path[1:]:
        x, y = sc(q[0] + rnd.uniform(-wob, wob), q[1] + rnd.uniform(-wob, wob)); await page.mouse.move(x, y)
    await page.mouse.up(); await page.wait_for_timeout(120)
    return await page.evaluate(LAST)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 1000}, device_scale_factor=1)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); }"); await page.wait_for_timeout(300)
        await page.click('#paperBtn'); await page.wait_for_selector('#paperPop', state='visible')
        check(await page.is_hidden('#hexSnap'), 'switch hidden on other paper')
        await page.click('#paperType button[data-v="hex"]'); await page.wait_for_timeout(200)
        check(await page.is_visible('#hexSnap'), 'switch shows on Hex paper')
        check(not await page.evaluate("__inkwell.prefs.hexSnap"), 'off by default')
        await page.evaluate(f"""() => {{ const W = __inkwell; W.cur.bg = Object.assign({{}}, W.cur.bg, {{sy: {S}}}); W.cam.z = 1; W.cam.ox = 40; W.cam.oy = 40; W.invalidate(); }}""")
        A, B = v(2, 2), v(2, 2, False)
        # off: left as drawn
        await page.keyboard.press('Escape')
        await page.evaluate("document.getElementById('paperPop').hidden = true")
        r = await draw(page, [(A[0] + 3, A[1] + 3), (B[0] - 3, B[1] + 3)])
        check(dev(pts(r['p'])) > 0.5, 'off: stroke stays as drawn')
        await page.evaluate("document.getElementById('hexSnap').click()"); await page.wait_for_timeout(100)
        check(await page.evaluate("__inkwell.prefs.hexSnap === true"), 'switch turns it on')
        # one bond, a bit off the corners
        A, B = v(4, 2), v(4, 2, False)
        r = await draw(page, [(A[0] + 5, A[1] + 4), (B[0] - 4, B[1] + 5)])
        P = pts(r['p'])
        check(near(P[0], A) and near(P[-1], B) and dev(P) < 0.01, f'bond lands on two corners, dead straight ({P[0]}, {P[-1]}, want {A}, {B})')
        # (2.5) first undo brings back the stroke as drawn, redo straightens it again, two undos remove it
        n = r['n']; await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(100)
        u = await page.evaluate(LAST)
        check(u['n'] == n and dev(pts(u['p'])) > 0.5 and not near(pts(u['p'])[0], A), 'first undo: the stroke as drawn')
        sq = await page.evaluate("(() => { const a = [...__inkwell.cur.items.values()].filter(i => i.t === 's'); return !!a[a.length - 1].sq; })()")
        check(not sq, 'as drawn: no sharp corners flag')
        await page.evaluate("__inkwell.redo()"); await page.wait_for_timeout(100)
        u = await page.evaluate(LAST); check(near(pts(u['p'])[0], A) and dev(pts(u['p'])) < 0.01, 'redo: straight again')
        await page.evaluate("__inkwell.undo(); __inkwell.undo()"); await page.wait_for_timeout(100)
        check((await page.evaluate(LAST))['n'] == n - 1, 'second undo removes it')
        r = await draw(page, [(A[0] + 5, A[1] + 4), (B[0] - 4, B[1] + 5)])
        # second line along the same bond: straight but not on top of the first
        mx, my = (A[0] + B[0]) / 2, (A[1] + B[1]) / 2
        ux, uy = (B[0] - A[0]) / S, (B[1] - A[1]) / S; nx, ny = -uy, ux
        o = 0.2 * S
        r = await draw(page, [(A[0] + ux * 6 + nx * o, A[1] + uy * 6 + ny * o), (B[0] - ux * 6 + nx * o, B[1] - uy * 6 + ny * o)], wob=1)
        P = pts(r['p'])
        d = abs((P[len(P) // 2][0] - mx) * nx + (P[len(P) // 2][1] - my) * ny)
        check(dev(P) < 0.01 and d > 3, f'double bond: second line straight and beside the first (off by {d:.1f})')
        # zig-zag chain
        Z = [v(8, 1), v(8, 1, False), v(8, 2), v(8, 2, False), v(8, 3)]
        r = await draw(page, [(q[0] + 3, q[1] - 4) for q in Z])
        P = pts(r['p'])
        hit = all(any(near(q, z) for q in P) for z in Z)
        check(hit and near(P[0], Z[0]) and near(P[-1], Z[-1]), 'zig-zag chain: every corner on the honeycomb')
        # ring (one stroke round a hexagon)
        cx, cy = v(12, 5)[0], 12 * 1.5 * S
        ring = [(cx + S * math.sin(i * math.pi / 3), cy - S * math.cos(i * math.pi / 3)) for i in range(7)]
        r = await draw(page, ring, wob=1.5)
        P = pts(r['p'])
        check(all(any(near(q, z) for q in P) for z in ring) and near(P[0], P[-1]), 'ring: perfect hexagon on the paper')
        # circle inside a ring, big circle, small letter, wavy line stay as drawn
        for name, shape in [
            ('small circle in a ring', [(cx + 0.45 * S * math.cos(i / 24 * 6.283), cy + 0.45 * S * math.sin(i / 24 * 6.283)) for i in range(25)]),
            ('circle in a ring', [(cx + 0.6 * S * math.cos(i / 30 * 6.283), cy + 0.6 * S * math.sin(i / 30 * 6.283)) for i in range(31)]),
            ('big circle', [(420 + 2.2 * S * math.cos(i / 60 * 6.283), 500 + 2.2 * S * math.sin(i / 60 * 6.283)) for i in range(61)]),
            ('small letter', [(300, 300), (306, 310), (300, 318), (294, 310), (300, 300)]),
            ('s curve', [(420 + i * 3, 150 + 28 * math.sin(i / 7)) for i in range(45)]),
        ]:
            r = await draw(page, shape, wob=0.3, step=3)
            P = pts(r['p'])
            far = max(min(math.hypot(q[0] - s[0], q[1] - s[1]) for q in P) for s in shape)
            check(far < 2.5, f'{name} stays as drawn ({far:.1f})')
        la, lb = v(12, 1), v(12, 8)
        r = await draw(page, [(la[0] + 4, la[1] + 3), (lb[0] - 3, lb[1] + 4)], wob=1.5)
        P = pts(r['p']); check(dev(P) < 0.01 and near(P[0], la) and near(P[-1], lb), 'long line lands corner to corner')
        # strict: writing stays. A digit-sized line, and a long line with its ends away from the corners
        cc = v(10, 8); r = await draw(page, [(cc[0] + 16, cc[1] + 8), (cc[0] + 19, cc[1] + 34)], wob=0.8, step=3)
        check(dev(pts(r['p'])) > 0.3, 'a 1 away from the corners stays as drawn')
        c2 = v(10, 2); r = await draw(page, [(c2[0] + 3, c2[1] + 2), (c2[0] + 3, c2[1] + 26)], wob=0.8, step=3)
        check(dev(pts(r['p'])) > 0.3, 'a short line starting at a corner stays as drawn (under a bond)')
        await page.evaluate("async () => { const W = __inkwell, bl = await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMB/6X2l6kAAAAASUVORK5CYII=')).blob(), a = await W.saveAsset(bl); W.addItems([{t: 'i', id: 'pg1', x: 500, y: 60, w: 300, h: 400, a, doc: 1}]); }")
        await page.wait_for_timeout(200)
        A3, B3 = v(4, 8), v(4, 8, False)
        r = await draw(page, [(A3[0] + 3, A3[1] + 3), (B3[0] - 3, B3[1] + 3)])
        check(not near(pts(r['p'])[0], A3), 'on an imported page nothing snaps, the paper is hidden there')
        await page.evaluate("__inkwell.undo(); __inkwell.undo()"); await page.wait_for_timeout(100)
        # the same with the default bond (5 mm, about 19 px) and a shaky hand: a bond still lands, a circle stays
        await page.evaluate("""() => { const W = __inkwell; W.cur.bg = Object.assign({}, W.cur.bg, {sy: 18.9}); }""")
        s2 = 18.9; w2 = math.sqrt(3) * s2
        a2 = (10 * w2, 8 * 1.5 * s2 - s2); b2 = (10 * w2 + w2 / 2, 8 * 1.5 * s2 - s2 / 2)
        r = await draw(page, [(a2[0] + 2, a2[1] + 2), (b2[0] - 2, b2[1] + 2)], wob=0.8, step=3)
        P = pts(r['p']); check(near(P[0], a2) and near(P[-1], b2), f'default bond size: bond lands ({P[0]}, {P[-1]}, want {a2}, {b2})')
        circ = [(300 + 11 * math.cos(i / 24 * 6.283), 600 + 11 * math.sin(i / 24 * 6.283)) for i in range(25)]
        r = await draw(page, circ, wob=0.3, step=3); P = pts(r['p'])
        far = max(min(math.hypot(q[0] - s[0], q[1] - s[1]) for q in P) for s in circ)
        check(far < 2.5, f'default bond size: small circle stays ({far:.1f})')
        # other paper: nothing
        await page.evaluate("""() => { const W = __inkwell; W.cur.bg = Object.assign({}, W.cur.bg, {type: 'grid', sx: 20, sy: 20}); W.invalidate(); }""")
        r = await draw(page, [(100, 300), (300, 305)])
        check(dev(pts(r['p'])) > 0.5, 'grid paper: stroke stays as drawn')
        await page.evaluate("__inkwell.flushSaves()"); await page.wait_for_timeout(400)
        await page.reload(); await page.wait_for_timeout(3000)
        check(await page.evaluate("__inkwell.prefs.hexSnap === true"), 'setting kept after reload')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)
asyncio.run(main())
