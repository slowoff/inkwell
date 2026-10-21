# 1.58.8: light grey answer lines (worksheets print them pale) are found for Snap text to lines; text rows,
# pale filled boxes and table shading are not taken for lines.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

MAKE = """async ([col, th]) => {
  const W = __inkwell, c = document.createElement('canvas'); c.width = 2480; c.height = 1200;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 2480, 1200);
  x.fillStyle = '#1b2b4b'; x.font = 'bold 44px Helvetica, Arial, sans-serif';
  x.fillText('1.3', 140, 140); x.fillText('Nenne vier chemische Verfahren, welche die Menschen schon im Altertum', 330, 140);
  x.fillText('nutzten. (Mesopotamien, China) Beispiele gibt es viele.', 330, 205);
  x.fillText('1.4', 140, 520); x.fillText('Chemisch (C) oder physikalisch (P)? Ordne jede Aussage zu.', 330, 520);
  x.fillStyle = col; const want = [];
  for(const y of [335, 432, 30]){ x.fillRect(330, y, 1950, th); want.push((y + th / 2) / 1200); }
  // pale shaded box (a filled heading) must not count
  x.fillStyle = '#f3e3ea'; x.fillRect(330, 640, 1950, 70);
  x.fillStyle = '#1b2b4b'; x.fillText('Heading in a shaded box', 350, 690);
  // a pale line right under a text row with letters close above (an underline) is not an answer line
  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  const a = await W.saveAsset(blob), L = await W.detectLines(a);
  return {want, got: L.map(l => ({y: l.y, x1: l.x1, x2: l.x2}))};
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
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        for col, th in (('#c8c8c8', 2), ('#d4d4d4', 2), ('#bfbfbf', 1), ('#d9d9d9', 3), ('#444444', 2)):
            r = await page.evaluate(MAKE, [col, th])
            got = r['got']
            for k, w in enumerate(r['want'][:2]):
                m = [g for g in got if abs(g['y'] - w) < 0.01]
                check(len(m) == 1 and m[0]['x1'] < 0.15 and m[0]['x2'] > 0.9, f'{col} {th}px: answer line {k + 1} found ({m})')
            extra = [g for g in got if all(abs(g['y'] - w) >= 0.01 for w in r['want'])]
            check(not extra, f'{col} {th}px: no text row or shaded box taken for a line ({extra})')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
