# 1.59: turn imported pages: select + turn button (picture turned 90°, w/h swapped, fields follow, undo), and
# "Turn pages" in the import window (image and PDF import come in turned).
import asyncio, os, io, tempfile
from playwright.async_api import async_playwright
from PIL import Image, ImageDraw
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

def sample_png(path):
    im = Image.new('RGB', (400, 200), 'white'); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 60, 60], fill=(255, 0, 0))   # red mark top left
    im.save(path)

def sample_pdf(path):
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import landscape, A4
    c = canvas.Canvas(path, pagesize=landscape(A4)); c.setFillColorRGB(1, 0, 0); c.rect(0, landscape(A4)[1] - 80, 80, 80, fill=1, stroke=0)
    c.drawString(200, 300, 'Sideways scan'); c.showPage(); c.save()

# colour at fraction (fx, fy) of an item's stored picture
PIX = """async ([id, fx, fy]) => { const it = __inkwell.cur.items.get(id), r = await __inkwell.IDB.get('assets', it.a);
  const b = await createImageBitmap(r.blob), c = document.createElement('canvas'); c.width = b.width; c.height = b.height; const x = c.getContext('2d'); x.drawImage(b, 0, 0);
  const d = x.getImageData(Math.floor(fx * (b.width - 1)), Math.floor(fy * (b.height - 1)), 1, 1).data; return [d[0], d[1], d[2], b.width, b.height]; }"""
red = lambda p: p[0] > 200 and p[1] < 80 and p[2] < 80

async def main():
    tmp = tempfile.mkdtemp(); png = os.path.join(tmp, 'side.png'); pdf = os.path.join(tmp, 'side.pdf')
    sample_png(png); sample_pdf(pdf)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        # 1. import an image turned right
        await page.click('#insertBtn'); await page.set_input_files('#importFile', png); await page.wait_for_timeout(800)
        await page.click('#impRotR'); await page.wait_for_timeout(200)
        pv = await page.evaluate("(() => { const c = document.querySelector('#importPreview canvas, #importPreview img'); return [c.width || c.naturalWidth, c.height || c.naturalHeight]; })()")
        lbl = await page.evaluate("document.getElementById('impRotVal').textContent")
        check(pv[1] > pv[0] and lbl == '90° right', f'preview turns with the button ({pv}, {lbl})')
        await page.click('#impGo'); await page.wait_for_timeout(1200)
        it = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'i')")
        check(it and it['h'] > it['w'] * 1.9, f'image placed turned: tall now ({it and (round(it["w"]), round(it["h"]))})')
        px = await page.evaluate(PIX, [it['id'], 0.95, 0.05])
        check(red(px) and px[4] > px[3], f'red mark is now top right, as after turning right ({px})')
        # 2. select it and turn back left (3 x right = left)
        await page.evaluate("(id) => { __inkwell.setTool('lasso'); __inkwell.selectIds([id]); }", it['id']); await page.wait_for_timeout(300)
        vis = await page.evaluate("[!document.getElementById('selRot90').hidden, document.getElementById('selRot').hidden]")
        check(vis == [True, True], f'page selected: turn button shown, free turn handle hidden ({vis})')
        before = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'i')")
        await page.click('#selRot90'); await page.wait_for_timeout(1200)
        aft = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'i')")
        check(abs(aft['w'] - before['h']) < 0.01 and abs(aft['h'] - before['w']) < 0.01 and aft['a'] != before['a'], 'turn button: width and height swap, new picture')
        c0 = [before['x'] + before['w'] / 2, before['y'] + before['h'] / 2]; c1 = [aft['x'] + aft['w'] / 2, aft['y'] + aft['h'] / 2]
        check(abs(c0[0] - c1[0]) < 0.5 and abs(c0[1] - c1[1]) < 0.5, 'a single page turns around its own centre')
        px = await page.evaluate(PIX, [aft['id'], 0.95, 0.95])
        check(red(px), f'picture really turned (mark now bottom right) ({px})')
        sel = await page.evaluate("__inkwell.sel && __inkwell.sel.ids.length")
        check(sel == 1, 'still selected after turning')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(400)
        u = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'i')")
        check(u['a'] == before['a'] and abs(u['w'] - before['w']) < 0.01, 'undo brings the page back as it was')
        # 3. page with a field and ink: both turn with it
        await page.evaluate("""() => { const W = __inkwell, it = [...W.cur.items.values()].find(i => i.t === 'i');
          W.replaceItems([Object.assign({}, it, {f: [{k: 'tx', x: 0.1, y: 0.2, w: 0.3, h: 0.05, v: 'x'}]})]);
          W.addItems([{t: 's', id: 'sInk', c: '#C2362B', w: 3, hl: 0, p: [it.x + 10, it.y + 10, .5, it.x + 40, it.y + 10, .5]}]);
          W.setTool('lasso'); W.selectIds([it.id, 'sInk']); }"""); await page.wait_for_timeout(300)
        await page.click('#selRot90'); await page.wait_for_timeout(1200)
        f = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'i').f[0]")
        check(abs(f['x'] - (1 - 0.2 - 0.05)) < 1e-6 and abs(f['y'] - 0.1) < 1e-6 and abs(f['w'] - 0.05) < 1e-6 and abs(f['h'] - 0.3) < 1e-6, f'fill-in field turns with the page ({f})')
        ink = await page.evaluate("(() => { const s = __inkwell.cur.items.get('sInk'); return [s.p[0], s.p[1], s.p[3], s.p[4]]; })()")
        check(abs(ink[0] - ink[2]) < 0.5 and abs(ink[3] - ink[1]) > 25, f'ink on the page turns too (horizontal line is now vertical) ({ink})')
        # 4. PDF turned left on import
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        await page.click('#insertBtn'); await page.set_input_files('#importFile', pdf); await page.wait_for_timeout(1500)
        await page.click('#impRotL'); await page.wait_for_timeout(300)
        await page.click('#impGo'); await page.wait_for_timeout(3000)
        it = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'i')")
        check(it and it['h'] > it['w'], f'landscape PDF page imported turned to portrait ({it and (round(it["w"]), round(it["h"]))})')
        px = await page.evaluate(PIX, [it['id'], 0.03, 0.97])
        check(red(px), f'turned left: the top-left mark is now bottom left ({px})')
        pt = await page.evaluate("(a) => __inkwell.docs ? null : null", it['a'])
        # 5. reopening the import window starts upright
        await page.click('#insertBtn'); await page.wait_for_timeout(200)
        check(await page.evaluate("document.getElementById('impRotVal').textContent") == 'upright', 'next import starts upright')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
