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
        # --- 1.90.2: sharp corners, also after saving (points rounded to quarter pixels) ---
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage(); W.cam.z = 3; W.cam.ox = 40; W.cam.oy = 40; W.prefs.pen.c = 'auto'; W.invalidate(); }"""); await page.wait_for_timeout(200)
        await openmenu(page); await page.click('#hcOpen'); await page.click('#hcDraw'); await page.wait_for_timeout(60)
        await page.mouse.move(st[0] + 60, st[1] + 60); await page.mouse.down(); await page.mouse.move(st[0] + 620, st[1] + 660, steps=4); await page.mouse.up(); await page.wait_for_timeout(200)
        sq = await page.evaluate("""() => { const W = __inkwell, a = [...W.cur.items.values()].filter(i => i.t === 's' && i.g);
          // run it through the save format
          const again = a.map(i => { let q = i; const enc = W.strokePath(q, true); return {sq: i.sq, n: (enc.match(/L/g) || []).length}; });
          return {all: a.every(i => i.sq === 1), pts: a.reduce((m, i) => m + i.p.length / 3, 0), lines: again.reduce((m, q) => m + q.n, 0), ends: a.length}; }""")
        check(sq['all'], 'honeycomb strokes are marked sharp')
        check(sq['lines'] < sq['pts'] / 2, f"drawn as straight pieces between corners, not many small ones ({sq['lines']} lines for {sq['pts']} points)")
        ends = await page.evaluate("""() => { const W = __inkwell, k = q => Math.round(q[0]) + ':' + Math.round(q[1]), c = new Map();
          for(const i of W.cur.items.values()) if(i.t === 's' && i.g){ const n = i.p.length; if(Math.hypot(i.p[0] - i.p[n - 3], i.p[1] - i.p[n - 2]) < .5) continue; for(const q of [[i.p[0], i.p[1]], [i.p[n - 3], i.p[n - 2]]]) c.set(k(q), (c.get(k(q)) || 0) + 1); }
          // every line end must be at a point where three lines meet: one line passing through, one ending
          const pass = new Map(); for(const i of W.cur.items.values()) if(i.t === 's' && i.g) for(let j = 3; j < i.p.length - 3; j += 3){ const e = k([i.p[j], i.p[j + 1]]); if(c.has(e)) pass.set(e, 1); }
          return {endsAt: c.size, bad: [...c.keys()].filter(e => !pass.has(e)).length}; }""")
        check(ends['bad'] <= 6, f'line ends only where lines meet ({ends})')
        shot = await page.screenshot()
        if os.environ.get('SHOT_DIR'): open(os.environ['SHOT_DIR'] + '/hc_sharp.png', 'wb').write(shot)
        await page.evaluate("__inkwell.flushSaves()"); await page.wait_for_timeout(500)
        red = await page.evaluate("""async () => { const W = __inkwell, id = W.cur.id; await W.flushSaves(); await W.newPage(); await new Promise(r => setTimeout(r, 200)); await W.openPage(id); await new Promise(r => setTimeout(r, 400));
          const a = [...W.cur.items.values()].filter(i => i.t === 's' && i.g); return {all: a.length && a.every(i => i.sq === 1), lines: a.reduce((m, i) => m + (W.strokePath(i, true).match(/L/g) || []).length, 0)}; }""")
        check(red['all'] and red['lines'] == sq['lines'], f"same after saving and opening again ({red['lines']} vs {sq['lines']})")
        # --- 1.90.1: Straighten lines inside a honeycomb, on grid paper ---
        await page.keyboard.press('Escape')
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage(); W.setTool('pen'); W.prefs.hexSnap = false; W.cam.z = 1; W.cam.ox = 40; W.cam.oy = 40; W.invalidate(); }""")
        await page.wait_for_timeout(300)
        await page.evaluate("document.getElementById('shapePop').hidden = false")
        await page.evaluate("document.getElementById('shapePop').hidden = true")
        await openmenu(page); await page.click('#hcOpen'); await page.wait_for_timeout(80)
        check(await page.is_visible('#hexSnap2'), 'Straighten lines switch beside Draw honeycomb')
        await page.click('#hcDraw'); await page.wait_for_timeout(80)
        await page.mouse.move(st[0] + 60, st[1] + 60); await page.mouse.down(); await page.mouse.move(st[0] + 460, st[1] + 560, steps=5); await page.mouse.up(); await page.wait_for_timeout(200)
        CORNERS = """() => { const W = __inkwell, a = [...W.cur.items.values()].filter(i => i.t === 's' && i.g), h = W.HexLine.shape(a); return h && {s: h.s, c: h.corners}; }"""
        h = await page.evaluate(CORNERS)
        check(bool(h) and 38 <= len(h['c']) <= 50 and abs(h['s'] - 400 / (3.5 * math.sqrt(3))) < 1.5, f"honeycomb recognised from its strokes ({h and len(h['c'])} corners, side {h and h['s']:.1f})")
        S = h['s']; C = h['c']
        async def pen(world, wob=1.2):
            import random
            rnd = random.Random(4)
            await page.evaluate("__inkwell.setTool('pen')")
            cam = await page.evaluate("[__inkwell.cam.ox, __inkwell.cam.oy, __inkwell.cam.z]")
            sc = lambda x, y: (st[0] + cam[0] + x * cam[2], st[1] + cam[1] + y * cam[2])
            path = []
            for a, b_ in zip(world, world[1:]):
                n = max(3, int(math.hypot(b_[0] - a[0], b_[1] - a[1]) / 6))
                path += [(a[0] + (b_[0] - a[0]) * i / n, a[1] + (b_[1] - a[1]) * i / n) for i in range(n)]
            path.append(world[-1])
            x, y = sc(*path[0]); await page.mouse.move(x, y); await page.mouse.down()
            for q in path[1:]:
                x, y = sc(q[0] + rnd.uniform(-wob, wob), q[1] + rnd.uniform(-wob, wob)); await page.mouse.move(x, y)
            await page.mouse.up(); await page.wait_for_timeout(120)
            r = await page.evaluate("() => { const a = [...__inkwell.cur.items.values()].filter(i => i.t === 's' && !i.g); const s = a[a.length - 1]; return s ? Array.from(s.p) : []; }")
            return [(r[i], r[i + 1]) for i in range(0, len(r), 3)]
        def pick_edge(C, S):
            # two neighbouring corners well inside
            cx = sum(q[0] for q in C) / len(C); cy = sum(q[1] for q in C) / len(C)
            a = min(C, key=lambda q: math.hypot(q[0] - cx, q[1] - cy))
            b_ = min((q for q in C if q is not a and abs(math.hypot(q[0] - a[0], q[1] - a[1]) - S) < 2), key=lambda q: q[0])
            return a, b_
        def off_a_bit(a, b_, k=0.12):
            return [(a[0] + (b_[0] - a[0]) * k + 3, a[1] + (b_[1] - a[1]) * k + 3), (b_[0] - (b_[0] - a[0]) * k + 3, b_[1] - (b_[1] - a[1]) * k + 3)]
        a, b_ = pick_edge(C, S)
        P = await pen(off_a_bit(a, b_))
        check(not (math.hypot(P[0][0] - a[0], P[0][1] - a[1]) < 0.6 and math.hypot(P[-1][0] - b_[0], P[-1][1] - b_[1]) < 0.6), 'switch off: stays as drawn')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(60)
        await openmenu(page); await page.click('#hcOpen'); await page.click('#hexSnap2'); await page.wait_for_timeout(60)
        check(await page.evaluate("__inkwell.prefs.hexSnap === true"), 'switch beside Draw honeycomb turns it on')
        await page.evaluate("document.getElementById('shapePop').hidden = true")
        P = await pen(off_a_bit(a, b_))
        check(math.hypot(P[0][0] - a[0], P[0][1] - a[1]) < 0.6 and math.hypot(P[-1][0] - b_[0], P[-1][1] - b_[1]) < 0.6, f'line over an edge lands on its corners, on grid paper ({P[0]}, {P[-1]}, want {a}, {b_})')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(60)
        # a chain across cells
        chain = [a, b_]
        for _ in range(2):
            nx = [q for q in C if abs(math.hypot(q[0] - chain[-1][0], q[1] - chain[-1][1]) - S) < 2 and q not in chain]
            chain.append(max(nx, key=lambda q: q[0]))
        P = await pen([(q[0] + 3, q[1] - 2) for q in chain])
        check(all(min(math.hypot(q[0] - z[0], q[1] - z[1]) for q in P) < 0.6 for z in chain), 'zig-zag: every corner on the honeycomb')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(60)
        # writing and curves stay; outside stays
        cx, cy = (a[0] + b_[0]) / 2, (a[1] + b_[1]) / 2
        circ = [(cx + 0.5 * S * math.cos(i / 24 * 6.283), cy + 0.5 * S * math.sin(i / 24 * 6.283)) for i in range(25)]
        P = await pen(circ, wob=0.3)
        far = max(min(math.hypot(q[0] - z[0], q[1] - z[1]) for q in P) for z in circ)
        check(far < 3, f'circle inside stays as drawn ({far:.1f})')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(60)
        P = await pen([(520, 100), (600, 104)])
        check(math.hypot(P[0][0] - 520, P[0][1] - 100) < 3, 'outside the honeycomb on grid paper: stays as drawn')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(60)
        # moved and turned: its new corners count
        await page.evaluate("""() => { const W = __inkwell, A = 0.5, cx = 250, cy = 300, c = Math.cos(A), s = Math.sin(A);
          W.replaceItems([...W.cur.items.values()].filter(i => i.t === 's' && i.g).map(i => { const p = Array.from(i.p); for(let k = 0; k < p.length; k += 3){ const x = p[k] - cx, y = p[k + 1] - cy; p[k] = cx + 40 + x * c - y * s; p[k + 1] = cy + 10 + x * s + y * c; } return Object.assign({}, i, {p}); })); }""")
        await page.wait_for_timeout(100)
        h2 = await page.evaluate(CORNERS)
        check(bool(h2) and abs(h2['s'] - S) < 1, 'still recognised after moving and turning it')
        a2, b2 = pick_edge(h2['c'], h2['s'])
        P = await pen(off_a_bit(a2, b2))
        check(math.hypot(P[0][0] - a2[0], P[0][1] - a2[1]) < 0.6 and math.hypot(P[-1][0] - b2[0], P[-1][1] - b2[1]) < 0.6, 'turned honeycomb: lands on its new corners')
        # the eraser takes the drawing and leaves the honeycomb
        count = "() => { const a = [...__inkwell.cur.items.values()].filter(i => i.t === 's'); return {grid: a.filter(i => i.g).length, ink: a.filter(i => !i.g).length, ne: a.filter(i => i.g).every(i => i.ne === 1)}; }"
        c0 = await page.evaluate(count)
        check(c0['ink'] == 1 and c0['ne'], f'honeycomb marked, one drawn line on it ({c0})')
        cam = await page.evaluate("[__inkwell.cam.ox, __inkwell.cam.oy, __inkwell.cam.z]")
        for mode in ('stroke', 'area'):
            await page.evaluate(f"() => {{ __inkwell.setTool('eraser'); __inkwell.prefs.eraser.mode = '{mode}'; }}")
            P0 = await page.evaluate("() => { const a = [...__inkwell.cur.items.values()].filter(i => i.t === 's' && !i.g)[0]; return a ? [a.p[0], a.p[1], a.p[a.p.length - 3], a.p[a.p.length - 2]] : null; }")
            if not P0:
                P0 = (await pen(off_a_bit(a2, b2)))
                await page.evaluate(f"() => {{ __inkwell.setTool('eraser'); __inkwell.prefs.eraser.mode = '{mode}'; }}")
                P0 = [P0[0][0], P0[0][1], P0[-1][0], P0[-1][1]]
            sx, sy = st[0] + cam[0] + (P0[0] + P0[2]) / 2 * cam[2], st[1] + cam[1] + (P0[1] + P0[3]) / 2 * cam[2]
            await page.mouse.move(sx - 14, sy - 14); await page.mouse.down(); await page.mouse.move(sx + 14, sy + 14, steps=8); await page.mouse.up(); await page.wait_for_timeout(120)
            c1 = await page.evaluate(count)
            check(c1['grid'] == c0['grid'], f'eraser ({mode}) leaves the honeycomb ({c1})')
            lines = await page.evaluate("() => [...__inkwell.cur.items.values()].filter(i => i.t === 's' && i.g).reduce((m, i) => m + i.p.length, 0)")
            if mode == 'stroke': L0 = lines
            check(lines == L0, f'eraser ({mode}) cut nothing out of it')
            if mode == 'stroke': check(c1['ink'] == 0, 'the drawn line is gone')
        # Select tool: a loop around writing on it takes the writing only; a loop around all of it takes it
        P = await pen(off_a_bit(a2, b2))
        ci = (P[0][0] + P[-1][0]) / 2, (P[0][1] + P[-1][1]) / 2
        await page.evaluate("__inkwell.setTool('lasso')"); await page.evaluate("__inkwell.prefs.lassoMode = 'free'")
        to = lambda x, y: (st[0] + cam[0] + x * cam[2], st[1] + cam[1] + y * cam[2])
        rr = 0.9 * h2['s']
        loop = [to(ci[0] + rr * math.cos(i / 16 * 6.283), ci[1] + rr * math.sin(i / 16 * 6.283)) for i in range(17)]
        await page.mouse.move(*loop[0]); await page.mouse.down()
        for q in loop[1:]: await page.mouse.move(*q)
        await page.mouse.up(); await page.wait_for_timeout(150)
        pk = await page.evaluate("() => { const W = __inkwell; return (W.sel ? W.sel.ids : []).map(id => !!W.cur.items.get(id).g); }")
        check(len(pk) == 1 and not pk[0], f'loop around writing on it takes only the writing ({pk})')
        await page.evaluate("__inkwell.setTool('pen'); __inkwell.setTool('lasso')")
        box = await page.evaluate("() => { let b = [1e9, 1e9, -1e9, -1e9]; for(const i of __inkwell.cur.items.values()) if(i.t === 's' && i.g) for(let k = 0; k < i.p.length; k += 3){ b = [Math.min(b[0], i.p[k]), Math.min(b[1], i.p[k + 1]), Math.max(b[2], i.p[k]), Math.max(b[3], i.p[k + 1])]; } return b; }")
        wide = await page.evaluate("[__inkwell.cam.ox, __inkwell.cam.oy, __inkwell.cam.z]")
        await page.evaluate("() => { const W = __inkwell; W.cam.z = 0.6; W.cam.ox = 200; W.cam.oy = 60; W.invalidate(); }"); await page.wait_for_timeout(120)
        cam2 = await page.evaluate("[__inkwell.cam.ox, __inkwell.cam.oy, __inkwell.cam.z]")
        to2 = lambda x, y: (st[0] + cam2[0] + x * cam2[2], st[1] + cam2[1] + y * cam2[2])
        rect = [to2(box[0] - 30, box[1] - 30), to2(box[2] + 30, box[1] - 30), to2(box[2] + 30, box[3] + 30), to2(box[0] - 30, box[3] + 30), to2(box[0] - 30, box[1] - 30)]
        await page.mouse.move(*rect[0]); await page.mouse.down()
        for i in range(4):
            for k in range(1, 7): await page.mouse.move(rect[i][0] + (rect[i + 1][0] - rect[i][0]) * k / 6, rect[i][1] + (rect[i + 1][1] - rect[i][1]) * k / 6)
        await page.mouse.up(); await page.wait_for_timeout(150)
        sl = await page.evaluate("() => { const W = __inkwell; return [(W.sel ? W.sel.ids : []).filter(id => W.cur.items.get(id).g).length, [...W.cur.items.values()].filter(i => i.t === 's' && i.g).length]; }")
        check(sl[0] == sl[1] and sl[1] > 0, f'loop around all of it takes it ({sl})')
        await page.evaluate("() => { const W = __inkwell, a = [...W.cur.items.values()].filter(i => i.t === 's' && i.g).map(i => i.id); W.setTool('lasso'); W.selectIds(a); }"); await page.wait_for_timeout(100)
        await page.click('#selDel'); await page.wait_for_timeout(120)
        check((await page.evaluate(count))['grid'] == 0, 'Select + delete still removes it')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(100)
        # a honeycomb made with 1.90 (no marks) gets them when its page opens
        adopted = await page.evaluate("""async () => { const W = __inkwell, id = W.cur.id;
          W.replaceItems([...W.cur.items.values()].filter(i => i.t === 's' && i.g).map(i => { const c = Object.assign({}, i); delete c.sq; delete c.ne; return c; }));
          await W.flushSaves(); await W.newPage(); await new Promise(r => setTimeout(r, 200)); await W.openPage(id); await new Promise(r => setTimeout(r, 300));
          const a = [...W.cur.items.values()].filter(i => i.t === 's' && i.g); return a.length && a.every(i => i.sq === 1 && i.ne === 1); }""")
        check(adopted, 'older honeycomb gets sharp corners and eraser protection when its page opens')
        # other grouped shapes are not honeycombs
        no = await page.evaluate("""() => { const W = __inkwell, mk = (id, pts) => { const p = []; for(const q of pts) p.push(q[0], q[1], .5); return {t: 's', id, g: 'gg', c: 'auto', w: 2, p}; };
          const rows = []; for(let i = 0; i < 5; i++) rows.push(mk('r' + i, [[0, i * 40], [200, i * 40]])); for(let i = 0; i < 6; i++) rows.push(mk('c' + i, [[i * 40, 0], [i * 40, 160]]));
          const star = [mk('st', Array.from({length: 11}, (_, i) => { const r = i % 2 ? 20 : 50, t = i * Math.PI / 5; return [r * Math.sin(t), -r * Math.cos(t)]; }))];
          return [W.HexLine.shape(rows), W.HexLine.shape(star)]; }""")
        check(no[0] is None and no[1] is None, f'a square grid and a star are not taken for a honeycomb ({no})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)
asyncio.run(main())
