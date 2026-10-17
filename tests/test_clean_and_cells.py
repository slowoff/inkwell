# Free up space keeps used pictures; typed text snaps into a table cell and fits (synthetic table, no real worksheets).
import asyncio, base64, io, os
from playwright.async_api import async_playwright
from PIL import Image, ImageDraw
PORT = os.environ.get('INKWELL_PORT', '8766')

def table_jpeg():
    W, H = 600, 360
    im = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(im)
    xs, ys = [40, 200, 360, 560], [60, 120, 180, 240, 300]
    for x in xs: d.line([(x, ys[0]), (x, ys[-1])], fill='black', width=2)
    for y in ys: d.line([(xs[0], y), (xs[-1], y)], fill='black', width=2)
    d.text((50, 20), 'Question text above the table', fill='black')
    b = io.BytesIO(); im.save(b, 'JPEG', quality=92); return b.getvalue(), W, H

async def main():
    ok = True
    def check(c, m):
        nonlocal ok; print(('PASS ' if c else 'FAIL ') + m); ok = ok and bool(c)
    async with async_playwright() as p:
        b = await p.chromium.launch(); c = await b.new_context(viewport={'width': 1180, 'height': 820})
        await c.route('**supabase.co/**', lambda r: r.abort())
        pg = await c.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(f'http://localhost:{PORT}/'); await pg.wait_for_timeout(3500)
        r = await pg.evaluate("""async () => { const W = __inkwell; await W.newPage();
          await W.IDB.put('assets', {id: 'a-test1', blob: new Blob(['x'], {type: 'image/jpeg'}), type: 'image/jpeg'});
          W.addItems([{t: 'i', id: 'i_1', x: 0, y: 0, w: 100, h: 100, a: 'a-test1'}]); await W.flushSaves();
          let plan = await W.cleanScan(); const usedKept = !plan.local.some(x => x.id === 'a-test1');
          W.removeItems(['i_1']); await W.flushSaves();
          plan = await W.cleanScan(); return {usedKept, unusedFound: plan.local.some(x => x.id === 'a-test1')}; }""")
        check(r['usedKept'] and not r['unusedFound'], 'Free up space keeps used pictures, and also ones Undo could bring back (%s)' % r)
        jpg, W, H = table_jpeg(); b64 = base64.b64encode(jpg).decode()
        res = await pg.evaluate("""async (b64) => { const W = __inkwell; await W.newPage();
          const bin = atob(b64), u8 = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          const blob = new Blob([u8], {type: 'image/jpeg'}); const a = await W.saveAsset(blob);
          W.addItems([{t: 'i', id: 'i_ws', x: 20, y: 20, w: 800, h: 480, a}]);
          const fr = await W.pageLines(a); W.cam.z = 1; W.cam.ox = 56; W.cam.oy = 28;
          return {nh: fr.length, nv: (fr.v || []).length}; }""", b64)
        print(' lines found:', res)
        k = 800 / W
        inside = await pg.evaluate("([x, y]) => __inkwell.snapCellAt(x, y)", [20 + 280 * k, 20 + 150 * k])
        above = await pg.evaluate("([x, y]) => __inkwell.snapCellAt(x, y)", [20 + 280 * k, 20 + 30 * k])
        check(bool(inside) and not above, 'a cell is found inside the table, none above it (%s)' % inside)
        await pg.evaluate("() => __inkwell.setTool('text')")
        st = await pg.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        await pg.mouse.click(st[0] + 56 + 20 + 280 * k, st[1] + 28 + 20 + 150 * k); await pg.wait_for_timeout(300)
        await pg.keyboard.type('A long answer that has to shrink to fit into this cell', delay=5); await pg.wait_for_timeout(300)
        it = await pg.evaluate("""() => { const c = __inkwell.cur; const it = [...c.items.values()].find(i => i.t === 'x'); const el = document.querySelector('[data-id="' + it.id + '"]'); return {ch: it.ch, sh: el.scrollHeight}; }""")
        check(it.get('ch') and it['sh'] <= it['ch'] + 5, 'typed text fits inside the cell (%s)' % it)
        check(not errs, 'no page errors: %s' % errs[:3])
        await b.close()
    print('ALL OK' if ok else 'SOME FAILED')
    if not ok: raise SystemExit(1)
asyncio.run(main())
