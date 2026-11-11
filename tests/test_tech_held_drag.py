# 2.3.1: on a technical page, a held (straightened) line's end must keep following the Pencil across other strokes,
# also after it once snapped onto a point (Tech.why used to be overwritten by the snap note, then crashed near strokes).
import asyncio, os, math
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
        await page.goto(URL); await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500); await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate("async () => { const W = __inkwell; await W.newPage(); W.setTool('pen'); }")
        await page.evaluate("""() => { const W = __inkwell, pg = W.docs.get(W.cur.id), s = W.docs.get(pg.data.sec); W.docs.get(s.data.nb).data.tech = true;
            W.prefs.techSnap = 0; W.prefs.techLs = 'f'; W.prefs.angleSnap = false; W.prefs.snapHold = 400;
            W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.setTool('pen'); W.invalidate(); }""")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        async def drag(pts, hold_at=None, steps=8):
            await page.mouse.move(st[0] + pts[0][0], st[1] + pts[0][1]); await page.mouse.down()
            for i, (x, y) in enumerate(pts[1:], 1):
                await page.mouse.move(st[0] + x, st[1] + y, steps=steps)
                if hold_at == i: await page.wait_for_timeout(900)
            await page.mouse.up(); await page.wait_for_timeout(300)
        # a cluster of short strokes to cross (like a drawing), several stroke ends inside it
        for k in range(5):
            y = 200 + k * 30
            await drag([(380, y), (420, y + 4), (470, y + 2)])
        n0 = await page.evaluate("__inkwell.cur.items.size")
        # held line from bottom left; then drag its end onto a stroke end (snaps), on through the cluster, out to empty paper
        path = [(100, 560), (180, 520), (240, 490), (241, 490),
                (380, 320),    # the end of the 5th... near (380, 320) = start of stroke 5 -> snaps
                (420, 260), (470, 200), (520, 150), (560, 100)]
        await drag(path, hold_at=3, steps=12)
        s = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.geo && i.geo.k === 'l').map(i => i.geo.v)")
        check(len(s) == 1, f'held stroke became one straight line ({len(s)})')
        if s:
            v = s[0]
            check(math.hypot(v[2] - 560, v[3] - 100) < 3, f'its end followed the Pencil across the other strokes to the end ({[round(c) for c in v[2:]]} vs [560, 100])')
        check(await page.evaluate("typeof Tech.why === 'function'"), 'snapping helper still intact after a snap')
        # and once more: a second held line ending exactly on a stroke end still snaps there
        await drag([(100, 700), (160, 690), (220, 680), (221, 680), (468, 262)], hold_at=3)
        s = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.geo && i.geo.k === 'l').map(i => i.geo.v)")
        ends = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => !i.geo).map(i => [i.p[i.p.length-3], i.p[i.p.length-2]])")
        if len(s) == 2:
            e = s[1][2:]
            check(any(math.hypot(e[0] - q[0], e[1] - q[1]) < 1e-6 for q in ends), f'second line snaps onto a stroke end ({[round(c, 1) for c in e]})')
        else: check(False, f'second held line ({len(s)})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
