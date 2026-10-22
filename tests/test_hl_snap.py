# 1.60: highlighter "Stick to text" switch: highlights snap onto the line of text under them.
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
  W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.invalidate();
  // an imported page 800 x 1000 at (100, 50) with three text lines (PDF style: y, text, x0, x1, h as fractions)
  W.docs.set('pt_fakeA', {id: 'pt_fakeA', kind: 'ptxt', deleted: false, data: {a: 'fakeA', src: 'pdf', l: [
    [0.10, 'First line of text', 0.1, 0.6, 0.03], [0.15, 'Second line here', 0.1, 0.8, 0.03], [0.20, 'Third one', 0.1, 0.4, 0.03]]}});
  W.addItems([{t: 'i', id: 'ipage', x: 100, y: 50, w: 800, h: 1000, a: 'fakeA', doc: 1},
              {t: 'x', id: 'xbox', x: 150, y: 600, w: 400, fs: 1, html: '<p>Typed words in a box</p><p>second typed line</p>'}]);
  W.setTool('hl');
}"""
LINES = "[...__inkwell.cur.items.values()].filter(i => i.t === 's' && i.hl).map(i => ({w: i.w, p: Array.from(i.p)}))"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 900})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate(SETUP); await page.wait_for_timeout(300)
        # switch shows with the highlighter only
        vis = await page.evaluate("!document.getElementById('hlSnap').hidden")
        check(vis, 'Stick to text switch shown with the highlighter')
        await page.evaluate("__inkwell.setTool('pen')")
        check(await page.evaluate("document.getElementById('hlSnap').hidden"), 'switch hidden with the pen')
        await page.evaluate("__inkwell.setTool('hl')")
        await page.click('#hlSnap'); await page.wait_for_timeout(200)
        check(await page.evaluate("__inkwell.prefs.hlSnap === true && document.getElementById('hlSnap').classList.contains('on')"), 'switch turns on')
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        async def stroke(pts):
            await page.mouse.move(st[0] + pts[0][0], st[1] + pts[0][1]); await page.mouse.down()
            for x, y in pts[1:]: await page.mouse.move(st[0] + x, st[1] + y, steps=3)
            await page.mouse.up(); await page.wait_for_timeout(250)
        # line 2 of the page: y 0.15 .. 0.18 of 1000 at y 50 -> world 200..230, x 180..740
        await stroke([(300, 222), (350, 210), (420, 225), (500, 212), (560, 220)])
        hl = await page.evaluate(LINES)
        check(len(hl) == 1, f'one highlight ({len(hl)})')
        if hl:
            h = hl[0]; ys = h['p'][1::3]; xs = h['p'][0::3]
            check(abs(h['w'] - 30) < 1, f'as tall as the line ({h["w"]:.1f})')
            check(max(ys) - min(ys) < 0.01 and abs(ys[0] - 215) < 1, f'straight on the line middle ({ys[0]:.1f})')
            check(min(xs) >= 299 and max(xs) <= 561, f'follows where the highlighter went ({min(xs):.0f}..{max(xs):.0f})')
        # past the end of a short line: cut at the line's end (line 3: x 180..420, y 250..280)
        await stroke([(200, 262), (300, 268), (600, 266)])
        hl = await page.evaluate(LINES)
        h = hl[-1]; xs = h['p'][0::3]; ys = h['p'][1::3]
        check(max(xs) <= 421 and abs(ys[0] - 265) < 1, f'cut at the end of the line ({max(xs):.0f}, y {ys[0]:.0f})')
        # drawn down across lines 1..3: three bands
        n0 = len(hl)
        await stroke([(250, 150), (300, 200), (350, 270)])
        hl = await page.evaluate(LINES)
        check(len(hl) - n0 == 3, f'down across three lines marks three ({len(hl) - n0})')
        # typed text box, first row
        box = await page.evaluate("""(() => { const el = document.querySelector('#worldFront [data-id="xbox"]'); const r = el.querySelector('p').getBoundingClientRect(); const s = document.getElementById('stage').getBoundingClientRect(); return [r.left - s.left, r.top - s.top, r.right - s.left, r.bottom - s.top]; })()""")
        n0 = len(hl)
        cy = (box[1] + box[3]) / 2
        await stroke([(box[0] + 5, cy + 6), (box[0] + 60, cy - 4), (box[0] + 120, cy + 3)])
        hl = await page.evaluate(LINES)
        h = hl[-1]; ys = h['p'][1::3]
        check(len(hl) - n0 == 1 and abs(ys[0] - cy) < 2 and 0.6 < h['w'] / (box[3] - box[1]) < 1.05, f'snaps onto a typed text line (y {ys[0]:.1f} vs {cy:.1f}, h {h["w"]:.1f} vs {box[3] - box[1]:.1f})')
        # no text: level stroke straightened, a circle kept as drawn
        n0 = len(hl)
        await stroke([(400, 480), (460, 472), (520, 486), (580, 475)])
        hl = await page.evaluate(LINES)
        ys = hl[-1]['p'][1::3]
        check(len(hl) - n0 == 1 and max(ys) - min(ys) < 0.01, 'level stroke on empty paper becomes straight')
        n0 = len(hl)
        await stroke([(420, 400), (470, 350), (520, 400), (470, 450), (420, 400)])
        hl = await page.evaluate(LINES)
        ys = hl[-1]['p'][1::3]
        check(len(hl) - n0 == 1 and max(ys) - min(ys) > 50, 'a circle stays as drawn')
        # undo removes the three bands at once
        n0 = await page.evaluate(f"({LINES}).length")
        await page.evaluate("(async () => { __inkwell.undo(); __inkwell.undo(); __inkwell.undo(); })()")   # circle, level, box
        await page.evaluate("__inkwell.undo()")  # three bands
        n1 = await page.evaluate(f"({LINES}).length")
        check(n0 - n1 == 6, f'undo takes back a multi-line highlight in one step ({n0 - n1})')
        # off: freehand again
        await page.click('#hlSnap'); await page.wait_for_timeout(200)
        n0 = n1
        await stroke([(300, 222), (350, 210), (420, 225)])
        hl = await page.evaluate(LINES)
        ys = hl[-1]['p'][1::3]
        check(len(hl) - n0 == 1 and max(ys) - min(ys) > 5, 'off: highlighter draws freely')
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        check(await page.evaluate("__inkwell.prefs.hlSnap === false"), 'setting remembered after reload')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
