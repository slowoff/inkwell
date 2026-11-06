# 1.75: Paper -> Margin line: per page, colour and thickness, saved, not leaking onto old pages, in exports.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
# pixel of the paper canvas on the margin line
PIX = """() => { const W = __inkwell, c = document.getElementById('bg') || document.querySelector('canvas'), d = devicePixelRatio || 1;
  const x = Math.round(((Number.isFinite(W.cur.bg.mx) ? W.cur.bg.mx : 25) * 96 / 25.4 * W.cam.z + W.cam.ox + W.layerOff[0]) * d), y = Math.round((300 + W.layerOff[1]) * d);
  return [...c.getContext('2d').getImageData(x, y, 1, 1).data]; }"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, color_scheme='light')
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.cam.ox = 100; __inkwell.cam.z = 1; __inkwell.invalidate(); }")
        await page.wait_for_timeout(300)
        old = await page.evaluate("() => __inkwell.cur.id")
        px = await page.evaluate(PIX)
        check(px[3] == 0 or px[2] < 240 or px[0] > 200, f'off by default ({px})')
        await page.click('#paperBtn'); await page.wait_for_selector('#paperPop', state='visible')
        check(await page.is_hidden('#mlOpts'), 'options hidden while off')
        await page.click('#mlOn'); await page.wait_for_timeout(200)
        bg = await page.evaluate("() => __inkwell.cur.bg")
        check(bg.get('ml') == 'blue', f'on = blue ({bg})')
        px = await page.evaluate(PIX)
        check(px[3] == 255 and px[2] > 200 and px[0] < 100, f'blue line drawn ({px})')
        await page.click('#mlColor [data-v=red]'); await page.click('#mlWidth [data-v=thick]'); await page.wait_for_timeout(200)
        px = await page.evaluate(PIX)
        check(px[0] > 200 and px[2] < 120, f'red line drawn ({px})')
        await page.evaluate("() => { const r = document.getElementById('mlX'); r.value = -10; r.dispatchEvent(new Event('input', {bubbles: true})); }"); await page.wait_for_timeout(200)
        px = await page.evaluate(PIX)
        check(await page.evaluate("() => __inkwell.cur.bg.mx") == -10 and px[0] > 200 and px[2] < 120, f'slider moves the line left of 0 ({px})')
        check(await page.inner_text('#mlXVal') == '-10 mm', 'slider shows the position')
        await page.keyboard.press('Escape')
        # blank paper still shows it
        await page.evaluate("() => __inkwell.flushSaves()"); await page.wait_for_timeout(300)
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        bg = await page.evaluate("() => __inkwell.cur.bg")
        check(bg.get('ml') == 'red' and bg.get('mw') == 'thick' and bg.get('mx') == -10, f'kept after reload ({bg})')
        # "use for new pages": new pages get it, a page saved without one does not
        await page.evaluate("async () => { const P = __inkwell.prefs; P.bg = Object.assign({}, __inkwell.cur.bg); await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        bg = await page.evaluate("() => __inkwell.cur.bg")
        check(bg.get('ml') == 'red' and bg.get('mw') == 'thick', f'new page uses the default ({bg})')
        await page.click('#paperBtn'); await page.click('#mlOn'); await page.wait_for_timeout(200)
        bg = await page.evaluate("() => __inkwell.cur.bg")
        check('ml' not in bg and 'mw' not in bg and 'mx' not in bg, f'off removes the fields ({bg})')
        await page.click('#mlOn'); await page.wait_for_timeout(200)
        bg = await page.evaluate("() => __inkwell.cur.bg")
        check(bg.get('ml') == 'red' and bg.get('mw') == 'thick' and bg.get('mx') == -10, f'on again restores the choices ({bg})')
        await page.click('#mlOn'); await page.wait_for_timeout(200)
        await page.keyboard.press('Escape')
        await page.evaluate("() => __inkwell.flushSaves()"); await page.wait_for_timeout(200)
        pid = await page.evaluate("() => __inkwell.cur.id")
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(200)
        await page.evaluate("async id => { await __inkwell.openPage(id); }", pid); await page.wait_for_timeout(300)
        bg = await page.evaluate("() => __inkwell.cur.bg")
        check('ml' not in bg, f'page without a line stays without one though the default has one ({bg})')
        # export
        await page.evaluate("async id => { await __inkwell.openPage(id); }", old); await page.wait_for_timeout(300)
        bg = await page.evaluate("() => __inkwell.cur.bg")
        check(bg.get('ml') == 'red', 'first page still has its line')
        await page.evaluate("""() => __inkwell.addItems([{t:'x', id:'xm1', x:400, y:100, w:300, fs:1, html:'<p>hello</p>'}])"""); await page.wait_for_timeout(200)
        await page.evaluate("() => { window.print = () => {}; return __inkwell.exportPdf(); }"); await page.wait_for_timeout(2500)
        html = await page.evaluate("() => document.getElementById('printRoot').innerHTML")
        check('#E5484D' in html, 'line in the print path, with notes further right')
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        red = await page.evaluate("""async () => { const W = __inkwell; await W.exportPdfFile();
          if(!window.pdfjsLib) await W.loadScript('lib/pdf.min.js');
          const pdf = await pdfjsLib.getDocument({data: await W.Pdf.file.arrayBuffer()}).promise, pg = await pdf.getPage(1), vp = pg.getViewport({scale: 2});
          const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; const x = c.getContext('2d');
          await pg.render({canvasContext: x, viewport: vp}).promise;
          const d = x.getImageData(0, Math.round(vp.height / 3), c.width, 1).data; let n = 0;
          for(let i = 0; i < d.length; i += 4) if(d[i] > 200 && d[i+1] < 130 && d[i+2] < 140) n++; return n; }""")
        check(red >= 1, f'line in the PDF file ({red} red pixels across a row)')
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
