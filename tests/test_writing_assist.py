# 1.41: Writing assist (pen options -> Assist): Keep lines level, Even word spacing.
# Writes "words" of loop letters with the mouse: each word 5 px lower than the one before, uneven gaps.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

STROKES = """() => [...__inkwell.cur.items.values()].filter(i => i.t === 's').map(s => ({id: s.id, p: Array.from(s.p)}))"""

async def letter(page, x, y, w=16, h=26):
    # one closed loop (an "o") from the top, then a small tail: ~20 points
    await page.mouse.move(x + w / 2, y - h); await page.mouse.down()
    for k in range(1, 19):
        a = -math.pi / 2 - 2 * math.pi * k / 18
        await page.mouse.move(x + w / 2 + w / 2 * math.cos(a), y - h / 2 + h / 2 * math.sin(a) * -1)
    await page.mouse.move(x + w + 2, y - 2)
    await page.mouse.up()

async def write(page, x0, y0, gaps, drift=5, letters=3, pause=0.15, last_pause=0.9):
    x, y = x0, y0
    for wi, gap in enumerate(gaps + [None]):
        for li in range(letters):
            await letter(page, x, y); await page.wait_for_timeout(40)
            x += 16 + 5
        x -= 5
        if gap is None: break
        await page.wait_for_timeout(int((pause if wi % 2 else 0.8) * 1000))
        x += gap; y += drift
    await page.wait_for_timeout(int(last_pause * 1000))

def words(strokes, per):
    out = []
    for i in range(0, len(strokes), per): out.append(strokes[i:i + per])
    return out

def level(ws):
    ys = sorted(y for s in ws for y in s['p'][1::3]); return ys[round((len(ys) - 1) * 0.7)]
def xr(ws):
    xs = [x for s in ws for x in s['p'][0::3]]; return min(xs), max(xs)

async def new_page(page):
    await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
    await page.evaluate("() => __inkwell.setTool('pen')")

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
        await new_page(page)
        box = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        X, Y = box[0] + 120, box[1] + 200
        gaps = [20, 40, 26, 60]
        Z = await page.evaluate('() => __inkwell.cam.z'); print('zoom', Z)

        # 0. UI: Assist button only with the pen, popover toggles the settings, both off by default
        vis = await page.evaluate("() => !document.getElementById('assistBtn').hidden")
        check(vis, 'Assist button shown with the pen')
        await page.evaluate("() => __inkwell.setTool('hl')")
        check(await page.evaluate("() => document.getElementById('assistBtn').hidden"), 'Assist button hidden with the highlighter')
        await page.evaluate("() => __inkwell.setTool('pen')")
        a0 = await page.evaluate("() => __inkwell.prefs.assist")
        check(a0 == {'level': False, 'space': False}, f'both assists off by default ({a0})')

        # 1. off: ink stays exactly where it was written
        await write(page, X, Y, gaps)
        st = await page.evaluate(STROKES); ws = words(st, 3)
        lv = [level(w) for w in ws]
        check(len(st) == 15, f'15 strokes ({len(st)})')
        check((lv[-1] - lv[0]) * Z > 15, f'without assist the line drifts ({lv[-1] - lv[0]:.1f})')

        # 2. Keep lines level (through the popover)
        await new_page(page)
        await page.click('#assistBtn'); await page.wait_for_selector('#assistPop', state='visible')
        await page.click('#waLevel'); await page.mouse.click(box[0] + 20, box[1] + box[3] - 20)  # click away closes it
        await page.wait_for_timeout(200)
        check(await page.evaluate("() => __inkwell.prefs.assist.level === true && document.getElementById('assistBtn').classList.contains('on')"), 'Keep lines level switched on')
        await page.evaluate("async () => { const W = __inkwell; for(const s of [...W.cur.items.values()]) W.removeItems([s.id]); }")
        await write(page, X, Y, gaps)
        st = await page.evaluate(STROKES); ws = words(st, 3)
        lv = [level(w) for w in ws]
        spread = max(lv) - min(lv)
        check(len(st) == 15, f'15 strokes ({len(st)})')
        check(spread < 2.5, f'all words on one level ({spread:.1f}, was ~20)')
        # letters inside a word keep their shape relative to each other
        rel = [w[1]['p'][1] - w[0]['p'][1] for w in ws]
        check(max(rel) - min(rel) < 0.5, 'letters inside a word move together')
        # spacing untouched when only levelling is on
        g = [xr(ws[i + 1])[0] - xr(ws[i])[1] for i in range(4)]
        check(abs((g[1] - g[0]) * Z - 20) < 2 and abs((g[3] - g[0]) * Z - 40) < 2, f'gaps unchanged without Even spacing ({[round(v) for v in g]})')

        # undo: one stroke per press, the rest stays level
        for _ in range(3): await page.evaluate("() => document.getElementById('undo').click()")
        st2 = await page.evaluate(STROKES); ws2 = words(st2, 3)
        lv2 = [level(w) for w in ws2]
        check(len(st2) == 12, f'three undos take away three strokes ({len(st2)})')
        check(max(lv2) - min(lv2) < 2.5, 'after undo the earlier words are still level')
        for _ in range(3): await page.evaluate("() => document.getElementById('redo').click()")
        st3 = await page.evaluate(STROKES)
        check(len(st3) == 15 and max(level(w) for w in words(st3, 3)) - min(level(w) for w in words(st3, 3)) < 2.5, 'redo brings them back level')

        # saved: reload keeps the levelled ink
        await page.evaluate("async () => { await __inkwell.flushSaves(); }")
        pid = await page.evaluate("() => __inkwell.cur.id")
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate(f"async () => {{ await __inkwell.openPage('{pid}'); }}"); await page.wait_for_timeout(300)
        st4 = await page.evaluate(STROKES); ws4 = words(st4, 3)
        check(len(st4) == 15 and max(level(w) for w in ws4) - min(level(w) for w in ws4) < 2.5, 'levelled ink saved and back after reload')
        check(await page.evaluate("() => __inkwell.prefs.assist.level === true"), 'setting remembered after reload')

        # 3. Even word spacing (and level) on a new page
        await new_page(page)
        await page.evaluate("() => { __inkwell.prefs.assist = {level: true, space: true}; }")
        await write(page, X, Y, gaps)
        st = await page.evaluate(STROKES); ws = words(st, 3)
        g = [xr(ws[i + 1])[0] - xr(ws[i])[1] for i in range(4)]
        check(max(g) - min(g) < 2.5, f'all word gaps the same ({[round(v, 1) for v in g]}, written {gaps})')
        lv = [level(w) for w in ws]
        check(max(lv) - min(lv) < 2.5, f'and level ({max(lv) - min(lv):.1f})')
        # letter gaps (5 px) are not touched
        lg = [xr([ws[1][k + 1]])[0] - xr([ws[1][k]])[1] for k in range(2)]
        check(all(abs(v - lg[0]) < 1 for v in lg) and lg[0] * Z < 8, f'gaps between letters left alone ({[round(v, 1) for v in lg]})')

        # 4. a dot put back over an earlier word stays where it was put; a big drawing is left alone
        before = {s['id']: s['p'] for s in st}
        tx, _ = xr(ws[1])
        sx, sy = await page.evaluate(f"() => {{ const c = __inkwell.cam; return [{tx} * c.z + c.ox, {lv[1]} * c.z + c.oy]; }}")
        dot_at = (box[0] + sx + 8, box[1] + sy - 40)
        await page.mouse.move(*dot_at); await page.mouse.down(); await page.mouse.move(dot_at[0] + 2, dot_at[1] + 1); await page.mouse.move(dot_at[0] + 3, dot_at[1] + 3); await page.mouse.up()
        await page.wait_for_timeout(900)
        st5 = await page.evaluate(STROKES)
        dot = [s for s in st5 if s['id'] not in before][0]
        dz = await page.evaluate("() => [__inkwell.cam.z, __inkwell.cam.ox, __inkwell.cam.oy]")
        check(abs(dot['p'][0] * dz[0] + dz[1] + box[0] - dot_at[0]) < 1.5 and abs(dot['p'][1] * dz[0] + dz[2] + box[1] - dot_at[1]) < 1.5, 'dot over an earlier word stays where it was put')
        check(all(s['p'] == before[s['id']] for s in st5 if s['id'] in before), 'nothing else moved')
        # big loop drawing
        await page.mouse.move(X, Y + 250); await page.mouse.down()
        for k in range(1, 40): await page.mouse.move(X + 150 * math.cos(k / 6) + 150 - 150, Y + 250 + 120 * math.sin(k / 6))
        await page.mouse.up(); await page.wait_for_timeout(900)
        st6 = await page.evaluate(STROKES)
        check(len(st6) == len(st5) + 1 and all(s['p'] == before.get(s['id'], s['p']) for s in st6 if s['id'] in before), 'drawing added without moving writing')

        # 5. off while Write to text is on
        await new_page(page)
        await page.evaluate("() => { __inkwell.prefs.autoText = true; }")
        on = await page.evaluate("() => __inkwell.WA.on()")
        check(on is False, 'assist paused while Write to text is on')
        await page.evaluate("() => { __inkwell.prefs.autoText = false; __inkwell.prefs.assist = {level: false, space: false}; }")

        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
