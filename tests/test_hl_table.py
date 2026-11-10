# 1.99: Stick to text in a table (Rafael's worksheet: "Erbe | Gesetzlicher An-/spruch | Pflichtteils-/quote (%) ...").
# The table's lines are not text: a band sits on the words, not on the border above them, never crosses a cell's
# side line into the next cell, and leaves no stray blobs. A swipe over a two-line cell header marks the line swiped.
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
  // page picture 1600 x 1000 px shown 800 x 500 world at (40, 40); world = 40 + px / 2
  const c = document.createElement('canvas'); c.width = 1600; c.height = 1000;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1600, 1000);
  const words = {};
  const put = (txt, x, base, font) => {
    g.font = font; g.fillStyle = '#111'; g.textBaseline = 'alphabetic';
    let cx = x;
    for(const wd of txt.split(' ')){
      const m = g.measureText(wd);
      g.fillText(wd, cx, base);
      words[wd] = [40 + (cx - m.actualBoundingBoxLeft) / 2, 40 + (base - m.actualBoundingBoxAscent) / 2, 40 + (cx + m.actualBoundingBoxRight) / 2, 40 + (base + m.actualBoundingBoxDescent) / 2];
      cx += m.width + g.measureText(' ').width;
    }
  };
  // pink heading band like the worksheet
  g.fillStyle = '#FBE7EF'; g.fillRect(40, 40, 1520, 52);
  put('2.3 Tierliebende Erblasser', 46, 80, 'bold 36px sans-serif');
  put('Karin hat ein Vermoegen von Fr. 690000 und drei Kinder.', 120, 170, '30px sans-serif');
  // table: columns at x 40, 330, 640, 950, 1260, 1560; header row y 300..410, body row 410..620
  const X = [40, 330, 640, 950, 1260, 1560], Y = [300, 410, 620];
  g.strokeStyle = '#111'; g.lineWidth = 3;
  for(const x of X){ g.beginPath(); g.moveTo(x, Y[0]); g.lineTo(x, Y[2]); g.stroke(); }
  for(const y of Y){ g.beginPath(); g.moveTo(X[0], y); g.lineTo(X[5], y); g.stroke(); }
  const F = 'bold 34px sans-serif';
  put('Erbe', 60, 345, F);
  put('Gesetzlicher An-', 345, 345, F); put('spruch', 345, 395, F);
  put('Pflichtteils-', 655, 345, F); put('quote (%)', 655, 395, F);
  put('Pflichtteil in', 965, 345, F); put('CHF', 965, 395, F);
  put('Erbanspruch in', 1275, 345, F); put('Franken', 1275, 395, F);
  put('Ehepartner', 60, 460, '32px sans-serif');
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const a = await W.saveAsset(blob);
  W.addItems([{t: 'i', id: 'ipage', x: 40, y: 40, w: 800, h: 500, a, doc: 1}]);
  W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.invalidate();
  W.setTool('hl'); W.prefs.hlSnap = true;
  window.__words = words;
  window.__cols = X.map(x => 40 + x / 2); window.__rows = Y.map(y => 40 + y / 2);
}"""

def bands(res):
    out = []
    for b in res:
        xs = b['p'][0::3]; y = b['p'][1]; r = b['w'] / 2
        out.append([min(xs) - r, y - r, max(xs) + r, y + r])
    return out

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1700, 'height': 900})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate(SETUP)
        await page.wait_for_function("(() => { const el = document.querySelector('#worldBack [data-id=\"ipage\"]'); return el && el._loaded && el._img.complete; })()", timeout=10000)
        W = await page.evaluate("window.__words"); C = await page.evaluate("window.__cols"); R = await page.evaluate("window.__rows")
        async def snap(pts, w=12):
            flat = []
            for x, y in pts: flat += [x, y, 0.5]
            return bands(await page.evaluate("([p, w]) => __inkwell.HLS.snap(p, w).map(b => ({w: b.w, p: Array.from(b.p)}))", [flat, w]))
        def inside(bd, word, tol=4):
            return bd[1] >= word[1] - tol and bd[3] <= word[3] + tol and bd[1] <= word[1] + 2 and bd[3] >= word[3] - 2
        for w in [6, 12, 24]:
            # "Erbe": swiped a bit high, like on the iPad, starting left of the cell's side line
            e = W['Erbe']; ym = (e[1] + e[3]) / 2 - 4
            r = await snap([(C[0] - 4, ym), (e[0] + 10, ym - 1), (e[2] + 30, ym)], w)
            check(len(r) == 1, f'[{w}] Erbe: one band ({len(r)})')
            if r:
                bd = r[0]
                check(inside(bd, e), f'[{w}] Erbe: band sits on the word, not on the border above ({[round(v) for v in bd]} vs {[round(v) for v in e]})')
                check(bd[0] >= C[0] and bd[2] <= C[1], f'[{w}] Erbe: band stays inside its cell ({bd[0]:.0f}..{bd[2]:.0f}, cell {C[0]:.0f}..{C[1]:.0f})')
            # "Gesetzlicher An-": swiped from inside the Erbe cell across the side line
            g0, g1 = W['Gesetzlicher'], W['An-']; ym = (g0[1] + g0[3]) / 2
            r = await snap([(C[1] - 20, ym), (g0[0] + 40, ym + 2), (g1[2] + 5, ym)], w)
            check(len(r) == 1, f'[{w}] Gesetzlicher An-: one band ({len(r)})')
            if r:
                bd = r[0]
                check(inside(bd, [g0[0], min(g0[1], g1[1]), g1[2], max(g0[3], g1[3])]), f'[{w}] Gesetzlicher An-: on the first line only ({[round(v) for v in bd]})')
                check(bd[0] >= C[1] - 1 and bd[2] <= C[2] + 1, f'[{w}] Gesetzlicher An-: does not reach into the Erbe cell ({bd[0]:.0f}..{bd[2]:.0f}, cell {C[1]:.0f}..{C[2]:.0f})')
            # "quote (%)": second line of its cell
            q0, q1 = W['quote'], W['(%)']; ym = (q0[1] + q0[3]) / 2
            r = await snap([(q0[0] + 5, ym), (q1[2] - 5, ym)], w)
            check(len(r) == 1 and inside(r[0], [q0[0], min(q0[1], q1[1]), q1[2], max(q0[3], q1[3])]), f'[{w}] quote (%): on its line ({[[round(v) for v in x] for x in r]})')
            # whole header row in one swipe across all cells: one band per cell, none crossing a side line, no blobs
            ym = (W['Erbe'][1] + W['Erbe'][3]) / 2
            r = await snap([(C[0] + 5, ym), (C[5] - 5, ym)], w)
            crosses = [bd for bd in r if any(bd[0] < c - 1 < bd[2] - 2 and bd[0] + 2 < c + 1 < bd[2] for c in C)]
            tiny = [bd for bd in r if bd[2] - bd[0] < 12]
            check(len(r) >= 1 and not crosses and not tiny, f'[{w}] full row: no band crosses a side line or is a blob ({len(r)} bands, crossing {len(crosses)}, tiny {len(tiny)})')
        # plain text still works: a word in the sentence
        k = W['Karin']; ym = (k[1] + k[3]) / 2
        r = await snap([(k[0] + 2, ym), (k[2] - 2, ym)])
        check(len(r) == 1 and inside(r[0], k), f'normal text line still snaps ({[[round(v) for v in x] for x in r]})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
