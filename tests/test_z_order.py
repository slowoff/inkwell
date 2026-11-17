# 2.7 (Rafael: "add a bring to the top and bring to the bottom when you select something"). Selection menu buttons
# Bring to front / Send to back set an optional z on items; drawing, text boxes, undo and new strokes follow it.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

# colour of the ink layer at a world point: 'r', 'b' or something else
AT = """([x, y]) => { const W = __inkwell, [MX, MY] = W.layerOff, d = devicePixelRatio, a = W.inkAt;
  const px = Math.round(d * (x * a.z + a.ox + MX)), py = Math.round(d * (y * a.z + a.oy + MY));
  const p = W.inkCv.getContext('2d').getImageData(px, py, 1, 1).data;
  return p[3] < 200 ? 'none' : p[0] > 180 && p[2] < 80 ? 'r' : p[2] > 180 && p[0] < 80 ? 'b' : `${p[0]},${p[1]},${p[2]},${p[3]}`; }"""
LINE = """([id, c, x0, y0, x1, y1]) => { const p = []; for(let i = 0; i <= 20; i++) p.push(x0 + (x1 - x0) * i / 20, y0 + (y1 - y0) * i / 20, 0.5);
  return {t: 's', id, c, w: 14, p}; }"""

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
        await pg.evaluate(f"""async () => {{ const W = __inkwell, L = {LINE};
          W.removeItems([...W.cur.items.keys()]);
          W.addItems([L(['zr', '#ff0000', 100, 200, 300, 200])]);
          W.addItems([L(['zb', '#0000ff', 200, 100, 200, 300])]);
          W.drawInk(); }}""")
        await pg.wait_for_timeout(300)
        check(await pg.evaluate(AT, [200, 200]) == 'b', 'blue drawn last is on top')
        check(await pg.evaluate("[...__inkwell.cur.items.values()].every(it => !('z' in it))"), 'no z on items until it is used (old pages unchanged)')

        await pg.evaluate("__inkwell.setTool('lasso'); __inkwell.selectIds(['zr'])"); await pg.wait_for_timeout(200)
        check(await pg.evaluate("(() => { const b = document.getElementById('selOrder'); return !b.hidden && b.offsetWidth > 0; })()"), 'Arrange button in the selection menu')
        await pg.click('#selOrder'); await pg.wait_for_timeout(200)
        check(await pg.is_visible('#selFront') and await pg.is_visible('#selBack'), 'Arrange opens Bring to front and Send to back')
        await pg.click('#selFront'); await pg.wait_for_timeout(300)
        check(await pg.evaluate("document.getElementById('orderPop').hidden"), 'the little menu closes after a choice')
        check(await pg.evaluate(AT, [200, 200]) == 'r', 'Bring to front: red now over blue')
        note = await pg.evaluate("document.getElementById('note').textContent")
        check('front' in note.lower(), f'short message ({note})')
        check(await pg.evaluate("__inkwell.cur.items.get('zr').z") == 1, 'red got z 1')
        await pg.evaluate("__inkwell.drawInk()"); await pg.wait_for_timeout(100)
        check(await pg.evaluate(AT, [200, 200]) == 'r', 'still on top after a full redraw')

        await pg.evaluate("__inkwell.undo()"); await pg.wait_for_timeout(300)
        check(await pg.evaluate(AT, [200, 200]) == 'b' and not await pg.evaluate("'z' in __inkwell.cur.items.get('zr')"), 'Undo puts it back under')
        await pg.evaluate("__inkwell.redo()"); await pg.wait_for_timeout(300)
        check(await pg.evaluate(AT, [200, 200]) == 'r', 'Redo brings it to front again')

        await pg.evaluate("__inkwell.selectIds(['zr'])"); await pg.wait_for_timeout(100)
        await pg.evaluate("document.getElementById('selBack').click()"); await pg.wait_for_timeout(300)
        check(await pg.evaluate(AT, [200, 200]) == 'b' and await pg.evaluate("__inkwell.cur.items.get('zr').z") < 0, 'Send to back: red under blue again')

        # after something was brought to front, a new stroke still lands on top
        await pg.evaluate("__inkwell.selectIds(['zr']); document.getElementById('selFront').click()"); await pg.wait_for_timeout(200)
        await pg.evaluate(f"async () => {{ const L = {LINE}; __inkwell.addItems([L(['zn', '#0000ff', 150, 150, 250, 250])]); }}"); await pg.wait_for_timeout(300)
        check(await pg.evaluate(AT, [200, 200]) == 'b', 'a new stroke goes on top of what was brought to front')
        check(await pg.evaluate(AT, [120, 200]) == 'r', 'the rest of the red line is still drawn')

        # saved and loaded: z survives serialising
        z = await pg.evaluate("(() => { const it = __inkwell.cur.items.get('zr'); return [it.z, __inkwell.cur.items.get('zn').z]; })()")
        check(z[0] >= 1 and z[1] == z[0], f'new stroke shares the top z, placed after it ({z})')

        # text boxes follow z with their stacking order
        await pg.evaluate("""() => { const W = __inkwell; W.addItems([{t: 'x', id: 'xa', x: 400, y: 400, w: 120, fs: 1, html: 'A'}, {t: 'x', id: 'xb', x: 410, y: 405, w: 120, fs: 1, html: 'B'}]); W.selectIds(['xa']); }""")
        await pg.wait_for_timeout(200)
        await pg.evaluate("document.getElementById('selFront').click()"); await pg.wait_for_timeout(200)
        zi = await pg.evaluate("(() => { const q = id => +getComputedStyle(document.querySelector(`[data-id=${id}]`)).zIndex || 0; return [q('xa'), q('xb')]; })()")
        check(zi[0] > zi[1], f'text box brought to front sits above the other ({zi})')
        check(await pg.evaluate("TIP_TEXT.some(t => t[0].includes('#selOrder'))"), 'hover tip for Arrange')
        check(not errs, f'no page errors {errs}')
        await b.close()
    if fails: print('FAILED:', len(fails)); raise SystemExit(1)
    print('ALL OK')

asyncio.run(main())
