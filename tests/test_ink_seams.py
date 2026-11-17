# 2.6.2 (Rafael, iPad screenshot at 800%: thin light cracks across pen strokes). Strokes drawn as pieces (inkPieces)
# had neighbouring bands that only touched along one shared edge; anti-aliasing let the paper show through there.
# Now each band starts a little inside the previous one where no round joint covers it.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SEAMS = """async ([th, s, off]) => {
  const W = window.InkGeo; const S = 500;
  const xs = [], ys = [], rs = []; let x = 0, y = 0, a = 0.3;
  for(let i = 0; i < 14; i++){ xs.push(x); ys.push(y); rs.push(2); x += Math.cos(a) * 0.6; y += Math.sin(a) * 0.6; a += th; }
  const cv = document.createElement('canvas'); cv.width = cv.height = S; const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, S, S);
  const ox = S / 2 - xs[7] * s + off, oy = S / 2 - ys[7] * s + off * 0.6;
  c.setTransform(s, 0, 0, s, ox, oy); c.fillStyle = '#f00'; c.fill(W.inkPieces(xs, ys, rs, 0, 13, false));
  const d = c.getImageData(0, 0, S, S).data; let bad = 0, worst = 0, outside = 0;
  for(let py = 0; py < S; py++) for(let px = 0; px < S; px++){
    const wx = (px + 0.5 - ox) / s, wy = (py + 0.5 - oy) / s; let m = 1e9;
    for(let i = 0; i < 13; i++){ const ax = xs[i], ay = ys[i], bx = xs[i+1] - ax, by = ys[i+1] - ay, L = bx * bx + by * by;
      const t = Math.max(0, Math.min(1, ((wx - ax) * bx + (wy - ay) * by) / L)); m = Math.min(m, Math.hypot(wx - ax - bx * t, wy - ay - by * t)); }
    const g = d[(py * S + px) * 4 + 1];
    if(m < 2 - 1.5 / s){ if(g > 0){ bad++; worst = Math.max(worst, g); } }
    else if(m > 2 + 1.5 / s && g < 250) outside++;
  }
  return {bad, worst, outside};
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
        await page.wait_for_function('!!(window.__inkwell && window.InkGeo && window.InkGeo.inkPieces)', timeout=15000)
        for th in [0, 0.005, 0.02]:
            for s in [4, 8, 16]:
                for off in [0, 0.37]:
                    r = await page.evaluate(SEAMS, [th, s, off])
                    check(r['bad'] == 0, f'no cracks inside a gentle curve (bend {th}, zoom {s}, offset {off}): {r}')
                    check(r['outside'] == 0, f'outline does not grow (bend {th}, zoom {s}, offset {off}): {r}')
        for th in [0.1, 0.4]:
            r = await page.evaluate(SEAMS, [th, 16, 0.37])
            check(r['bad'] <= 3 and r['worst'] < 60, f'bends: at most a few faint specks (bend {th}): {r}')
        check(not errs, f'no page errors {errs}')
        await b.close()
    if fails: print('FAILED:', len(fails)); raise SystemExit(1)
    print('ALL OK')

asyncio.run(main())
