# 1.58.12: Write to text makes the same box as typing there: on an answer line or in a table cell (Snap text to lines on)
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        await page.evaluate("""async () => {
          const c = document.createElement('canvas'); c.width = 1400; c.height = 900; const x = c.getContext('2d');
          x.fillStyle = '#fff'; x.fillRect(0, 0, 1400, 900); x.fillStyle = '#222'; x.font = '34px Helvetica, Arial';
          for(let i = 0; i < 5; i++){ x.fillText('0' + (i + 1) + '. We need to', 60, 120 + i * 150); x.fillRect(330, 122 + i * 150, 260, 3); x.fillText('a more effective solution.', 620, 120 + i * 150); }
          const a = await __inkwell.saveAsset(await new Promise(r => c.toBlob(r, 'image/png')));
          __inkwell.addItems([{t: 'i', id: 'ipg', x: 0, y: 0, w: 700, h: 450, a, doc: 1}]);
        }""")
        await page.wait_for_timeout(2500)
        await page.evaluate("async () => { const it = __inkwell.cur.items.get('ipg'); await __inkwell.pageLines(it.a); }"); await page.wait_for_timeout(500)
        # handwriting written above the line of row 3 (line at world y = (122+300+1.5)/2 = 211.75, x 165..295), in blue
        r = await page.evaluate("""() => { const W = __inkwell, ly = (122 + 300 + 1.5) / 2;
          const s = [{t: 's', id: 'sc1', c: '#1F4FCF', w: 2, hl: 0, p: [190, ly - 28, .5, 230, ly - 6, .5]}, {t: 's', id: 'sc2', c: '#1F4FCF', w: 2, hl: 0, p: [235, ly - 30, .5, 300, ly - 4, .5]}];
          W.addItems(s); W.Scribe.place(s.map(x => W.cur.items.get(x.id)), 'come up with', [188, ly - 32, 302, ly - 2]);
          const t = [...W.cur.items.values()].find(i => i.t === 'x'), el = document.querySelector(`[data-id="${t.id}"]`);
          const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const n = tw.nextNode(); const rg = document.createRange(); rg.selectNodeContents(n);
          const rr = rg.getBoundingClientRect(), z = W.cam.z, st = document.getElementById('stage').getBoundingClientRect();
          return {t, ly, glyphBottom: (rr.bottom - st.top - W.cam.oy) / z, left: (rr.left - st.left - W.cam.ox) / z, strokes: [...W.cur.items.values()].filter(i => i.t === 's').length, color: getComputedStyle(n.parentNode).color}; }""")
        t = r['t']
        check(r['strokes'] == 0, 'the ink is replaced by the text')
        check(t.get('lh') and 10 <= t['fs'] * 17 <= 24, f'box made like a typed one on the line (fs {t["fs"] * 17:.1f} px, lh {t.get("lh")})')
        check(abs(r['glyphBottom'] - r['ly']) < 6, f'the words sit on the answer line ({r["glyphBottom"]:.1f} vs line {r["ly"]:.1f})')
        check(abs(r['left'] - 165) < 12, f'box starts at the start of the line like a typed one ({r["left"]:.1f})')
        check(r['color'] == 'rgb(31, 79, 207)', f'ink colour kept ({r["color"]})')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(300)
        back = await page.evaluate("[[...__inkwell.cur.items.values()].filter(i => i.t === 's').length, [...__inkwell.cur.items.values()].filter(i => i.t === 'x').length]")
        check(back == [2, 0], f'undo brings the ink back ({back})')
        # snap off: old behaviour (box where the ink was, ink size)
        await page.evaluate("() => { __inkwell.prefs.snapLines = false; }")
        r2 = await page.evaluate("""() => { const W = __inkwell, s = [...W.cur.items.values()].filter(i => i.t === 's'); W.Scribe.recent.clear();
          W.Scribe.place(s, 'come up with', [188, 180, 302, 210]); return [...W.cur.items.values()].find(i => i.t === 'x'); }""")
        check(not r2.get('lh') and abs(r2['x'] - 182) < 1, f'with snapping off the box stays where the ink was ({r2["x"]}, lh {r2.get("lh")})')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
