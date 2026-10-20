# 1.50: Shapes popover -> "Snap lines to angles" switch (prefs angleSnap); 1.51: renamed "Snap to angles", also
# gates the 15 deg clicking when a selection is turned with the rotate handle. On (default): a Line / Arrow drawn
# within ~3 deg of a 15 deg step clicks onto it (0, 15, 45, 90 ...). Off: the line keeps the exact dragged angle.
# Hold-to-straighten (prefs snapHold) is not touched by the switch; 1.49's mistaken use of it is undone once.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

STROKES = """() => [...__inkwell.cur.items.values()].filter(i => i.t === 's').map(s => Array.from(s.p))"""

def angle(P):
    return math.degrees(math.atan2(P[-2] - P[1], P[-3] - P[0]))

def wobble(P):
    pts = [(P[i], P[i + 1]) for i in range(0, len(P), 3)]
    (ax, ay), (bx, by) = pts[0], pts[-1]
    L = math.hypot(bx - ax, by - ay) or 1
    return max(abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / L for x, y in pts)

async def pick(page, shape):
    await page.click('#shapeBtn'); await page.wait_for_selector('#shapeGrid', state='visible')
    await page.click(f'#shapeGrid button[data-shape="{shape}"]'); await page.wait_for_timeout(150)

async def drag(page, x, y, deg, length=240):
    a = math.radians(deg)
    await page.mouse.move(x, y); await page.mouse.down()
    for i in range(1, 13): await page.mouse.move(x + length * math.cos(a) * i / 12, y + length * math.sin(a) * i / 12)
    await page.mouse.up(); await page.wait_for_timeout(250)

async def wobbly_line(page, x, y):
    await page.mouse.move(x, y); await page.mouse.down()
    for i in range(1, 61):
        await page.mouse.move(x + 5 * i, y + 4 * math.sin(i / 4)); await page.wait_for_timeout(8)
    await page.wait_for_timeout(1200)
    await page.mouse.up(); await page.wait_for_timeout(250)

async def rotate_rect(page, x, y, deg):
    # draw a rectangle from the Shapes menu (it ends up selected), then drag the rotate handle around its centre
    await pick(page, 'rect'); await page.mouse.move(x, y); await page.mouse.down()
    for i in range(1, 9): await page.mouse.move(x + 20 * i, y + 12 * i)
    await page.mouse.up(); await page.wait_for_timeout(300)
    h = await page.evaluate("(() => { const b = document.getElementById('selRot').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()")
    cx, cy = x + 80, y + 48
    R = math.hypot(h[0] - cx, h[1] - cy); a0 = math.atan2(h[1] - cy, h[0] - cx)
    await page.mouse.move(*h); await page.mouse.down()
    for i in range(1, 25):
        a = a0 + math.radians(deg) * i / 24
        await page.mouse.move(cx + R * math.cos(a), cy + R * math.sin(a))
    lab = await page.inner_text('#selAng')
    await page.mouse.up(); await page.wait_for_timeout(300)
    ra = await page.evaluate("(() => { const s = [...__inkwell.cur.items.values()].filter(i => i.t === 's'); return s[s.length - 1].ra || 0; })()")
    await page.evaluate("__inkwell.setTool('pen')")
    return ra, lab.strip()

async def switch(page):
    await page.click('#shapeBtn'); await page.wait_for_selector('#snapShapes', state='visible')
    await page.click('#snapShapes'); await page.wait_for_timeout(150)
    await page.click('#shapeBtn'); await page.wait_for_timeout(150)

async def boot(page):
    # a fresh browser installs the offline cache and reloads once; wait for that before touching anything
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))

        # 0. migration: a 1.49 iPad that turned the old switch off gets hold-to-straighten back
        await page.goto(URL); await boot(page)
        await page.evaluate("""() => { const p = JSON.parse(localStorage.getItem('inkwell.prefs') || '{}');
          p.snapHold = 0; p.snapHoldLast = 350; delete p.v150; localStorage.setItem('inkwell.prefs', JSON.stringify(p)); }""")
        await page.reload(); await boot(page)
        m = await page.evaluate("({h: __inkwell.prefs.snapHold, l: __inkwell.prefs.snapHoldLast, v: __inkwell.prefs.v150})")
        check(m['h'] == 350 and m['l'] is None and m['v'] == 1, f'1.49 switch-off undone: snapHold back to 350 ({m})')
        await page.evaluate("""() => { __inkwell.prefs.snapHold = 0; localStorage.setItem('inkwell.prefs', JSON.stringify(__inkwell.prefs)); }""")
        await page.reload(); await boot(page)
        m = await page.evaluate("__inkwell.prefs.snapHold")
        check(m == 0, f'migration runs once: a later Off in Settings stays Off ({m})')
        await page.evaluate("""() => { __inkwell.prefs.snapHold = 550; localStorage.setItem('inkwell.prefs', JSON.stringify(__inkwell.prefs)); }""")
        await page.reload(); await boot(page)

        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        box = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        x0, y0 = box[0] + 120, box[1] + 120

        # 1. default on: Line drawn at 43 deg lands on 45, Arrow at 2 deg lands on 0
        await page.click('#shapeBtn'); await page.wait_for_selector('#snapShapes', state='visible')
        on = await page.evaluate("document.getElementById('snapShapes').classList.contains('on')")
        label = await page.inner_text('#snapShapes')
        check(on and label.strip() == 'Snap to angles', f'switch "{label.strip()}" is on by default')
        await page.click('#shapeBtn'); await page.wait_for_timeout(150)
        await pick(page, 'line'); await drag(page, x0, y0, 43)
        s = await page.evaluate(STROKES)
        check(len(s) == 1 and abs(angle(s[-1]) - 45) < 0.05, f'on: line at 43 deg snaps to 45 ({angle(s[-1]):.2f})')
        await pick(page, 'arrow'); await drag(page, x0, y0 + 260, 2)
        s = await page.evaluate(STROKES)
        check(abs(angle(s[-2]) - 0) < 0.05, f'on: arrow at 2 deg snaps to 0 ({angle(s[-2]):.2f})')

        ra, lab = await rotate_rect(page, x0 + 330, y0 + 300, 43)
        check(ra == 45 and lab == '45°', f'on: shape turned 43 deg clicks to 45 (ra {ra}, label {lab})')

        # 2. off: angles kept exactly
        await switch(page)
        st = await page.evaluate("({a: __inkwell.prefs.angleSnap, h: __inkwell.prefs.snapHold, on: document.getElementById('snapShapes').classList.contains('on')})")
        check(st['a'] is False and not st['on'] and st['h'] == 550, f'switch off -> angleSnap false, hold-to-straighten untouched ({st})')
        n0 = len(await page.evaluate(STROKES))
        await pick(page, 'line'); await drag(page, x0 + 300, y0, 43)
        s = await page.evaluate(STROKES)
        check(len(s) == n0 + 1 and abs(angle(s[-1]) - 43) < 0.6, f'off: line keeps 43 deg ({angle(s[-1]):.2f})')
        await pick(page, 'line'); await drag(page, x0 + 300, y0 + 260, 89)
        s = await page.evaluate(STROKES)
        check(abs(angle(s[-1]) - 89) < 0.6, f'off: nearly vertical line keeps 89 deg ({angle(s[-1]):.2f})')

        ra, lab = await rotate_rect(page, x0 + 20, y0 + 300, 43)
        check(abs(ra - 43) <= 1 and ra != 45 and lab == f'{ra}°', f'off: shape turned 43 deg stays at {ra} (label {lab})')

        # 3. hold-to-straighten still works with the switch off
        await page.evaluate("__inkwell.setTool('pen')")
        await wobbly_line(page, x0, y0 + 420)
        s = await page.evaluate(STROKES)
        check(wobble(s[-1]) < 0.5, f'hold-to-straighten still on with angle switch off (wobble {wobble(s[-1]):.2f})')

        # 4. survives a reload, and turning back on snaps again
        await page.reload(); await boot(page)
        st = await page.evaluate("({a: __inkwell.prefs.angleSnap, on: document.getElementById('snapShapes').classList.contains('on')})")
        check(st['a'] is False and not st['on'], f'off after reload ({st})')
        await switch(page)
        n0 = len(await page.evaluate(STROKES))
        await pick(page, 'line'); await drag(page, x0 + 450, y0 + 60, 88, 200)
        s = await page.evaluate(STROKES)
        check(len(s) == n0 + 1 and abs(angle(s[-1]) - 90) < 0.05, f'on again: 88 deg snaps to 90 ({angle(s[-1]):.2f})')

        # 5. layout
        await page.click('#shapeBtn'); await page.wait_for_selector('#snapShapes', state='visible')
        g = await page.evaluate("""() => { const p = document.getElementById('shapePop').getBoundingClientRect(), t = document.getElementById('snapShapes').getBoundingClientRect(),
          gr = document.getElementById('shapeGrid').getBoundingClientRect(); return {inside: t.left >= p.left && t.right <= p.right && t.bottom <= p.bottom, below: t.top >= gr.bottom, h: t.height}; }""")
        check(g['inside'] and g['below'] and g['h'] >= 38, f'switch sits inside the popover under the shapes ({g})')
        if os.environ.get('SNAP_SHOT'): await page.screenshot(path=os.environ['SNAP_SHOT'])

        check(not errs, f'no page errors ({errs[:2]})')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
