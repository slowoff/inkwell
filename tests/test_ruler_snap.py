# 1.50: Snap pill on the ruler (prefs.ruler.snap, missing = on). On: turning the ruler (mouse turn handle or
# two-finger twist) clicks into 15 deg steps when close. Off: any angle. A tap on the pill toggles it and never
# draws or moves the ruler.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

RULER = "(() => { const r = __inkwell.prefs.ruler; return {a: r.a * 180 / Math.PI, cx: r.cx, cy: r.cy, snap: r.snap, on: document.getElementById('rulerSnap').classList.contains('on'), n: [...__inkwell.cur.items.values()].length}; })()"

async def boot(page):
    await page.wait_for_timeout(3000)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

async def open_ruler(page):
    await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.prefs.ruler.a = 0; __inkwell.setTool('pen'); }")
    await page.wait_for_timeout(300)
    if not await page.evaluate("__inkwell.prefs.ruler.on"): await page.click('#rulerBtn')
    await page.wait_for_timeout(300)

async def turn_mouse(page, deg):
    # drag the right turn handle around the ruler centre by deg (clockwise positive)
    h = await page.evaluate("(() => { const b = document.getElementById('rulerTurnR').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()")
    stage = await page.evaluate("(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.left, b.top]; })()")
    r = await page.evaluate(RULER)
    cx, cy = stage[0] + r['cx'], stage[1] + r['cy']
    R = math.hypot(h[0] - cx, h[1] - cy); a0 = math.atan2(h[1] - cy, h[0] - cx)
    await page.mouse.move(*h); await page.mouse.down()
    for i in range(1, 21):
        a = a0 + math.radians(deg) * i / 20
        await page.mouse.move(cx + R * math.cos(a), cy + R * math.sin(a))
    await page.mouse.up(); await page.wait_for_timeout(200)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # computer (mouse): turn handles visible
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await boot(page)
        await open_ruler(page)
        r = await page.evaluate(RULER)
        check(r['on'] and r['snap'] is None, f'Snap pill shown and on by default ({r})')
        vis = await page.evaluate("""(() => { const s = document.getElementById('rulerSnap').getBoundingClientRect(), g = document.getElementById('rulerGrip').getBoundingClientRect(),
          a = document.getElementById('rulerAngle').getBoundingClientRect(), ru = document.getElementById('ruler').getBoundingClientRect();
          const ov = (p, q) => p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom;
          return {inside: s.top >= ru.top && s.bottom <= ru.bottom, grip: ov(s, g), angle: ov(s, a), w: s.width}; })()""")
        check(vis['inside'] and not vis['grip'] and not vis['angle'] and vis['w'] > 40, f'pill inside the ruler, not over the grip or angle ({vis})')

        await turn_mouse(page, 43)
        r = await page.evaluate(RULER)
        check(abs(r['a'] - 45) < 0.05, f'snap on: turned 43 deg -> {r["a"]:.2f}')

        await page.click('#rulerSnap'); await page.wait_for_timeout(200)
        r2 = await page.evaluate(RULER)
        check(r2['snap'] is False and not r2['on'], f'click turns it off ({r2})')
        check(r2['n'] == r['n'] and abs(r2['a'] - r['a']) < 1e-6 and r2['cx'] == r['cx'], 'click drew nothing and did not move or turn the ruler')
        await turn_mouse(page, -3)
        r = await page.evaluate(RULER)
        check(abs(r['a'] - 42) < 0.6 and abs(r['a'] - 45) > 1, f'snap off: 45 - 3 deg stays at {r["a"]:.2f}')

        await page.reload(); await boot(page)
        r = await page.evaluate(RULER)
        check(r['snap'] is False and not r['on'], f'off after reload ({r})')
        check(abs(r['a'] - 42) < 0.6, f'angle set right before the reload was kept ({r["a"]:.2f})')
        if os.environ.get('SNAP_SHOT'): await page.screenshot(path=os.environ['SNAP_SHOT'])
        await page.click('#rulerSnap'); await page.wait_for_timeout(150)
        check((await page.evaluate(RULER))['on'], 'click turns it back on')
        await ctx.close()

        # iPad-like (touch): finger tap on the pill toggles; two-finger twist snaps only when on
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await boot(page)
        await open_ruler(page)
        cdp = await ctx.new_cdp_session(page)
        async def touch(kind, pts):
            await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})
        s = await page.evaluate("(() => { const b = document.getElementById('rulerSnap').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.height]; })()")
        check(s[2] >= 44, f'pill is 44 px tall on touch ({s[2]})')
        before = await page.evaluate(RULER)
        await touch('touchStart', [(s[0], s[1])]); await page.wait_for_timeout(60); await touch('touchEnd', []); await page.wait_for_timeout(400)
        r = await page.evaluate(RULER)
        check(r['snap'] is False and r['n'] == before['n'] and r['cx'] == before['cx'], f'finger tap toggles off, no ink, ruler not moved ({r})')

        async def twist(deg):
            st = await page.evaluate("(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.left, b.top]; })()")
            rr = await page.evaluate(RULER)
            cx, cy = st[0] + rr['cx'], st[1] + rr['cy']
            # two fingers on the ruler, 120 px either side of the centre, turned together
            a0 = math.radians(rr['a'])
            def pts(t):
                a = a0 + math.radians(deg) * t
                return [(cx - 120 * math.cos(a), cy - 120 * math.sin(a)), (cx + 120 * math.cos(a), cy + 120 * math.sin(a))]
            await touch('touchStart', pts(0)); await page.wait_for_timeout(50)
            for i in range(1, 16): await touch('touchMove', pts(i / 15)); await page.wait_for_timeout(16)
            await touch('touchEnd', []); await page.wait_for_timeout(300)
        await twist(44)
        r = await page.evaluate(RULER)
        check(abs(r['a'] - 44) < 0.8 and abs(r['a'] - 45) > 0.3, f'snap off: two-finger twist to 44 stays at {r["a"]:.2f}')
        s2 = await page.evaluate("(() => { const b = document.getElementById('rulerSnap').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()")
        await touch('touchStart', [s2]); await page.wait_for_timeout(60); await touch('touchEnd', []); await page.wait_for_timeout(400)
        r = await page.evaluate(RULER)
        check(r['snap'] is True and r['on'], f'finger tap turns it back on ({r})')
        await page.evaluate("__inkwell.prefs.ruler.a = 0")
        await twist(-14)
        r = await page.evaluate(RULER)
        check(abs(r['a'] + 15) < 0.05, f'snap on: two-finger twist to -14 snaps to -15 ({r["a"]:.2f})')

        check(not errs, f'no page errors ({errs[:2]})')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
