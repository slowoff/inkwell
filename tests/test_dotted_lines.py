# 1.43: dotted answer lines that follow text on the same line ("the 1.........", "In 5........, the ...")
# are found for snapping typed text, starting after the number and ending before the comma; text rows are not lines.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

MAKE = """async () => {
  const W = __inkwell, c = document.createElement('canvas'); c.width = 2000; c.height = 900;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 2000, 900); x.fillStyle = '#222';
  x.font = '30px Helvetica, Arial, sans-serif'; x.textBaseline = 'alphabetic';
  const rows = [
    ['Today, we are going to visit the AfricaMuseum in Tervuren. We will learn about a dark chapter of', ''],
    ['Belgian history: the colonisation of the 1', '.'.repeat(36), ''],
    ['often called the 2', '.'.repeat(36), 'Africa.'],
    ['The Congo was not originally a Belgian colony. It was controlled by Leopold II himself.', ''],
    ['In 5', '.'.repeat(36), ', the Belgian state took control of the territory. The Congo remained a'],
    ['Belgian colony until its independence in 6', '.'.repeat(36), ''],
  ];
  const want = [];
  rows.forEach((r, i) => {
    const y = 110 + i * 120; let px = 120;
    x.fillText(r[0], px, y); px += x.measureText(r[0]).width;
    if(r.length === 3){
      const dw = x.measureText(r[1]).width; x.fillText(r[1], px, y);
      want.push({y: y / 900, a: px / 2000, b: (px + dw) / 2000}); px += dw; x.fillText(r[2], px, y);
    }
  });
  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  const a = await W.saveAsset(blob), L = await W.detectLines(a);
  return {want, a, fs0: L.fs0, got: L.map(l => ({y: l.y, x1: l.x1, x2: l.x2, fs: l.fs}))};
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
        r = await page.evaluate(MAKE)
        got = r['got']
        for k, w in enumerate(r['want']):
            m = [g for g in got if abs(g['y'] - w['y']) < 0.02]
            check(len(m) == 1, f'dotted line {k + 1} found once ({len(m)} near y {w["y"]:.3f})')
            if len(m) == 1:
                g = m[0]
                check(g['x1'] >= w['a'] - 0.004 and abs(g['x1'] - w['a']) < 0.02, f'line {k + 1} starts at the dots, not at the number ({g["x1"]:.3f} vs {w["a"]:.3f})')
                check(abs(g['x2'] - w['b']) < 0.02, f'line {k + 1} ends where the dots end ({g["x2"]:.3f} vs {w["b"]:.3f})')
        check(len(got) == len(r['want']), f'no text row taken for a line ({len(got)} lines, want {len(r["want"])})')
        check(r['fs0'] and abs(r['fs0'] * 900 - 30) < 3, f'page text size measured (~30 px: {(r["fs0"] or 0) * 900:.1f})')
        check(all(g.get('fs') and abs(g['fs'] * 900 - 30) < 3 for g in got), 'every line knows the text size, also rows without g/p/y')

        # on a page: tap a dotted line with the text tool -> the new text is as big as the printed text and sits on the line
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        info = await page.evaluate('''async a => { const W = __inkwell, c = W.cam;
          const x0 = (40 - c.ox) / c.z, y0 = (20 - c.oy) / c.z, wd = 1000 / c.z, ht = wd * 900 / 2000;
          W.addItems([{t: 'i', id: 'ws', x: x0, y: y0, w: wd, h: ht, a, doc: 1}]); await W.pageLines(a);
          return {x0, y0, wd, ht, z: c.z, ox: c.ox, oy: c.oy}; }''', r['a'])
        await page.evaluate("() => __inkwell.setTool('text')")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        w1 = r['want'][2]   # "In 5........, the ..."
        wx = info['x0'] + (w1['a'] + w1['b']) / 2 * info['wd']; wy = info['y0'] + w1['y'] * info['ht'] - 8 / info['z']
        await page.mouse.click(st[0] + wx * info['z'] + info['ox'], st[1] + wy * info['z'] + info['oy'])
        await page.wait_for_timeout(300); await page.keyboard.type('1908'); await page.wait_for_timeout(200)
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        t = await page.evaluate('''() => { const it = [...__inkwell.cur.items.values()].find(i => i.t === 'x');
          if(!it) return null;
          return {fs: it.fs, x: it.x, y: it.y, lh: it.lh}; }''')
        want = 30 * info['ht'] / 900
        check(t is not None, 'tapping the dotted line makes a text box')
        if t:
            check(abs(t['fs'] * 17 - want) < want * 0.12, f'typed text is as big as the printed text ({t["fs"] * 17:.1f} vs {want:.1f} world px)')
            lx = info['x0'] + w1['a'] * info['wd']
            check(lx <= t['x'] + 6 <= lx + 0.5 * want, f'text starts at the dotted line, a little space after the number ({t["x"] + 6:.1f} vs {lx:.1f})')
            # the typed text stands on the dots like the printed words: its baseline = bottom of the dots
            bl = await page.evaluate('''() => { const el = document.querySelector('.it-text'); const s = document.createElement('span');
              s.style.cssText = 'display:inline-block;width:0;height:0'; const p = el.querySelector('p') || el; p.appendChild(s);
              const b = s.offsetTop; s.remove(); return b; }''')
            dots = info['y0'] + w1['y'] * info['ht']
            check(abs(t['y'] + bl - dots) < want * 0.15, f'typed text sits on the dots ({t["y"] + bl:.1f} vs dots {dots:.1f})')
        # a tap on an empty part of the imported page also gets the page's text size
        await page.wait_for_timeout(1000); await page.mouse.click(st[0] + 600, st[1] + 240); await page.wait_for_timeout(300)
        await page.keyboard.type('note'); await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        f2 = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'x').map(i => i.fs * 17)")
        check(len(f2) == 2 and abs(f2[1] - want) < want * 0.12, f'free text on the imported page uses the page text size too ({f2})')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
