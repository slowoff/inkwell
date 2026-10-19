# 1.42: Writing menu (pen options): Write to text + Reference line. The reference line is a faint dashed line
# under the line being written (height of its first word); ink is never moved. Replaces 1.41's levelling/spacing.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

STROKES = """() => [...__inkwell.cur.items.values()].filter(i => i.t === 's').map(s => Array.from(s.p))"""
# rows of the live canvas (CSS px, stage coords) that hold drawn pixels
LIVE_ROWS = """() => { const c = document.getElementById('live'), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data;
  const k = c.width / c.getBoundingClientRect().width, rows = new Set();
  for(let y = 0; y < c.height; y++) for(let i = 0; i < c.width; i += 2){ if(d[(y * c.width + i) * 4 + 3] > 10){ rows.add(Math.round(y / k)); break; } }
  return [...rows]; }"""

async def letter(page, x, y, w=16, h=26):
    pts = [(x + w / 2, y - h)]
    for k in range(1, 19):
        a = -math.pi / 2 - 2 * math.pi * k / 18
        pts.append((x + w / 2 + w / 2 * math.cos(a), y - h / 2 - h / 2 * math.sin(a)))
    pts.append((x + w + 2, y - 2))
    await page.mouse.move(*pts[0]); await page.mouse.down()
    for p in pts[1:]: await page.mouse.move(*p)
    await page.mouse.up()
    return pts

async def write(page, x, y, words=4, drift=5):
    drawn = []
    for wi in range(words):
        for li in range(3):
            drawn.append(await letter(page, x, y)); x += 21
        x += 25; y += drift
        await page.wait_for_timeout(150)
    return drawn

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        # an install that had 1.41's "Keep lines level" on gets the reference line on
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.evaluate("() => { const p = JSON.parse(localStorage.getItem('inkwell.prefs') || '{}'); p.assist = {level: true, space: true}; delete p.refLine; localStorage.setItem('inkwell.prefs', JSON.stringify(p)); }")
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        pr = await page.evaluate("() => [__inkwell.prefs.refLine, 'assist' in __inkwell.prefs]")
        check(pr == [True, False], f'1.41 levelling setting becomes Reference line on ({pr})')

        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); }"); await page.wait_for_timeout(400)
        # menu
        check(await page.evaluate("() => !document.getElementById('assistBtn').hidden"), 'Writing button shown with the pen')
        inpop = await page.evaluate("() => !!document.querySelector('#assistPop #scribeBtn') && !!document.querySelector('#assistPop #waRef') && !document.querySelector('#toolbar > #scribeBtn')")
        check(inpop, 'Write to text and Reference line are in the Writing menu (no separate toolbar toggle)')
        await page.click('#assistBtn'); await page.wait_for_selector('#assistPop', state='visible')
        check(await page.evaluate("() => document.getElementById('waRef').classList.contains('on')"), 'menu shows Reference line on')
        await page.click('#scribeBtn'); await page.wait_for_timeout(100)
        check(await page.evaluate("() => __inkwell.prefs.autoText === true"), 'Write to text switches on from the menu')
        await page.click('#scribeBtn'); await page.wait_for_timeout(100)
        check(await page.evaluate("() => __inkwell.prefs.autoText === false"), 'and off again')
        await page.mouse.click(1100, 780); await page.wait_for_timeout(200)
        await page.evaluate("() => { const W = __inkwell; W.removeItems([...W.cur.items.keys()]); W.cur.wa = null; W.WA.last = null; }")
        check(await page.evaluate("() => document.getElementById('assistPop').hidden"), 'menu closes when tapping the page')

        box = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        X, Y = box[0] + 60, box[1] + 200
        drawn = await write(page, X, Y)
        st = await page.evaluate(STROKES)
        cam = await page.evaluate("() => [__inkwell.cam.z, __inkwell.cam.ox, __inkwell.cam.oy]")
        z, ox, oy = cam
        moved = 0
        for s, d in zip(st, drawn):
            sx, sy = s[0] * z + ox + box[0], s[1] * z + oy + box[1]
            moved = max(moved, abs(sx - d[0][0]), abs(sy - d[0][1]))
        check(len(st) == 12 and moved < 1.0, f'ink stays exactly where it was written ({len(st)} strokes, max shift {moved:.2f} px)')

        rows = await page.evaluate(LIVE_ROWS)
        y0 = Y - box[1]
        check(rows and all(y0 - 1 <= r <= y0 + 5 for r in rows), f'faint line shown under the first word after lifting the pen (rows {rows[:4]}, letters end at {y0:.0f})')
        # while writing: line is there during the stroke too
        await page.mouse.move(X + 21 * 12 + 120, Y - 20); await page.mouse.down()
        for k in range(8): await page.mouse.move(X + 21 * 12 + 120 + 3 * k, Y - 20 + 2 * k)
        rows2 = await page.evaluate(LIVE_ROWS)
        await page.mouse.up()
        check(any(y0 - 1 <= r <= y0 + 5 for r in rows2), 'line shown while writing')
        await page.wait_for_timeout(5800)
        rows3 = await page.evaluate(LIVE_ROWS)
        check(not rows3, f'line fades away a few seconds after the pen is lifted ({len(rows3)} rows left)')

        # 1.42.1: i-dots, t-bars, a dot before the first letter and a descender never set the line
        async def dash(x0, y0_, x1, y1_):
            await page.mouse.move(x0, y0_); await page.mouse.down()
            for k in range(1, 6): await page.mouse.move(x0 + (x1 - x0) * k / 5, y0_ + (y1_ - y0_) * k / 5)
            await page.mouse.up(); await page.wait_for_timeout(80)
        await page.evaluate("() => { const W = __inkwell; W.removeItems([...W.cur.items.keys()]); W.cur.wa = null; W.WA.last = null; }")
        Y2 = Y + 120; y2 = Y2 - box[1]
        await dash(X - 10, Y2 - 45, X - 8, Y2 - 44)                       # stray dot before writing
        n0 = await page.evaluate("() => (__inkwell.cur.wa ? __inkwell.cur.wa.lines.length : 0)")
        check(n0 == 0, f'a dot on its own does not start a line ({n0})')
        await letter(page, X, Y2)
        # descender: a "g"-like stroke reaching 14 px below the line
        await page.mouse.move(X + 29, Y2 - 26); await page.mouse.down()
        for k in range(1, 15): await page.mouse.move(X + 29 + (k % 3) * 4, Y2 - 26 + 40 * k / 14)
        await page.mouse.up()
        await letter(page, X + 42, Y2); await letter(page, X + 63, Y2)
        await dash(X + 8, Y2 - 46, X + 9, Y2 - 45)                         # i-dot above the first letter
        await dash(X + 60, Y2 - 22, X + 82, Y2 - 23)                       # t-bar across the top
        await page.wait_for_timeout(150)
        n1 = await page.evaluate("() => __inkwell.cur.wa.lines.length")
        rows = await page.evaluate(LIVE_ROWS)
        check(n1 == 1, f'dots and bars stay on the same line ({n1} lines)')
        check(rows and all(y2 - 1 <= r <= y2 + 5 for r in rows), f'line stays at the bottom of the letters after a dot, a bar and a descender (rows {rows[:4]}, letters end at {y2:.0f})')
        # while drawing a dot above, the line under the letters keeps showing
        await page.mouse.move(X + 50, Y2 - 48); await page.mouse.down(); await page.mouse.move(X + 51, Y2 - 47)
        rows = await page.evaluate(LIVE_ROWS)
        await page.mouse.up()
        check(any(y2 - 1 <= r <= y2 + 5 for r in rows), 'while dotting an i the line stays under the letters')

        # off: no line
        await page.evaluate("() => { __inkwell.prefs.refLine = false; }")
        await page.wait_for_timeout(5800); await letter(page, X, Y + 250); await page.wait_for_timeout(200)
        check(not await page.evaluate(LIVE_ROWS), 'no line when Reference line is off')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
