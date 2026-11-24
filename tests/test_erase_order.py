# 2.7.3 (Rafael: "when i partially erase sum that line jumps to the top instead of staying on its layer"). The pieces a
# Partial cut leaves were added at the end of the page (drawn over everything) and lost the stroke's layer (ly), Arrange
# order (z) and technical line type (ls). Undo of an erase also put strokes back on top. Checks pixels, order, undo, redo.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

AT = """([x, y]) => { const W = __inkwell, [MX, MY] = W.layerOff, d = devicePixelRatio, a = W.inkAt;
  const px = Math.round(d * (x * a.z + a.ox + MX)), py = Math.round(d * (y * a.z + a.oy + MY));
  const p = W.inkCv.getContext('2d').getImageData(px, py, 1, 1).data;
  return p[3] < 200 ? 'none' : p[0] > 180 && p[2] < 80 ? 'r' : p[2] > 180 && p[0] < 80 ? 'b' : `${p[0]},${p[1]},${p[2]},${p[3]}`; }"""
SETUP = """async () => { const W = __inkwell; await W.newPage();
  const L = (id, c, x0, y0, x1, y1, w = 10) => { const p = []; for(let i = 0; i <= 40; i++) p.push(x0 + (x1 - x0) * i / 40, y0 + (y1 - y0) * i / 40, 0.5); return {t: 's', id, c, w, p}; };
  // red line under a blue line crossing it at x = 250
  W.addItems([Object.assign(L('rA', '#ff0000', 100, 150, 300, 150), {ly: 'n'})]);
  W.addItems([L('bA', '#0000ff', 250, 100, 250, 200)]);
  // blue line under a red one that was brought to front (z)
  W.addItems([L('bB', '#0000ff', 250, 250, 250, 350)]);
  W.addItems([L('rB', '#ff0000', 100, 300, 300, 300)]);
  W.addItems([L('bC', '#0000ff', 200, 250, 200, 350)]);
  W.replaceItems([Object.assign({}, W.cur.items.get('rB'), {z: 5})]);   // Bring to front: over bC
  W.cam.z = 1; W.cam.ox = 20; W.cam.oy = 20; W.drawInk(); W.setTool('eraser'); }"""
ORDER = "[...__inkwell.cur.items.values()].map(it => it.c === '#ff0000' ? 'r' : it.id[0] === 'b' ? it.id : '?').join(' ')"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await pg.wait_for_timeout(2500)
        await pg.wait_for_function('!!(window.__inkwell && window.__inkwellBooted && window.__inkwell.cur)', timeout=15000)
        await pg.evaluate(SETUP); await pg.wait_for_timeout(500)
        st = await pg.evaluate("(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.left, b.top]; })()")
        def scr(x, y): return (st[0] + 20 + x, st[1] + 20 + y)
        async def drag(x0, y0, x1, y1, n=30):
            await pg.mouse.move(*scr(x0, y0)); await pg.mouse.down()
            for k in range(1, n + 1): await pg.mouse.move(*scr(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n))
            await pg.mouse.up(); await pg.wait_for_timeout(300)
        at = lambda x, y: pg.evaluate(AT, [x, y])
        redraw = lambda: pg.evaluate("__inkwell.drawInk()")

        check(await at(250, 150) == 'b' and await at(200, 300) == 'r', 'before: blue over the first red line, second red over blue')
        await pg.evaluate("__inkwell.prefs.eraser.mode = 'area'")
        await drag(150, 120, 150, 330)
        check(await at(150, 150) == 'none' and await at(120, 150) == 'r', 'Partial eraser cut a gap in the red lines')
        check(await at(250, 150) == 'b', f'cut red piece stays under the blue line while erasing ({await at(250, 150)})')
        await redraw()
        check(await at(250, 150) == 'b', 'and after a full repaint')
        check(await at(200, 300) == 'r', 'brought-to-front red piece stays over the later blue line')
        print('     order:', await pg.evaluate(ORDER))
        check(await pg.evaluate(ORDER) == 'r r bA bB r r bC', 'pieces sit where the cut stroke was in the drawing order')
        pc = await pg.evaluate("[...__inkwell.cur.items.values()].filter(it => it.c === '#ff0000').map(it => [it.ly || '', it.z || 0])")
        check(pc == [['n', 0], ['n', 0], ['', 5], ['', 5]], f'pieces keep the layer and z of the cut stroke {pc}')
        # fast move cuts the pieces again within one move
        await drag(110, 120, 190, 330, n=2)
        check(await at(250, 150) in ('b', 'none'), 'pieces cut again stay under blue')
        o2 = await pg.evaluate(ORDER)
        check(o2.startswith('r') and o2.index('bA') > o2.index('r'), f'order after second cut: {o2}')
        await pg.evaluate("__inkwell.undo()"); await pg.wait_for_timeout(200)
        await pg.evaluate("__inkwell.undo()"); await pg.wait_for_timeout(200); await redraw()
        check(await pg.evaluate("[...__inkwell.cur.items.keys()].join(' ')") == 'rA bA bB rB bC', f'Undo restores the original order ({await pg.evaluate("[...__inkwell.cur.items.keys()].join(` `)")})')
        check(await at(250, 150) == 'b', 'after Undo the red line is still under blue')
        await pg.evaluate("__inkwell.redo()"); await pg.wait_for_timeout(200); await redraw()
        check(await pg.evaluate(ORDER) == 'r r bA bB r r bC', f'Redo puts the pieces back in place ({await pg.evaluate(ORDER)})')
        check(await at(250, 150) == 'b', 'after Redo the piece is still under blue')
        await pg.evaluate("__inkwell.undo()"); await pg.wait_for_timeout(200)

        # Stroke eraser: Undo brings the stroke back in its place
        await pg.evaluate("__inkwell.prefs.eraser.mode = 'stroke'")
        await drag(150, 120, 150, 180)
        check(not await pg.evaluate("__inkwell.cur.items.has('rA')"), 'Stroke eraser removed the red line')
        await pg.evaluate("__inkwell.undo()"); await pg.wait_for_timeout(200); await redraw()
        check(await pg.evaluate("[...__inkwell.cur.items.keys()].join(' ')") == 'rA bA bB rB bC' and await at(250, 150) == 'b', 'Stroke eraser Undo: back under blue')
        # deleting with removeItems (Select + delete) and Undo
        await pg.evaluate("__inkwell.removeItems(['rA'])"); await pg.evaluate("__inkwell.undo()"); await pg.wait_for_timeout(200); await redraw()
        check(await pg.evaluate("[...__inkwell.cur.items.keys()].join(' ')") == 'rA bA bB rB bC' and await at(250, 150) == 'b', 'Delete + Undo: back in its place')
        check(not errs, f'no page errors {errs}')
        await b.close()
    if fails: print('FAILED:', len(fails)); raise SystemExit(1)

asyncio.run(main())
