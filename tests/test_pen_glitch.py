# 1.73.3: a Pencil point that jumps back along the stroke and returns at once must not lay a straight piece over the
# curve. Real fast moves (hairpins, scribbles, a sudden fast flick) must stay exactly as drawn.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

ST = [0, 0]
async def draw(cdp, page, pts):
    async def ev(t, p, btn='left', n=1):
        await cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': ST[0] + p[0], 'y': ST[1] + p[1], 'button': btn, 'buttons': 1 if t != 'mouseReleased' else 0, 'clickCount': n, 'pointerType': 'pen', 'force': 0.5})
    await ev('mousePressed', pts[0])
    for p in pts[1:]:
        await ev('mouseMoved', p); await page.wait_for_timeout(6)
    await ev('mouseReleased', pts[-1]); await page.wait_for_timeout(120)

LAST = """() => { const W = __inkwell, s = [...W.cur.items.values()].filter(i => i.t === 's').pop(), c = W.cam, o = [];
  for(let i = 0; i < s.p.length; i += 3) o.push([s.p[i] * c.z + c.ox, s.p[i+1] * c.z + c.oy]); return o; }"""

def biggest(o): return max(math.hypot(o[i+1][0]-o[i][0], o[i+1][1]-o[i][1]) for i in range(len(o)-1))

def curve(n=50, step=0.07, r=180):
    return [(420 + r*math.cos(2.2 + i*step), 300 + r*math.sin(2.2 + i*step)) for i in range(n)]

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.prefs.snapHold = 0; __inkwell.prefs.wheel = 'off'; __inkwell.setTool('pen'); }")
        await page.wait_for_timeout(300)
        cdp = await ctx.new_cdp_session(page)
        global ST
        ST = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        c = curve()
        await draw(cdp, page, c)
        clean = await page.evaluate(LAST)
        check(len(clean) == len(c), f'plain curve keeps every point ({len(clean)}/{len(c)})')

        for at, back, label in [(30, 20, 'long'), (40, 8, 'short'), (10, 6, 'near the start')]:
            g = c[:at] + [c[at - back]] + c[at:]
            await draw(cdp, page, g)
            o = await page.evaluate(LAST)
            check(biggest(o) < 2 * biggest(clean), f'{label} jump back dropped (largest step {biggest(o):.0f}, clean {biggest(clean):.0f})')
            check(len(o) >= len(c) - 1, f'{label}: curve points kept ({len(o)}/{len(c)})')

        # two stale points in a row
        g = c[:30] + [c[10], c[11]] + c[30:]
        await draw(cdp, page, g)
        o = await page.evaluate(LAST)
        check(biggest(o) < 2 * biggest(clean), f'two stale points dropped ({biggest(o):.0f})')

        # jump back as the very last point before lifting
        g = c[:30] + [c[12]]
        await draw(cdp, page, g)
        o = await page.evaluate(LAST)
        check(biggest(o) < 2 * biggest(clean), f'jump back right before lifting dropped ({biggest(o):.0f})')

        # real moves stay: fast zig-zag scribble, sudden fast flick that keeps going
        zig = [(200 + i*6, 300 + (120 if i % 2 else 0)) for i in range(24)]
        await draw(cdp, page, zig)
        o = await page.evaluate(LAST)
        check(len(o) == len(zig), f'zig-zag scribble kept ({len(o)}/{len(zig)})')
        flick = [(200 + i*3, 600) for i in range(12)] + [(233 + i*60, 600) for i in range(1, 10)]
        await draw(cdp, page, flick)
        o = await page.evaluate(LAST)
        check(len(o) == len(flick) and abs((o[-1][0] - o[0][0]) - (flick[-1][0] - flick[0][0])) < 1, f'sudden fast flick kept ({len(o)}/{len(flick)})')
        hair = [(300 + i*4, 700) for i in range(15)] + [(356 - i*30, 700) for i in range(1, 7)]
        await draw(cdp, page, hair)
        o = await page.evaluate(LAST)
        check(len(o) == len(hair), f'real fast turn back kept ({len(o)}/{len(hair)})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('FAILED' if fails else 'all ok'); raise SystemExit(1 if fails else 0)
asyncio.run(main())
