# 2.0 stage 2: dimension lines that follow the part, and typing exact sizes (technical notebooks).
import asyncio, os, math, re
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
MM = 96 / 25.4
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

DIMS = """[...__inkwell.cur.items.values()].filter(i => i.dim).map(d => ({id: d.id, k: d.dim.k, parts: d.dim.parts,
  text: (__inkwell.cur.items.get(d.dim.parts[4]) || {}).html || '', a: [d.p[0], d.p[1]], b: [d.p[d.p.length-3], d.p[d.p.length-2]]}))"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500); await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage(); const pg = W.docs.get(W.cur.id), s = W.docs.get(pg.data.sec);
            W.docs.get(s.data.nb).data.tech = true; W.prefs.techSnap = 5; W.prefs.techLs = 'k'; W.setTool('pen');
            W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.invalidate(); }""")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        async def drag(pts):
            await page.mouse.move(st[0] + pts[0][0], st[1] + pts[0][1]); await page.mouse.down()
            for x, y in pts[1:]: await page.mouse.move(st[0] + x, st[1] + y, steps=8)
            await page.mouse.up(); await page.wait_for_timeout(300)
        # a 60 x 40 mm rectangle at (20 mm, 40 mm)
        await page.evaluate("__inkwell.startPick({kind: 'shape', shape: 'rect'})")
        x0, y0, x1, y1 = 20 * MM, 40 * MM, 80 * MM, 80 * MM
        await drag([(x0, y0), (x0 + 50, y0 + 50), (x1, y1)])
        rid = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.geo && i.geo.k === 'r').id")
        check(bool(rid), 'rectangle drawn')
        # shapes menu offers the dimension only here
        await page.evaluate("document.getElementById('shapeRail').click()"); await page.wait_for_timeout(200)
        vis = await page.evaluate("!document.querySelector('#shapeGrid [data-shape=\"dim\"]').hidden")
        check(vis, 'Dimension in the shapes menu of a technical notebook')
        await page.evaluate("closePops()")
        # dimension along the top edge: corner to corner
        await page.evaluate("__inkwell.startPick({kind: 'shape', shape: 'dim'})")
        await drag([(x0 + 3, y0 + 2), (x0 + 80, y0 - 10), (x1 - 2, y0 + 3)])
        d = await page.evaluate(DIMS)
        check(len(d) == 1, f'one dimension ({len(d)})')
        if d:
            t = re.sub('<[^>]+>', '', d[0]['text'])
            check(t == '60', f'it reads 60 ({t!r})')
            check(d[0]['a'][1] < y0 - 5, f'placed above the rectangle, outside it ({d[0]["a"][1]:.1f} < {y0:.1f})')
            n = await page.evaluate(f"__inkwell.cur.items.get('{d[0]['id']}').dim.parts.filter(id => __inkwell.cur.items.get(id)).length")
            check(n == 5, f'two extension lines, two arrowheads and the number ({n})')
        # type an exact size: width 75 mm -> the rectangle and the dimension change, one undo step
        await page.evaluate(f"__inkwell.setTool('lasso'); __inkwell.selectIds(['{rid}'])"); await page.wait_for_timeout(200)
        check(await page.evaluate("!document.getElementById('selSize').hidden"), 'Size button shown for one rectangle')
        await page.evaluate("document.getElementById('selSize').click()"); await page.wait_for_timeout(200)
        vals = await page.evaluate("[...document.querySelectorAll('#sizeRows input')].map(i => i.dataset.k + '=' + i.value)")
        check(vals == ['w=60', 'h=40'], f'current width and height shown ({vals})')
        await page.evaluate("const i = document.querySelector('#sizeRows [data-k=\"w\"]'); i.value = '75'; document.getElementById('sizeForm').requestSubmit()"); await page.wait_for_timeout(300)
        g = await page.evaluate(f"__inkwell.cur.items.get('{rid}').geo.v")
        check(abs((g[2] - g[0]) / MM - 75) < 1e-6 and abs((g[3] - g[1]) / MM - 40) < 1e-6, f'rectangle is now 75 x 40 mm ({[(g[2]-g[0])/MM, (g[3]-g[1])/MM]})')
        d = await page.evaluate(DIMS); t = re.sub('<[^>]+>', '', d[0]['text']) if d else ''
        check(t == '75', f'the dimension follows: {t!r}')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(200)
        d = await page.evaluate(DIMS); t = re.sub('<[^>]+>', '', d[0]['text']) if d else ''
        g = await page.evaluate(f"__inkwell.cur.items.get('{rid}').geo.v")
        check(t == '60' and abs((g[2] - g[0]) / MM - 60) < 1e-6, f'one undo puts both back ({t!r})')
        # bad input is refused with a message
        await page.evaluate(f"__inkwell.selectIds(['{rid}']); document.getElementById('selSize').click()"); await page.wait_for_timeout(200)
        await page.evaluate("const i = document.querySelector('#sizeRows [data-k=\"h\"]'); i.value = 'abc'; document.getElementById('sizeForm').requestSubmit()"); await page.wait_for_timeout(200)
        check(await page.evaluate("!document.getElementById('sizeErr').hidden"), 'invalid size: message shown, nothing changed')
        await page.evaluate("closePops()")
        # moving the rectangle: the dimension moves with it; moving the dimension further out keeps it there
        moved = await page.evaluate(f"""(() => {{ const W = __inkwell, it = W.cur.items.get('{rid}'); const o = transformItem(it, {{ax: 0, ay: 0, s: 1, dx: 40, dy: 30}}); W.replaceItems([o]); return 1; }})()""")
        d2 = await page.evaluate(DIMS)
        check(d2 and abs(d2[0]['a'][0] - d[0]['a'][0] - 40) < 1e-6 and abs(d2[0]['a'][1] - d[0]['a'][1] - 30) < 1e-6, 'moving the part moves its dimension')
        dim_ids = await page.evaluate(f"(() => {{ const d = __inkwell.cur.items.get('{d2[0]['id']}'); return [d.id, ...d.dim.parts]; }})()")
        await page.evaluate(f"""(() => {{ const W = __inkwell, ids = {dim_ids}; const its = ids.map(id => W.cur.items.get(id)).filter(Boolean); const os = its.map(it => transformItem(it, {{ax: 0, ay: 0, s: 1, dx: 0, dy: -20}})); W.replaceItems(os); }})()""")
        d3 = await page.evaluate(DIMS)
        check(d3 and abs(d3[0]['a'][1] - (d2[0]['a'][1] - 20)) < 0.01 and abs(d3[0]['a'][0] - d2[0]['a'][0]) < 0.01, f'dimension moved further out stays there, still on the corners ({d3[0]["a"] if d3 else None})')
        # diameter: tap a circle
        await page.evaluate("__inkwell.setTool('pen'); __inkwell.startPick({kind: 'shape', shape: 'ellipse'})")
        await drag([(400, 400), (450, 450), (400 + 30 * MM, 400 + 30 * MM)])
        cid = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.geo && i.geo.k === 'e').id")
        await page.evaluate("__inkwell.startPick({kind: 'shape', shape: 'dim'})")
        await page.mouse.click(st[0] + 400 + 15 * MM, st[1] + 400 + 15 * MM); await page.wait_for_timeout(300)
        dd = [x for x in await page.evaluate(DIMS) if x['k'] == 'dia']
        t = re.sub('<[^>]+>', '', dd[0]['text']) if dd else ''
        check(t == '⌀30', f'tap on a circle: diameter {t!r}')
        await page.evaluate(f"__inkwell.setTool('lasso'); __inkwell.selectIds(['{cid}']); document.getElementById('selSize').click()"); await page.wait_for_timeout(200)
        await page.evaluate("const i = document.querySelector('#sizeRows [data-k=\"d\"]'); i.value = '42,5'; document.getElementById('sizeForm').requestSubmit()"); await page.wait_for_timeout(300)
        dd = [x for x in await page.evaluate(DIMS) if x['k'] == 'dia']; t = re.sub('<[^>]+>', '', dd[0]['text']) if dd else ''
        check(t == '⌀42.5', f'diameter typed with a comma, dimension follows ({t!r})')
        # a line: length and angle
        await page.evaluate("__inkwell.setTool('pen'); __inkwell.startPick({kind: 'shape', shape: 'line'})")
        await drag([(100, 700), (200, 700), (300, 700)])
        lid = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.geo && i.geo.k === 'l' && !i.dim).pop().id")
        await page.evaluate(f"__inkwell.setTool('lasso'); __inkwell.selectIds(['{lid}']); document.getElementById('selSize').click()"); await page.wait_for_timeout(200)
        await page.evaluate("document.querySelector('#sizeRows [data-k=\"len\"]').value = '50'; document.querySelector('#sizeRows [data-k=\"ang\"]').value = '90'; document.getElementById('sizeForm').requestSubmit()"); await page.wait_for_timeout(300)
        v = await page.evaluate(f"__inkwell.cur.items.get('{lid}').geo.v")
        check(abs(v[0] - v[2]) < 1e-6 and abs((v[1] - v[3]) / MM - 50) < 1e-6, f'line is now 50 mm straight up ({v})')
        # deleting the part leaves the dimension as it was
        await page.evaluate(f"__inkwell.removeItems(['{rid}'])")
        d4 = await page.evaluate(DIMS)
        check(len([x for x in d4 if x['k'] == 'lin']) == 1, 'deleting the part keeps its dimension')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
