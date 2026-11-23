# 2.7.2 (Rafael: "inkwell's been lagging when I erase stuff"). Every eraser hit repainted all the ink on the page and every
# sub-step of a move looked at every item three times. Now only the boxes that changed are repainted and the items near the
# move are found once. Checks both eraser modes still erase correctly, undo, marks, text boxes, and no full repaint.
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
  const L = (id, c, x0, y0, x1, y1, w = 6) => { const p = []; for(let i = 0; i <= 40; i++) p.push(x0 + (x1 - x0) * i / 40, y0 + (y1 - y0) * i / 40, 0.5); return {t: 's', id, c, w, p}; };
  const many = [];
  // a full page: 6000 small blue strokes below the test lines
  for(let i = 0; i < 6000; i++){ const x = 60 + (i % 100) * 6, y = 400 + Math.floor(i / 100) * 6; many.push(L('g' + i, '#0000ff', x, y, x + 3, y + 2, 2)); }
  W.addItems(many);
  W.addItems([L('rA', '#ff0000', 100, 150, 300, 150), L('rB', '#ff0000', 100, 250, 300, 250)]);
  W.addItems([Object.assign(L('mK', '#ff0000', 100, 330, 300, 330), {mk: 1, at: Date.now()})]);
  W.addItems([{t: 'x', id: 'xT', x: 380, y: 140, w: 120, fs: 1, html: '<p>Erase me</p>'}]);
  W.cam.z = 1; W.cam.ox = 20; W.cam.oy = 20; W.drawInk(); W.setTool('eraser'); }"""

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
        await pg.evaluate("""() => { window.__full = 0; const o = drawInk; drawInk = function(){ window.__full++; return o.apply(this, arguments); };
          window.__eT = []; const e = eraseAt; eraseAt = function(){ const t = performance.now(); const r = e.apply(this, arguments); window.__eT.push(performance.now() - t); return r; }; }""")
        st = await pg.evaluate("(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.left, b.top]; })()")
        def scr(x, y): return (st[0] + 20 + x, st[1] + 20 + y)
        async def drag(x0, y0, x1, y1, n=30):
            await pg.mouse.move(*scr(x0, y0)); await pg.mouse.down()
            for k in range(1, n + 1): await pg.mouse.move(*scr(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n))
            await pg.mouse.up(); await pg.wait_for_timeout(300)
        has = lambda id: pg.evaluate(f"__inkwell.cur.items.has('{id}')")

        check(await pg.evaluate(AT, [150, 150]) == 'r', 'red line drawn before erasing')
        # --- Stroke eraser ---
        await pg.evaluate("__inkwell.prefs.eraser.mode = 'stroke'; window.__full = 0; window.__eT = []")
        await drag(200, 120, 200, 280)
        check(not await has('rA') and not await has('rB'), 'Stroke eraser removes both lines it crossed')
        check(await pg.evaluate(AT, [150, 150]) == 'none' and await pg.evaluate(AT, [280, 250]) == 'none', 'their ink is gone from the screen')
        check(await pg.evaluate("window.__full") == 0, f'no full ink repaint while erasing ({await pg.evaluate("window.__full")})')
        check(await pg.evaluate("[...__inkwell.cur.items.keys()].filter(k => k[0] === 'g').length") == 6000, 'the other 6000 strokes are untouched')
        check(await pg.evaluate(AT, [61, 400]) == 'b', 'other ink still drawn')
        t = await pg.evaluate("(() => { const a = window.__eT.slice().sort((x, y) => x - y); return [a.length, a[Math.floor(a.length / 2)], a[a.length - 1]]; })()")
        print(f'     eraseAt calls {t[0]}, median {t[1]:.2f} ms, max {t[2]:.2f} ms (6000 strokes on the page)')
        check(t[1] < 4, f'one eraser move is quick on a full page (median {t[1]:.2f} ms)')
        await pg.evaluate("__inkwell.undo()"); await pg.wait_for_timeout(300)
        check(await has('rA') and await has('rB') and await pg.evaluate(AT, [150, 150]) == 'r', 'Undo brings both lines back')

        # --- Partial eraser ---
        await pg.evaluate("__inkwell.prefs.eraser.mode = 'area'; window.__full = 0")
        await drag(200, 120, 200, 280)
        pieces = await pg.evaluate("[...__inkwell.cur.items.values()].filter(it => it.t === 's' && it.c === '#ff0000' && !it.mk).length")
        check(not await has('rA') and pieces == 4, f'Partial eraser cuts each line in two ({pieces} pieces)')
        check(await pg.evaluate(AT, [200, 150]) == 'none' and await pg.evaluate(AT, [120, 150]) == 'r' and await pg.evaluate(AT, [290, 250]) == 'r', 'gap under the eraser, the rest stays drawn')
        check(await pg.evaluate("window.__full") == 0, 'no full repaint for the partial eraser either')
        # a fast move across: sub-steps cut the new pieces again
        await drag(130, 120, 270, 280, n=3)
        check(await pg.evaluate(AT, [165, 160]) == 'none' or await pg.evaluate(AT, [165, 150]) == 'none', 'fast diagonal move still erases along its whole path')
        await pg.evaluate("__inkwell.undo(); __inkwell.undo()"); await pg.wait_for_timeout(300)
        check(await has('rA') and await has('rB') and await pg.evaluate(AT, [200, 150]) == 'r', 'Undo puts the cut lines back whole')

        # --- marks and text boxes ---
        await pg.evaluate("__inkwell.prefs.eraser.mode = 'stroke'")
        await drag(200, 310, 200, 350)
        check(not await has('mK') and await pg.evaluate(AT, [150, 330]) == 'none', 'a marked stroke is erased and disappears')
        await drag(400, 130, 400, 175)
        check(not await has('xT') and not await pg.evaluate("!!document.querySelector('[data-id=xT]')"), 'Stroke eraser removes a text box')
        await pg.evaluate("__inkwell.undo()"); await pg.wait_for_timeout(300)
        check(await has('xT'), 'Undo brings the text box back')
        check(not errs, f'no page errors {errs}')
        await b.close()
    if fails: print('FAILED:', len(fails)); raise SystemExit(1)

asyncio.run(main())
