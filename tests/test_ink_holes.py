# 1.61.1 (Rafael, iPad screenshot: a scribbled highlighter patch full of white wedges and slits).
# A stroke was one outline running along both edges; where a wide stroke turns back sharply (scribbling), the
# outline folds over itself and the folds cancel out, leaving holes. Now such strokes are filled as overlapping
# pieces, so everything the pen passed over is ink. Ordinary writing keeps the old outline (unchanged look).
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

HOLES = """async ([kind, w, hl, svg]) => {
  const W = __inkwell;
  const pts = [];
  const add = (x, y) => pts.push(x, y, 0.5);
  if(kind === 'scribble'){            // back-and-forth colouring like the screenshot
    for(let i = 0; i < 260; i++){ const t = i / 260; add(150 + 260 * t + 70 * Math.sin(i * 0.9), 200 + 90 * Math.sin(t * 6) + 30 * Math.cos(i * 1.7)); }
  } else if(kind === 'zigzag'){       // sharp reversals
    for(let k = 0; k < 14; k++){ add(150 + k * 14, 150); add(150 + k * 14 + 7, 330); }
  } else if(kind === 'hairpin'){      // one tight U-turn
    for(let i = 0; i <= 40; i++) add(150 + i * 6, 220);
    for(let i = 40; i >= 0; i--) add(150 + i * 6, 226);
  } else if(kind === 'writing'){      // ordinary handwriting-like stroke
    for(let i = 0; i < 160; i++){ const t = i / 10; add(150 + i * 2 + 9 * Math.cos(t), 220 + 14 * Math.sin(t * 1.6)); }
  }
  const it = {t: 's', id: 'h', c: '#000', w, hl, p: pts};
  const sh = W.strokeShape(it), r = sh.rs[0];
  const S = 520, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.fillStyle = '#000';
  if(svg){ c.fill(new Path2D(W.strokePath(it, true))); } else c.fill(W.strokePath(it, false));
  const got = c.getImageData(0, 0, S, S).data;
  // what the pen covered: the centre line drawn with the same (constant) radius, round ends and joints
  const ref = document.createElement('canvas'); ref.width = ref.height = S;
  const rc = ref.getContext('2d');
  rc.lineWidth = 2 * r; rc.lineCap = 'round'; rc.lineJoin = 'round'; rc.strokeStyle = '#000';
  rc.beginPath(); rc.moveTo(sh.xs[0], sh.ys[0]); for(let i = 1; i < sh.n; i++) rc.lineTo(sh.xs[i], sh.ys[i]); rc.stroke();
  const want = rc.getImageData(0, 0, S, S).data;
  let holes = 0, extra = 0, ink = 0;
  for(let i = 3; i < got.length; i += 4){
    if(want[i] === 255){ ink++; if(got[i] < 128) holes++; }
    if(want[i] === 0 && got[i] > 128) extra++;
  }
  return {holes, extra, ink, mode: W.strokePath.lastMode || null};
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('!!(window.__inkwell && window.__inkwell.strokePath)', timeout=15000)
        for kind, w, hl, name in [('scribble', 30, 1, 'wide highlighter scribble'), ('zigzag', 26, 1, 'highlighter zigzag'),
                                  ('hairpin', 20, 1, 'highlighter hairpin turn'), ('zigzag', 6, 0, 'pen zigzag'), ('scribble', 4, 0, 'pen scribble')]:
            for svg in (False, True):
                r = await page.evaluate(HOLES, [kind, w, hl, svg])
                where = 'PDF/print' if svg else 'screen'
                check(r['holes'] == 0, f'{name} ({where}): no holes ({r["holes"]} of {r["ink"]} covered pixels empty)')
                check(r['extra'] <= r['ink'] * 0.002, f'{name} ({where}): no ink outside where the pen went ({r["extra"]} pixels)')
        # through the real PDF file export (pdf-lib), opened again with pdf.js
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          if(!window.PDFLib) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'lib/pdf-lib.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
          const pts = []; for(let k = 0; k < 14; k++){ pts.push(150 + k * 14, 150, .5, 150 + k * 14 + 7, 330, .5); }
          const it = {t: 's', id: 'h', c: '#000', w: 26, hl: 1, p: pts};
          const doc = await PDFLib.PDFDocument.create(), pg = doc.addPage([520, 520]);
          pg.drawSvgPath(W.strokePath(it, true), {x: 0, y: 520, color: PDFLib.rgb(0, 0, 0)});
          const bytes = await doc.save();
          const pdf = await pdfjsLib.getDocument({data: bytes}).promise, page = await pdf.getPage(1);
          const vp = page.getViewport({scale: 1}), cv = document.createElement('canvas'); cv.width = 520; cv.height = 520;
          const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 520, 520);
          await page.render({canvasContext: c, viewport: vp}).promise;
          const got = c.getImageData(0, 0, 520, 520).data;
          const sh = W.strokeShape(it), ref = document.createElement('canvas'); ref.width = ref.height = 520;
          const rc = ref.getContext('2d'); rc.lineWidth = 2 * sh.rs[0]; rc.lineCap = rc.lineJoin = 'round';
          rc.beginPath(); rc.moveTo(sh.xs[0], sh.ys[0]); for(let i = 1; i < sh.n; i++) rc.lineTo(sh.xs[i], sh.ys[i]); rc.stroke();
          const want = rc.getImageData(0, 0, 520, 520).data;
          let holes = 0, ink = 0; for(let i = 3; i < want.length; i += 4) if(want[i] === 255){ ink++; if(got[i - 1] > 128) holes++; }
          return {holes, ink};
        }""")
        check(r['holes'] == 0, f'exported PDF file: no holes in a highlighter zigzag ({r["holes"]} of {r["ink"]} pixels empty)')
        r = await page.evaluate(HOLES, ['writing', 3, 0, False])
        check(r['holes'] == 0 and r['mode'] == 'outline', f'ordinary writing still uses the old outline ({r["mode"]}, {r["holes"]} holes)')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
