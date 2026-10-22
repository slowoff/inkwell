# 1.60.1: Stick to text measures the letters in the page picture: bands centred on the text, as tall as the
# letters, ending at word ends (Rafael's screenshot: bands sat high on body text and ran past a big heading).
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
  // a page picture 1600 x 2000 px shown 800 x 1000 world at (40, 40); world = 40 + px / 2
  const c = document.createElement('canvas'); c.width = 1600; c.height = 2000;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1600, 2000); g.fillStyle = '#111';
  const words = {};
  const put = (txt, x, base, font) => {
    g.font = font; g.textBaseline = 'alphabetic';
    let cx = x;
    for(const wd of txt.split(' ')){
      const m = g.measureText(wd);
      g.fillText(wd, cx, base);
      words[wd] = [40 + (cx - m.actualBoundingBoxLeft) / 2, 40 + (base - m.actualBoundingBoxAscent) / 2, 40 + (cx + m.actualBoundingBoxRight) / 2, 40 + (base + m.actualBoundingBoxDescent) / 2];
      cx += m.width + g.measureText(' ').width;
    }
  };
  put('Chemische Bindungen Teil I Die kovalente Bindung', 100, 300, 'bold 54px sans-serif');
  put('drei chemischen Bindungsarten und wissen, zwischen welchen', 100, 600, '34px sans-serif');
  put('gebildet werden sowie welche Stoffarten dabei entstehen.', 100, 660, '34px sans-serif');
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const a = await W.saveAsset(blob);
  // page text as Claude reads a scan: rows only, guessed heights (deliberately a bit off)
  W.docs.set('pt_' + a, {id: 'pt_' + a, kind: 'ptxt', deleted: false, data: {a, src: 'ocr', l: [[0.12, 'Chemische Bindungen'], [0.285, 'drei chemischen'], [0.315, 'gebildet']]}});
  W.addItems([{t: 'i', id: 'ipage', x: 40, y: 40, w: 800, h: 1000, a, doc: 1}]);
  W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.invalidate();
  W.setTool('hl'); W.prefs.hlSnap = true;
  window.__words = words;
}"""
LAST = "[...__inkwell.cur.items.values()].filter(i => i.t === 's' && i.hl).map(i => ({w: i.w, p: Array.from(i.p)}))"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1700, 'height': 900})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("document.querySelector('.app') && (__inkwell.prefs.sidebar = false)")
        await page.evaluate(SETUP)
        await page.wait_for_function("(() => { const el = document.querySelector('#worldBack [data-id=\"ipage\"]'); return el && el._loaded && el._img.complete; })()", timeout=10000)
        W = await page.evaluate("window.__words")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width]; })()")
        print('    stage width', st[2])
        async def stroke(pts):
            await page.mouse.move(st[0] + pts[0][0], st[1] + pts[0][1]); await page.mouse.down()
            for x, y in pts[1:]: await page.mouse.move(st[0] + x, st[1] + y, steps=4)
            await page.mouse.up(); await page.wait_for_timeout(300)
        def band(h):
            xs = h['p'][0::3]; y = h['p'][1]; r = h['w'] / 2
            return [min(xs) - r * 0.4, y - r, max(xs) + r * 0.4, y + r]   # round ends: the full-height part
        def union(*ws):
            bs = [W[w] for w in ws]
            return [min(q[0] for q in bs), min(q[1] for q in bs), max(q[2] for q in bs), max(q[3] for q in bs)]

        # body line 1, drawn a little high, starting inside "chemischen", ending inside "wissen,"
        t = union('chemischen', 'Bindungsarten', 'und', 'wissen,')
        y = t[1] + (t[3] - t[1]) * 0.3
        x0 = W['chemischen'][0] + 12; x1 = W['wissen,'][0] + 25
        await stroke([(x0, y), ((x0 + x1) / 2, y - 3), (x1, y + 2)])
        hl = await page.evaluate(LAST); bb = band(hl[-1]); th = t[3] - t[1]
        print('    text', [round(v) for v in t], 'band', [round(v) for v in bb])
        check(abs((bb[1] + bb[3]) / 2 - (t[1] + t[3]) / 2) < th * 0.12, f'body: band centred on the letters ({(bb[1] + bb[3]) / 2 - (t[1] + t[3]) / 2:+.1f})')
        check(bb[1] <= t[1] + 1 and bb[3] >= t[3] - 1 and bb[3] - bb[1] < th * 1.4, f'body: band covers the letters, not much more ({bb[3] - bb[1]:.0f} vs {th:.0f})')
        check(abs(bb[0] - t[0]) < 6 and abs(bb[2] - t[2]) < 6, f'body: whole words from "chemischen" to "wissen," ({bb[0] - t[0]:+.0f}, {bb[2] - t[2]:+.0f})')

        # heading: from inside "Bindungen" to well past the end of the line
        t = union('Bindungen', 'Teil', 'I', 'Die', 'kovalente', 'Bindung'); th = t[3] - t[1]
        y = t[1] + th * 0.35
        await stroke([(W['Bindungen'][0] + 20, y), (t[2] - 50, y - 4), (t[2] + 70, y)])
        hl = await page.evaluate(LAST); bb = band(hl[-1])
        print('    text', [round(v) for v in t], 'band', [round(v) for v in bb])
        check(abs((bb[1] + bb[3]) / 2 - (t[1] + t[3]) / 2) < th * 0.12, f'heading: band centred ({(bb[1] + bb[3]) / 2 - (t[1] + t[3]) / 2:+.1f})')
        check(bb[1] <= t[1] + 1 and bb[3] >= t[3] - 1, 'heading: band covers the big letters')
        check(abs(bb[2] - t[2]) < 8, f'heading: ends at the end of the text, not where the pen went ({bb[2] - t[2]:+.0f})')
        check(abs(bb[0] - t[0]) < 8, f'heading: starts at "Bindungen" ({bb[0] - t[0]:+.0f})')

        # down across the two body lines: two bands, one per line
        n0 = len(hl)
        a, c = W['Bindungsarten'], W['Stoffarten']
        await stroke([(a[0] + 10, a[1] + 5), (a[0] + 30, (a[3] + c[1]) / 2), (a[0] + 60, c[3] - 3)])
        hl = await page.evaluate(LAST)
        check(len(hl) - n0 == 2, f'down across two lines: two bands ({len(hl) - n0})')
        if len(hl) - n0 == 2:
            b1, b2 = band(hl[-2]), band(hl[-1])
            check(b1[3] <= b2[1] + 4, f'the two bands do not overlap much ({b1[3] - b2[1]:.1f})')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
