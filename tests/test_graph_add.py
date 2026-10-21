# 1.58: Add formula on a selected graph: button in the selection menu, window with function, colour, line style,
# label; curve lands on the graph's own scale, also after the graph was moved, resized and turned; undo; errors;
# old graphs (no axis memory) do not show the button.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

# world point of data (xv, yv) computed independently from the axis ticks/geometry right after insert
GRAPH = """() => { const its = [...__inkwell.cur.items.values()]; const xa = its.find(i => i.ga && i.ga.k === 'x'), ya = its.find(i => i.ga && i.ga.k === 'y');
  return {x: xa && {p: xa.p.slice(), ga: xa.ga, id: xa.id, g: xa.g}, y: ya && {p: ya.p.slice(), ga: ya.ga, id: ya.id}}; }"""
NEW = """(ids) => [...__inkwell.cur.items.values()].filter(i => !ids.includes(i.id))"""

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
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        # old-style graph (no ga): no button
        await page.evaluate("() => __inkwell.addItems([{t:'s', id:'old1', c:'auto', w:2, hl:0, g:'gOld', p:[0,0,.5,100,0,.5]}, {t:'s', id:'old2', c:'auto', w:2, hl:0, g:'gOld', p:[0,0,.5,0,-100,.5]}])")
        await page.evaluate("() => { __inkwell.setTool('lasso'); __inkwell.selectIds(['old1', 'old2']); }"); await page.wait_for_timeout(300)
        check(await page.evaluate("document.getElementById('selGraph').hidden"), 'graph from before 1.58: no Add formula button')
        await page.evaluate("__inkwell.removeItems(['old1', 'old2'])")
        # new 4-quadrant graph -5..5
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_selector('#graphDlg', state='visible')
        await page.click('#gType [data-v="q4"]'); await page.wait_for_timeout(100)
        await page.fill('#gFn', ''); await page.click('#gInsert'); await page.wait_for_timeout(500)
        g = await page.evaluate(GRAPH)
        check(g['x'] and g['y'] and g['x']['ga']['id'] == g['y']['ga']['id'], 'new graph: axes remember the graph')
        vis = await page.evaluate("(() => { const b = document.getElementById('selGraph'); return !b.hidden && b.closest('#selMenu') && b.getBoundingClientRect().width > 30; })()")
        check(vis, 'graph selected: Add formula button in the selection menu')
        before = await page.evaluate("() => [...__inkwell.cur.items.keys()]")
        await page.click('#selGraph'); await page.wait_for_selector('#gAddDlg', state='visible'); await page.wait_for_timeout(200)
        foc = await page.evaluate("document.activeElement.id")
        check(foc == 'gaFn', 'window opens with the cursor in the function field')
        # error messages
        await page.fill('#gaFn', '2x+'); await page.click('#gaAdd'); await page.wait_for_timeout(200)
        m1 = await page.evaluate("document.getElementById('gaMsg').textContent")
        await page.fill('#gaFn', 'x+100'); await page.click('#gaAdd'); await page.wait_for_timeout(200)
        m2 = await page.evaluate("document.getElementById('gaMsg').textContent")
        check(bool(m1) and 'range' in m2 and await page.is_visible('#gAddDlg'), f'bad / out-of-range function explained, window stays ({m1!r}, {m2!r})')
        await page.click('#gaC [data-c="#C2362B"]'); await page.click('#gaS [data-v="dash"]')
        await page.fill('#gaFn', 'y = 0.5x^2-2'); await page.keyboard.press('Enter'); await page.wait_for_timeout(500)
        new = await page.evaluate(NEW, before)
        curve = [i for i in new if i['t'] == 's']; lab = [i for i in new if i['t'] == 'm']
        check(not await page.is_visible('#gAddDlg') and len(curve) > 5 and all(i['c'] == '#C2362B' for i in curve), f'Enter adds a dashed red curve ({len(curve)} pieces)')
        check(all(i.get('ne') == 1 and i.get('g') == g['x']['g'] for i in new), 'new curve is part of the graph (group, not erasable)')
        check(len(lab) == 1 and lab[0]['tex'].startswith('y = 0.5x^{2}') and lab[0]['c'] == '#C2362B', f'formula written next to it ({lab and lab[0]["tex"]})')
        # accuracy: every curve point lies on y = 0.5x^2-2 in the graph's own scale
        def mapper(G):
            p, q, A, B = G['x']['p'], G['y']['p'], G['x']['ga'], G['y']['ga']
            P0 = (p[0], p[1]); ux = ((p[-3] - p[0]) * A['f'], (p[-2] - p[1]) * A['f']); uy = ((q[-3] - q[0]) * B['f'], (q[-2] - q[1]) * B['f'])
            def inv(wx, wy):
                # solve P0 + ux*a + uy*b = (wx, wy)
                dx, dy = wx - P0[0], wy - P0[1]; det = ux[0] * uy[1] - ux[1] * uy[0]
                a = (dx * uy[1] - dy * uy[0]) / det; bb = (ux[0] * dy - ux[1] * dx) / det
                return A['v0'] + a * (A['v1'] - A['v0']), A['c'] + bb * (B['v1'] - B['v0'])
            return inv
        inv = mapper(g); worst = 0
        for it in curve:
            pts = it['p']
            for k in range(0, len(pts), 3):
                xv, yv = inv(pts[k], pts[k+1]); worst = max(worst, abs(yv - (0.5 * xv * xv - 2)))
        check(worst < 0.03, f'curve lies on y = 0.5x^2-2 on the graph scale (worst {worst:.4f})')
        sel = await page.evaluate("__inkwell.sel && __inkwell.sel.ids.length")
        check(sel == len(before) + len(new) - 0 or sel >= len(new), f'graph and new curve selected afterwards ({sel})')
        # undo removes just the added curve
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(300)
        n = len(await page.evaluate(NEW, before))
        check(n == 0, 'undo removes the added formula only')
        # move, resize and turn the graph, then add: still on scale
        await page.evaluate("""() => { const W = __inkwell, ids = [...W.cur.items.values()].filter(i => i.g).map(i => i.id);
          const its = ids.map(id => W.cur.items.get(id));
          const tf1 = {s: 1.5, ax: 0, ay: 0, dx: 300, dy: 120}; const moved = its.map(it => { const o = Object.assign({}, it); if(o.t === 's'){ const p = o.p.slice(); for(let i = 0; i < p.length; i += 3){ p[i] = p[i] * 1.5 + 300; p[i+1] = p[i+1] * 1.5 + 120; } o.p = p; o.w *= 1.5; } else { o.x = o.x * 1.5 + 300; o.y = o.y * 1.5 + 120; } return o; });
          const r = 0.4, c = Math.cos(r), s = Math.sin(r), turned = moved.map(o => { if(o.t !== 's') return o; const p = o.p.slice(); for(let i = 0; i < p.length; i += 3){ const x = p[i], y = p[i+1]; p[i] = x * c - y * s; p[i+1] = x * s + y * c; } return Object.assign({}, o, {p}); });
          W.replaceItems(turned); W.setTool('lasso'); W.selectIds(ids); }""")
        await page.wait_for_timeout(400)
        g2 = await page.evaluate(GRAPH)
        before2 = await page.evaluate("() => [...__inkwell.cur.items.keys()]")
        await page.click('#selGraph'); await page.wait_for_selector('#gAddDlg', state='visible')
        await page.uncheck('#gaLbl'); await page.fill('#gaFn', 'sin(x)'); await page.click('#gaAdd'); await page.wait_for_timeout(500)
        new2 = await page.evaluate(NEW, before2)
        inv2 = mapper(g2); worst = 0
        for it in new2:
            pts = it['p']
            for k in range(0, len(pts), 3):
                xv, yv = inv2(pts[k], pts[k+1]); worst = max(worst, abs(yv - math.sin(xv)))
        check(all(i['t'] == 's' for i in new2) and len(new2) >= 1 and worst < 0.03, f'moved, 1.5x larger and turned graph: sin(x) still on scale, no label ({worst:.4f})')
        w0 = new2[0]['w']; check(w0 > g['x']['ga']['w'] * 1.3, f'curve thickness follows the resize ({w0:.2f})')
        # label setting remembered, reload keeps the axis memory
        await page.evaluate("async () => { await __inkwell.flushSaves(); }"); await page.wait_for_timeout(500)
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("() => { __inkwell.setTool('lasso'); __inkwell.selectIds([...__inkwell.cur.items.values()].filter(i => i.g).map(i => i.id)); }"); await page.wait_for_timeout(400)
        check(not await page.evaluate("document.getElementById('selGraph').hidden"), 'after a reload the graph still offers Add formula')
        await page.click('#selGraph'); await page.wait_for_selector('#gAddDlg', state='visible')
        check(not await page.is_checked('#gaLbl'), 'label switch remembered')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(200)
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
