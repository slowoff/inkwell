# 1.53: Select tool Free | Box; Box can "Copy as picture" (PNG on the clipboard, or a window to press and hold);
# Ctrl+V / Paste button paste pictures and text from other apps; Inkwell's own copy still pastes as items.
import asyncio, os, io, base64
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def boot(page):
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

def png_b64(w, h, color):
    from PIL import Image
    im = Image.new('RGB', (w, h), color); buf = io.BytesIO(); im.save(buf, 'PNG')
    return base64.b64encode(buf.getvalue()).decode()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, permissions=['clipboard-read', 'clipboard-write'])
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await boot(page)
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage();
          const p = []; for(let i = 0; i < 30; i++) p.push(100 + i * 5, 120 + Math.sin(i / 3) * 10, 0.5);
          W.addItems([{t: 's', id: 'sA', c: '#c00', w: 3, p}, {t: 'x', id: 'xA', x: 100, y: 200, w: 260, fs: 1, html: '<p>Hello box</p>'}]);
          W.cam.z = 1; W.cam.ox = 20; W.cam.oy = 20; W.setTool('lasso'); }""")
        await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.left, b.top]; })()")
        cam = {'z': 1, 'ox': 20, 'oy': 20}
        async def readcam(): cam.update(await page.evaluate("({z: __inkwell.cam.z, ox: __inkwell.cam.ox, oy: __inkwell.cam.oy})"))
        def scr(x, y): return (st[0] + cam['ox'] + x * cam['z'], st[1] + cam['oy'] + y * cam['z'])
        async def drag(x0, y0, x1, y1):
            await readcam()
            await page.mouse.move(*scr(x0, y0)); await page.mouse.down()
            for k in range(1, 13): await page.mouse.move(*scr(x0 + (x1 - x0) * k / 12, y0 + (y1 - y0) * k / 12))
            await page.mouse.up(); await page.wait_for_timeout(300)
        async def state():
            return await page.evaluate("""(() => ({sel: __inkwell.sel ? __inkwell.sel.ids.slice().sort() : [], selShot: !document.getElementById('selShot').hidden,
              ts: !document.getElementById('tsLayer').hidden, tsShot: !document.getElementById('tsShot').hidden, tsCopy: !document.getElementById('tsCopy').hidden,
              area: !!document.querySelector('#tsBox b')}))()""")

        # 1. Free | Box shown with the Select tool
        m = await page.evaluate("(() => ({shown: !document.getElementById('lassoMode').hidden, on: document.querySelector('#lassoMode .on').dataset.m, paste: !document.getElementById('pasteBtn').hidden}))()")
        check(m['shown'] and m['on'] == 'free' and m['paste'], f'Select tool shows Free | Box (Free) and Paste ({m})')
        await page.click('#lassoMode [data-m="box"]'); await page.wait_for_timeout(100)
        check(await page.evaluate("__inkwell.prefs.lassoMode") == 'box', 'Box picked')

        # 2. a box drag (no loop drawn around anything, just two corners) selects what is inside
        await drag(80, 90, 400, 240)
        s = await state()
        check(s['sel'] == ['sA', 'xA'] and s['selShot'] and not s['ts'], f'box selects the ink and the text box, menu has Copy as picture ({s})')
        await drag(80, 90, 300, 160)
        s = await state()
        check(s['sel'] == ['sA'], f'smaller box: only the ink ({s["sel"]})')

        # 3. box over empty space: area outline with only Copy as picture
        await drag(500, 300, 640, 420)
        s = await state()
        check(s['sel'] == [] and s['ts'] and s['area'] and s['tsShot'] and not s['tsCopy'], f'empty box: outline + Copy as picture only ({s})')

        # 4. Copy as picture: a PNG of the box on the clipboard
        await drag(80, 90, 400, 240)
        await page.click('#selShot'); await page.wait_for_timeout(1500)
        info = await page.evaluate("""async () => { const items = await navigator.clipboard.read(); const it = items[0];
          if(!it.types.includes('image/png')) return {types: it.types};
          const bl = await it.getType('image/png'), bmp = await createImageBitmap(bl);
          const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
          const d = x.getImageData(0, 0, bmp.width, bmp.height).data; let red = 0;
          for(let i = 0; i < d.length; i += 4) if(d[i] > 150 && d[i+1] < 80 && d[i+2] < 80) red++;
          return {types: it.types, w: bmp.width, h: bmp.height, red}; }""")
        check('image/png' in info['types'] and abs(info['w'] / info['h'] - 320 / 150) < 0.05 and info['red'] > 50, f'clipboard has a PNG of the box with the red ink ({info})')
        s = await state()
        check(s['sel'] == [] and not s['ts'], 'selection closed after copying')

        # 5. Ctrl+V pastes that picture
        n0 = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'i').length")
        await page.mouse.move(*scr(700, 500)); await page.keyboard.press('Control+v'); await page.wait_for_timeout(1200)
        r = await page.evaluate("(() => { const ims = [...__inkwell.cur.items.values()].filter(i => i.t === 'i'); const it = ims[ims.length - 1]; return {n: ims.length, w: it && it.w, h: it && it.h, sel: __inkwell.sel ? __inkwell.sel.ids.length : 0}; })()")
        check(r['n'] == n0 + 1 and r['sel'] == 1 and abs(r['w'] / r['h'] - 320 / 150) < 0.05, f'Ctrl+V pastes the picture, selected ({r})')

        # 6. text from another app → text box
        await page.evaluate("navigator.clipboard.writeText('Line one\\nLine two')")
        await page.keyboard.press('Control+v'); await page.wait_for_timeout(600)
        r = await page.evaluate("(() => { const xs = [...__inkwell.cur.items.values()].filter(i => i.t === 'x'); const it = xs[xs.length - 1]; return {n: xs.length, text: __inkwell.htmlText(it.html), sel: __inkwell.sel ? __inkwell.sel.ids : []}; })()")
        check(r['n'] == 2 and 'Line one' in r['text'] and 'Line two' in r['text'] and r['sel'], f'Ctrl+V pastes text as a text box ({r})')

        # 7. Inkwell's own copy: Ctrl+C on ink, Ctrl+V gives the ink again (not text)
        await page.click('#lassoMode [data-m="free"]')
        await page.evaluate("__inkwell.selectIds(['sA'])")
        await page.keyboard.press('Control+c'); await page.wait_for_timeout(300)
        clip = await page.evaluate("navigator.clipboard.readText()")
        check(clip == 'Inkwell: 1 item', f'system clipboard notes the Inkwell copy ({clip!r})')
        ns = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 's').length")
        await page.keyboard.press('Control+v'); await page.wait_for_timeout(600)
        ns2 = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 's').length")
        nx = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'x').length")
        check(ns2 == ns + 1 and nx == 2, f'Ctrl+V after Inkwell copy pastes the ink ({ns} -> {ns2} strokes, {nx} text boxes)')
        # copying text in another app afterwards wins
        await page.evaluate("navigator.clipboard.writeText('From Safari')")
        await page.keyboard.press('Control+v'); await page.wait_for_timeout(600)
        nx = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'x').length")
        check(nx == 3, f'newer text from another app wins over the older Inkwell copy ({nx} text boxes)')

        # 8. Paste button reads a picture from the clipboard (screenshot from another app)
        b64 = png_b64(400, 300, (20, 120, 220))
        await page.evaluate("""async (b64) => { const bl = await (await fetch('data:image/png;base64,' + b64)).blob(); await navigator.clipboard.write([new ClipboardItem({'image/png': bl})]); }""", b64)
        n0 = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'i').length")
        await page.evaluate("dispatchEvent(new Event('blur'))")   # the screenshot was copied in another app
        await page.click('#pasteBtn'); await page.wait_for_timeout(1200)
        r = await page.evaluate("(() => { const ims = [...__inkwell.cur.items.values()].filter(i => i.t === 'i'); const it = ims[ims.length - 1]; return {n: ims.length, ar: it.w / it.h}; })()")
        check(r['n'] == n0 + 1 and abs(r['ar'] - 4 / 3) < 0.02, f'Paste button pastes a screenshot from another app ({r})')
        # copied in Inkwell and never left: the Paste button pastes the Inkwell copy without reading the clipboard
        await page.evaluate("() => { __inkwell.selectIds(['sA']); }"); await page.keyboard.press('Control+c'); await page.wait_for_timeout(200)
        await page.evaluate("() => { window.__reads = 0; const r = navigator.clipboard.read.bind(navigator.clipboard); navigator.clipboard.read = (...a) => { window.__reads++; return r(...a); }; }")
        ns = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 's').length")
        await page.click('#pasteBtn'); await page.wait_for_timeout(500)
        r = await page.evaluate("({n: [...__inkwell.cur.items.values()].filter(i => i.t === 's').length, reads: window.__reads})")
        check(r['n'] == ns + 1 and r['reads'] == 0, f'Paste right after an Inkwell copy: pasted without asking the clipboard ({r})')

        # 9. clipboard refused: window with the picture, Put on page
        await page.keyboard.press('Escape'); await page.click('#lassoMode [data-m="box"]')
        await page.evaluate("() => { window.__write = navigator.clipboard.write; navigator.clipboard.write = () => Promise.reject(new Error('NotAllowed')); }")
        await drag(80, 90, 400, 240)
        await page.click('#selShot'); await page.wait_for_timeout(1500)
        d = await page.evaluate("(() => ({open: !document.getElementById('shotDlg').hidden, src: document.getElementById('shotImg').src.slice(0, 5), w: document.getElementById('shotImg').naturalWidth}))()")
        check(d['open'] and d['src'] == 'blob:' and d['w'] > 100, f'clipboard refused: window shows the picture ({d})')
        n0 = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'i').length")
        await page.click('#shotPut'); await page.wait_for_timeout(1000)
        r = await page.evaluate("(() => { const ims = [...__inkwell.cur.items.values()].filter(i => i.t === 'i'); const it = ims[ims.length - 1]; return {n: ims.length, x: it.x, w: it.w}; })()")
        check(r['n'] == n0 + 1 and r['x'] > 400 and abs(r['w'] - 320) < 2, f'Put on page puts it right of the box, same size ({r})')
        await page.evaluate("() => { delete navigator.clipboard.write; }")

        # 10. Box over PDF text: lines picked too, with Copy as picture in the same menu
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage(); W.setTool('lasso');
          W.addItems([{t: 'i', id: 'iP', x: 0, y: 0, w: 600, h: 848, a: 'aP', doc: 1}]);
          await W.savePtxt('aP', 'pdf', [[0.1, 'Alpha', 0.1, 0.4, 0.02], [0.13, 'Beta', 0.1, 0.4, 0.02], [0.3, 'Gamma', 0.1, 0.4, 0.02]]);
          W.cam.z = 1; W.cam.ox = 20; W.cam.oy = 20; }""")
        await page.wait_for_timeout(300)
        await drag(40, 75, 300, 130)
        s = await state()
        lines = await page.evaluate("__inkwell.TS.lines.map(l => l.s)")
        check(lines == ['Alpha', 'Beta'] and s['ts'] and s['tsCopy'] and s['tsShot'] and s['area'], f'box over PDF text: lines + Copy as picture ({lines}, {s})')

        # 10b. (1.53.1) an older Inkwell copy exists and we never left the app: copying page text, then Paste,
        # gives that text (it used to paste the older Inkwell copy again)
        await page.evaluate("() => { const W = __inkwell; W.addItems([{t: 's', id: 'sZ', c: '#000', w: 2, p: [700,700,.5,760,700,.5]}]); W.selectIds(['sZ']); }")
        await page.keyboard.press('Control+c'); await page.wait_for_timeout(200)
        await drag(40, 75, 300, 130)
        await page.click('#tsCopy'); await page.wait_for_timeout(300)
        await page.keyboard.press('Escape')
        nx0 = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'x').length")
        ns0 = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 's').length")
        await page.click('#pasteBtn'); await page.wait_for_timeout(800)
        r = await page.evaluate("(() => { const xs = [...__inkwell.cur.items.values()].filter(i => i.t === 'x'); return {nx: xs.length, ns: [...__inkwell.cur.items.values()].filter(i => i.t === 's').length, text: xs.length ? __inkwell.htmlText(xs[xs.length - 1].html) : ''}; })()")
        check(r['nx'] == nx0 + 1 and r['ns'] == ns0 and 'Alpha' in r['text'], f'page text copied after an Inkwell copy: Paste gives the text, not the old copy ({r})')
        # Copy as picture, then Paste: the picture
        await page.keyboard.press('Escape')
        await drag(40, 75, 300, 130)
        await page.click('#tsShot'); await page.wait_for_timeout(1500)
        ni0 = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'i').length")
        await page.click('#pasteBtn'); await page.wait_for_timeout(1200)
        ni = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'i').length")
        check(ni == ni0 + 1, f'Copy as picture, then Paste: the picture is pasted ({ni0} -> {ni})')
        # text copied from a text box with the system Copy (copy event), then Paste
        await page.keyboard.press('Escape')
        await page.evaluate("() => { __inkwell.selectIds(['sZ']); }"); await page.keyboard.press('Control+c'); await page.wait_for_timeout(200)
        await page.keyboard.press('Escape')
        await page.evaluate("async () => { await navigator.clipboard.writeText('From a text box'); document.dispatchEvent(new Event('copy')); }")
        nx0 = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'x').length")
        await page.click('#pasteBtn'); await page.wait_for_timeout(800)
        r = await page.evaluate("(() => { const xs = [...__inkwell.cur.items.values()].filter(i => i.t === 'x'); return {nx: xs.length, text: __inkwell.htmlText(xs[xs.length - 1].html)}; })()")
        check(r['nx'] == nx0 + 1 and r['text'] == 'From a text box', f'text copied with the system Copy inside Inkwell pastes as text ({r})')
        # Ctrl+V lands in the hidden paste field (iPad Safari needs a focused field) and leaves no focus behind
        await page.keyboard.press('Escape')
        await page.evaluate("navigator.clipboard.writeText('Via keyboard')")
        await page.evaluate("() => { window.__pt = ''; document.addEventListener('paste', e => { window.__pt = e.target.id; }, {capture: true, once: true}); }")
        await page.keyboard.press('Control+v'); await page.wait_for_timeout(600)
        r = await page.evaluate("({t: window.__pt, focus: document.activeElement && document.activeElement.id, text: __inkwell.htmlText([...__inkwell.cur.items.values()].filter(i => i.t === 'x').pop().html)})")
        check(r['t'] == 'pasteCatch' and r['focus'] != 'pasteCatch' and r['text'] == 'Via keyboard', f'Ctrl+V goes through the hidden paste field ({r})')

        # 11. Free mode still draws a free loop (the old way)
        await page.click('#lassoMode [data-m="free"]')
        mode = await page.evaluate("__inkwell.prefs.lassoMode")
        check(mode == 'free', 'back to Free')
        await page.reload(); await boot(page)
        check(await page.evaluate("__inkwell.prefs.lassoMode") == 'free', 'choice remembered after reload')

        if os.environ.get('SNAP_SHOT'):
            await page.evaluate("__inkwell.setTool('lasso')"); await page.click('#lassoMode [data-m="box"]')
            await page.evaluate("""async () => { const W = __inkwell; await W.newPage();
              const p = []; for(let i = 0; i < 30; i++) p.push(100 + i * 5, 120 + Math.sin(i / 3) * 10, 0.5);
              W.addItems([{t: 's', id: 'sB', c: '#c00', w: 3, p}]); W.cam.z = 1; W.cam.ox = 20; W.cam.oy = 20; }""")
            await page.wait_for_timeout(300); await drag(60, 80, 330, 200); await page.screenshot(path=os.environ['SNAP_SHOT'])
        check(not errs, f'no page errors ({errs[:2]})')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
