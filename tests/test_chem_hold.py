# 1.73: (a) "Hex" paper for chemistry (honeycomb, slider = bond length, kept on reload, in the print/PDF paper path)
# (b) hold-to-straighten works with a normal shaky hand: tremor while resting (up to ~8 px) no longer restarts the
# wait, and the shaking at the end no longer stops the line from being recognised. Slow handwriting is left alone.
import asyncio, os, math, random
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

STROKES = """() => [...__inkwell.cur.items.values()].filter(i => i.t === 's').map(s => Array.from(s.p))"""

def wobble(P):
    pts = [(P[i], P[i + 1]) for i in range(0, len(P), 3)]
    (ax, ay), (bx, by) = pts[0], pts[-1]
    L = math.hypot(bx - ax, by - ay) or 1
    return max(abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / L for x, y in pts)

async def boot(page):
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

async def shaky_line(page, x, y, hold_ms=1100, shake=6, dx=4, dy=0.6, n=60):
    rnd = random.Random(7)
    await page.mouse.move(x, y); await page.mouse.down()
    for i in range(1, n + 1):
        await page.mouse.move(x + dx * i + rnd.uniform(-1.5, 1.5), y + dy * i + 3 * math.sin(i / 5)); await page.wait_for_timeout(8)
    ex, ey = x + dx * n, y + dy * n
    t = 0
    while t < hold_ms:   # a human hand resting: keeps shaking a few px around the stop
        await page.mouse.move(ex + rnd.uniform(-shake, shake), ey + rnd.uniform(-shake, shake)); await page.wait_for_timeout(25); t += 25
    await page.mouse.up(); await page.wait_for_timeout(250)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await boot(page)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)

        # --- Hex paper ---
        await page.click('#paperBtn'); await page.wait_for_selector('#paperPop', state='visible')
        await page.click('#paperType button[data-v="hex"]'); await page.wait_for_timeout(300)
        st = await page.evaluate("""() => ({t: __inkwell.cur.bg.type, fx: document.getElementById('fxWrap').hidden,
          fy: document.getElementById('fyWrap').hidden, sq: document.getElementById('linkXY').parentElement.hidden,
          lbl: document.getElementById('fyLbl').firstChild.textContent.trim(),
          on: document.querySelector('#paperType button[data-v="hex"]').classList.contains('on')})""")
        check(st['t'] == 'hex' and st['on'], f'Hex paper chosen ({st})')
        check(st['fx'] and not st['fy'] and st['sq'] and st['lbl'] == 'Bond length', f'one slider "Bond length" ({st})')
        wide = await page.evaluate("(() => { const p = document.getElementById('paperPop').getBoundingClientRect(); const s = document.getElementById('paperType').getBoundingClientRect(); return [p.width, s.right <= p.right + 0.5]; })()")
        check(wide[1], f'paper buttons fit in the popover ({wide})')
        # the background shows slanted lines (hexagon edges), not only straight rows/columns
        diag = await page.evaluate("""() => {
          const cv = document.getElementById('bg'), c = cv.getContext('2d'), d = c.getImageData(0, 0, cv.width, cv.height).data;
          let ink = 0; for(let i = 3; i < d.length; i += 4 * 7) if(d[i] > 20) ink++;
          // rows that have lines in them: a grid has few full rows; hexagons touch almost every row
          let rows = 0; for(let y = 0; y < cv.height; y += 3){ let any = false; for(let x = 0; x < cv.width; x += 2) if(d[(y * cv.width + x) * 4 + 3] > 20){ any = true; break; } if(any) rows++; }
          return {ink, rows, total: Math.ceil(cv.height / 3)};
        }""")
        check(diag['ink'] > 500 and diag['rows'] > 0.9 * diag['total'], f'hexagons drawn on the page ({diag})')
        await page.fill('#fy', '8'); await page.dispatch_event('#fy', 'input'); await page.wait_for_timeout(200)
        sy = await page.evaluate("__inkwell.cur.bg.sy / 96 * 25.4")   # MM = 96 / 25.4
        sx = await page.evaluate("__inkwell.cur.bg.sx / 96 * 25.4")
        check(abs(sy - 8) < 0.05 and abs(sx - 5) < 0.05, f'slider sets bond length only ({sy:.2f}, sx {sx:.2f})')
        path = await page.evaluate("""() => { const pp = __inkwell.cur.bg; const s = pp.sy, w = Math.sqrt(3) * s;
          return {n: (window.paperPath ? paperPath(pp, 0, 300, 0, 300) : '').split('M').length - 1}; }""")
        check(path['n'] > 20, f'print/PDF paper path has the hexagon edges ({path})')
        await page.keyboard.press('Escape'); await page.mouse.click(5, 5)
        await page.wait_for_timeout(1500)
        await page.reload(); await boot(page)
        t = await page.evaluate("[__inkwell.cur.bg.type, Math.round(__inkwell.cur.bg.sy / 96 * 25.4)]")
        check(t == ['hex', 8], f'Hex paper kept after reload ({t})')
        # older types still work
        await page.click('#paperBtn'); await page.click('#paperType button[data-v="grid"]'); await page.wait_for_timeout(200)
        g = await page.evaluate("({t: __inkwell.cur.bg.type, fx: document.getElementById('fxWrap').hidden, lbl: document.getElementById('fyLbl').firstChild.textContent.trim()})")
        check(g['t'] == 'grid' and not g['fx'] and g['lbl'] == 'Height', f'Grid still has width + height ({g})')
        await page.mouse.click(5, 5); await page.wait_for_timeout(200)

        # --- hold to straighten ---
        await page.evaluate("__inkwell.setTool('pen')")
        box = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        x0, y0 = box[0] + 120, box[1] + 160
        await shaky_line(page, x0, y0)
        s = await page.evaluate(STROKES)
        check(len(s) >= 1 and wobble(s[-1]) < 0.5, f'shaky hand, 6 px tremor while resting: line straightened (wobble {wobble(s[-1]):.2f})')
        # the end sits where the hand rested, not at a random wobble far off
        ex = s[-1][-3]; sx0 = s[-1][0]
        check(abs((ex - sx0) - 240) < 12, f'line ends where the Pencil rested (length {ex - sx0:.1f}, drawn 240)')
        await shaky_line(page, x0, y0 + 120, shake=3, dx=3, dy=2.5)
        s = await page.evaluate(STROKES)
        check(wobble(s[-1]) < 0.5, f'slanted line, light tremor: straightened (wobble {wobble(s[-1]):.2f})')
        # still ok: a fully still hold
        await shaky_line(page, x0, y0 + 240, shake=0)
        s = await page.evaluate(STROKES)
        check(wobble(s[-1]) < 0.5, f'still hold: straightened (wobble {wobble(s[-1]):.2f})')
        # hold until straight, then keep holding and drag the end around like the Line tool
        rnd = random.Random(3)
        await page.mouse.move(x0, y0 + 400); await page.mouse.down()
        for i in range(1, 41): await page.mouse.move(x0 + 4 * i, y0 + 400 + 2 * math.sin(i / 4)); await page.wait_for_timeout(8)
        for _ in range(36): await page.mouse.move(x0 + 160 + rnd.uniform(-2, 2), y0 + 400 + rnd.uniform(-2, 2)); await page.wait_for_timeout(25)
        for i in range(1, 21):   # drag to 200 px right, 196 px down (~44.4 deg)
            await page.mouse.move(x0 + 160 + 2 * i, y0 + 400 + 9.8 * i); await page.wait_for_timeout(16)
        await page.mouse.up(); await page.wait_for_timeout(250)
        s = await page.evaluate(STROKES)
        P = s[-1]; ang = math.degrees(math.atan2(P[-2] - P[1], P[-3] - P[0])); ln = math.hypot(P[-2] - P[1], P[-3] - P[0])
        check(wobble(P) < 0.5 and abs(ang - 45) < 0.05 and abs(ln - math.hypot(200, 196)) < 6, f'drag after straightening: straight, end follows the Pencil, clicks to 45 deg ({ang:.2f} deg, len {ln:.0f})')
        # 1.73.1: more forgiving
        async def hold_drag(y, tx, ty, ox=330):
            X = x0 + ox
            await page.mouse.move(X, y); await page.mouse.down()
            for i in range(1, 41): await page.mouse.move(X + 4 * i, y + 2 * math.sin(i / 4)); await page.wait_for_timeout(8)
            for _ in range(36): await page.mouse.move(X + 160 + rnd.uniform(-2, 2), y + rnd.uniform(-2, 2)); await page.wait_for_timeout(25)
            for i in range(1, 21): await page.mouse.move(X + 160 + (tx - 160) * i / 20, y + ty * i / 20); await page.wait_for_timeout(16)
            await page.mouse.up(); await page.wait_for_timeout(250)
            P = (await page.evaluate(STROKES))[-1]
            return P, math.degrees(math.atan2(P[-2] - P[1], P[-3] - P[0]))
        await shaky_line(page, x0 + 330, y0, shake=7)
        s = await page.evaluate(STROKES)
        check(wobble(s[-1]) < 0.5, f'7 px tremor while resting: straightened (wobble {wobble(s[-1]):.2f})')
        await page.mouse.move(x0 + 330, y0 + 120); await page.mouse.down()
        for i in range(1, 61): await page.mouse.move(x0 + 330 + 4 * i, y0 + 120 + 9 * math.sin(i / 7)); await page.wait_for_timeout(8)
        for _ in range(36): await page.mouse.move(x0 + 570 + rnd.uniform(-2, 2), y0 + 120 + 9 * math.sin(60 / 7) + rnd.uniform(-2, 2)); await page.wait_for_timeout(25)
        await page.mouse.up(); await page.wait_for_timeout(250)
        s = await page.evaluate(STROKES)
        check(wobble(s[-1]) < 0.5, f'wobbly line (9 px waves over 240 px): straightened (wobble {wobble(s[-1]):.2f})')
        P, ang = await hold_drag(y0 + 230, 200, 168)   # ~40 deg
        check(abs(ang - 45) < 0.05, f'snap on: drag at ~40 deg clicks to 45 ({ang:.2f})')
        await page.evaluate("__inkwell.prefs.angleSnap = false")
        P, ang = await hold_drag(y0 + 330, 200, 168)
        check(abs(ang - 40) < 1.5, f'snap off: drag keeps ~40 deg ({ang:.2f})')
        P, ang = await hold_drag(y0 + 430, 400, 0, ox=20)
        ln = math.hypot(P[-2] - P[1], P[-3] - P[0])
        check(abs(ln - 400) < 6, f'drag makes the line longer than drawn (160 -> {ln:.0f})')
        await page.evaluate("__inkwell.prefs.angleSnap = true")
        # 1.73.2: real strokes from Rafael's iPad: curved, gently bent, hooked at the start -> straight; a sharp V keeps its corner
        async def held(pts, ox, oy):
            await page.mouse.move(ox + pts[0][0], oy + pts[0][1]); await page.mouse.down()
            for (x, y) in pts[1:]: await page.mouse.move(ox + x, oy + y); await page.wait_for_timeout(8)
            ex, ey = pts[-1]
            for _ in range(36): await page.mouse.move(ox + ex + rnd.uniform(-2, 2), oy + ey + rnd.uniform(-2, 2)); await page.wait_for_timeout(25)
            await page.mouse.up(); await page.wait_for_timeout(250)
            return (await page.evaluate(STROKES))[-1]
        def verts(P):
            pts = [(P[i], P[i + 1]) for i in range(0, len(P), 3)]
            n = 0
            for i in range(1, len(pts) - 1):
                a = math.atan2(pts[i][1] - pts[i-1][1], pts[i][0] - pts[i-1][0]); b = math.atan2(pts[i+1][1] - pts[i][1], pts[i+1][0] - pts[i][0])
                d = abs(b - a); d = 2 * math.pi - d if d > math.pi else d
                if d > 0.3: n += 1
            return n
        ox, oy = x0 + 650, y0
        arc = [(4 * i, -0.6 * 4 * i + 26 * math.sin(math.pi * i / 50)) for i in range(51)]   # curved, bulge ~13 % of chord
        P = await held(arc, ox, oy + 140)
        check(wobble(P) < 0.5, f'curved held line -> straight (wobble {wobble(P):.2f})')
        bent = [(4 * i, 0) for i in range(26)] + [(100 + 4 * i * math.cos(0.35), -4 * i * math.sin(0.35)) for i in range(1, 26)]   # 20 deg bend
        P = await held(bent, ox, oy + 260)
        check(wobble(P) < 0.5 and verts(P) == 0, f'gently bent held line -> straight, no kink (wobble {wobble(P):.2f}, kinks {verts(P)})')
        hook = [(6 * math.cos(a), 6 * math.sin(a)) for a in [3.0, 2.4, 1.8, 1.2, 0.6, 0.0]] + [(6 + 4 * i, -3 * i) for i in range(1, 46)]
        P = await held(hook, ox, oy + 420)
        check(wobble(P) < 0.5, f'held line with a hook at the start -> straight (wobble {wobble(P):.2f})')
        vee = [(3 * i, 3 * i) for i in range(31)] + [(90 + 3 * i, 90 - 3 * i) for i in range(1, 31)]
        P = await held(vee, ox - 300, oy + 520)
        check(wobble(P) > 50, f'held V stays as drawn, not straightened (wobble {wobble(P):.1f})')
        zz = [(0, 0), (60, -50), (10, -40), (90, -90), (40, -80), (120, -130)]
        zpts = []
        for k in range(len(zz) - 1):
            for i in range(10): zpts.append((zz[k][0] + (zz[k+1][0] - zz[k][0]) * i / 10, zz[k][1] + (zz[k+1][1] - zz[k][1]) * i / 10))
        zpts.append(zz[-1])
        n0 = len(await page.evaluate(STROKES))
        P = await held(zpts, ox - 120, oy + 680)
        check(verts(P) >= 4 and wobble(P) > 10, f'held zig-zag stays as drawn ({verts(P)} turns, wobble {wobble(P):.1f})')
        mm = [(0, 0), (0, -40), (20, 0), (40, -40), (40, 0), (60, -40), (60, 0)]
        mp = []
        for k in range(len(mm) - 1):
            for i in range(8): mp.append((mm[k][0] + (mm[k+1][0] - mm[k][0]) * i / 8, mm[k][1] + (mm[k+1][1] - mm[k][1]) * i / 8))
        mp.append(mm[-1])
        P = await held(mp, ox + 80, oy + 680)
        check(verts(P) >= 4, f'held letter stays as written, no sharp-cornered copy ({verts(P)} turns)')
        # lifting right away keeps the hand-drawn line
        await page.mouse.move(x0, y0 + 330); await page.mouse.down()
        for i in range(1, 61): await page.mouse.move(x0 + 4 * i, y0 + 330 + 3 * math.sin(i / 5)); await page.wait_for_timeout(8)
        await page.mouse.up(); await page.wait_for_timeout(250)
        s = await page.evaluate(STROKES)
        check(wobble(s[-1]) > 1.5, f'no rest: stroke stays as drawn (wobble {wobble(s[-1]):.2f})')
        # slow handwriting (a loop written slowly) is not turned into a shape mid-way
        n0 = len(await page.evaluate(STROKES))
        cx, cy = x0 + 400, y0 + 420
        await page.mouse.move(cx, cy); await page.mouse.down()
        for i in range(1, 90):
            a = i / 89 * 2 * math.pi * 1.7
            await page.mouse.move(cx + 30 * math.sin(a) + i * 1.2, cy - 25 * (1 - math.cos(a))); await page.wait_for_timeout(16)
        await page.mouse.up(); await page.wait_for_timeout(250)
        s = await page.evaluate(STROKES)
        check(len(s) == n0 + 1 and wobble(s[-1]) > 10, f'slow handwriting stays as written (wobble {wobble(s[-1]):.1f})')

        check(not errs, f'no page errors {errs[:3]}')
        await b.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
