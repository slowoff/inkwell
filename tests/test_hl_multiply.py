# 1.62 (Rafael: "when I highlight text, there's no yellow film over the black text ... the black stands out behind
# the yellow"). Highlights blend into the page like real highlighter ink (multiply): black text of an imported page
# stays black, white paper gets exactly the old pale colour. Also while drawing, in the exported PDF file and when
# printing. Dark mode on the dark page background and highlights over a filled shape keep the old look.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SETUP = """async () => {
  const W = __inkwell;
  await W.newPage(); await new Promise(r => setTimeout(r, 300));
  W.cam.ox = 0; W.cam.oy = 0; W.cam.z = 1; W.invalidate();
  // an imported page: white with a thick black bar (= text) from x 100..500, y 200..240
  const c = document.createElement('canvas'); c.width = 600; c.height = 400;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 400); g.fillStyle = '#000'; g.fillRect(100, 200, 400, 40);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const a = await W.saveAsset(blob);
  W.addItems([{t: 'i', id: 'pg1', x: 0, y: 0, w: 600, h: 400, a, doc: 1}]);
  await new Promise(r => setTimeout(r, 1200));
  // a yellow highlight across the bar and the white paper above and below it
  const p = []; for(let x = 120; x <= 480; x += 8) p.push(x, 220, .5);
  W.addItems([{t: 's', id: 'h1', c: '#F5C400', w: 70, hl: 1, p}]);
  W.invalidate(); await new Promise(r => setTimeout(r, 400));
}"""

async def px(page, x, y):
    box = await page.evaluate("() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.x, r.y]; }")
    shot = await page.screenshot(clip={'x': box[0] + x, 'y': box[1] + y, 'width': 1, 'height': 1})
    from PIL import Image; import io
    return Image.open(io.BytesIO(shot)).convert('RGB').getpixel((0, 0))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for theme in ['light', 'dark']:
            ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, color_scheme=theme)
            await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
            page = await ctx.new_page(); errs = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            await page.goto(URL); await page.wait_for_timeout(3000)
            await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
            await page.wait_for_timeout(2500)
            await page.wait_for_function('!!(window.__inkwell && window.__inkwell.cur)', timeout=15000)
            await page.evaluate(SETUP)
            text = await px(page, 300, 220)      # black bar under the highlight
            paper = await px(page, 300, 192)     # white paper under the highlight
            plain = await px(page, 300, 330)     # white paper, no highlight
            print(f' {theme}: text {text}, highlighted paper {paper}, paper {plain}')
            check(max(text) < 30, f'{theme}: black text under a highlight stays black ({text})')
            check(abs(paper[0] - 251) <= 4 and abs(paper[1] - 231) <= 5 and abs(paper[2] - 153) <= 6, f'{theme}: highlighted paper has the same pale yellow as before ({paper}, expected about (251, 231, 153))')
            check(min(plain) > 245, f'{theme}: paper without highlight stays white ({plain})')
            if theme == 'dark':
                # highlight on the dark page background (not on paper): the old see-through look, not blended
                r = await page.evaluate("""async () => { const W = __inkwell, p = []; for(let x = 100; x <= 400; x += 8) p.push(x, 600, .5);
                  W.addItems([{t: 's', id: 'h2', c: '#F5C400', w: 40, hl: 1, p}]); W.invalidate(); await new Promise(r => setTimeout(r, 400));
                  const d = devicePixelRatio, at = id => [...document.getElementById(id).getContext('2d').getImageData((250 * W.cam.z + W.cam.ox) * d, (600 * W.cam.z + W.cam.oy) * d, 1, 1).data];
                  return {ink: at('ink'), hlm: at('hlm')}; }""")
                check(r['ink'][3] > 60 and r['ink'][0] > 200 and r['hlm'][3] == 0, f'dark mode: a highlight on the dark background keeps the old see-through look, not blended ({r})')
            # while drawing: the live preview blends the same way
            await page.evaluate("() => __inkwell.setTool('hl')")
            box = await page.evaluate("() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.x, r.y]; }")
            await page.mouse.move(box[0] + 150, box[1] + 300); await page.mouse.down()
            for i in range(1, 30): await page.mouse.move(box[0] + 150 + i * 10, box[1] + 300 - (i * 3 if i < 10 else 27))
            await page.wait_for_timeout(100)
            live = await page.evaluate("() => document.getElementById('live').classList.contains('hl-mul')")
            await page.mouse.up(); await page.wait_for_timeout(300)
            after = await page.evaluate("() => document.getElementById('live').classList.contains('hl-mul')")
            check(live and not after, f'{theme}: while drawing a highlight on the page it blends the same way ({live}), normal after ({after})')
            if theme == 'light':
                # a highlight over a filled shape (graph background) stays on the ink layer, so it is not hidden
                r = await page.evaluate("""() => { const W = __inkwell;
                  W.addItems([{t: 's', id: 'f1', c: 'paper', w: 1, hl: 0, fl: 1, p: [100, 450, .5, 400, 450, .5, 400, 600, .5, 100, 600, .5]}]);
                  const p = []; for(let x = 120; x <= 380; x += 8) p.push(x, 525, .5);
                  W.addItems([{t: 's', id: 'h3', c: '#4CC26B', w: 40, hl: 1, p}]); W.invalidate(); return true; }""")
                await page.wait_for_timeout(300)
                g = await px(page, 250, 525)
                check(g[1] > g[0] + 20 and g[1] > g[2] + 20, f'a highlight over a filled shape stays visible ({g})')
                # the exported PDF file: black stays black, paper pale yellow
                r = await page.evaluate("""async () => { const W = __inkwell;
                  W.removeItems(['f1', 'h3']); await W.flushSaves();
                  await W.exportPdfFile(); const f = W.Pdf.file; if(!f) return {err: 'no file'};
                  const pdf = await pdfjsLib.getDocument({data: new Uint8Array(await f.arrayBuffer())}).promise, pg = await pdf.getPage(1);
                  const vp = pg.getViewport({scale: 2}), cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
                  const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
                  await pg.render({canvasContext: c, viewport: vp}).promise;
                  // find the black bar: darkest row band; sample its middle, and a highlighted paper pixel above it
                  const d = c.getImageData(0, 0, cv.width, cv.height).data, Wd = cv.width;
                  let best = null;
                  for(let y = 0; y < cv.height; y += 2){ for(let x = 0; x < Wd; x += 4){ const i = (y * Wd + x) * 4; if(d[i] + d[i+1] + d[i+2] < 60){ best = [x, y]; break; } } if(best) break; }
                  if(!best) return {err: 'bar not found'};
                  // walk right to the middle of the bar
                  let x1 = best[0]; while(x1 < Wd){ const i = (best[1] * Wd + x1) * 4; if(d[i] + d[i+1] + d[i+2] > 200) break; x1++; }
                  const mx = Math.round((best[0] + x1) / 2), my = best[1] + 8;
                  const at = (x, y) => { const i = (y * Wd + x) * 4; return [d[i], d[i+1], d[i+2]]; };
                  // highlighted paper just above the bar
                  let hy = best[1] - 6;
                  return {text: at(mx, my), paper: at(mx, hy)};
                }""")
                print(' pdf:', r)
                check('err' not in r and max(r['text']) < 40, f'exported PDF: black text under a highlight stays black ({r})')
                check('err' not in r and r['paper'][2] < 200 and r['paper'][0] > 220, f'exported PDF: highlighted paper is yellow ({r.get("paper")})')
            check(not errs, f'{theme}: no page errors {errs[:2]}')
            await ctx.close()
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
