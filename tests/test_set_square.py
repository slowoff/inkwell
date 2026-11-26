# 2.8: set square (Geodreieck) form of the ruler (prefs.ruler.k 'g'). The kind pill switches; pens follow all three
# edges (long edge, both 45 deg legs); the mm scale and degree scale are drawn; it survives a reload; the pill
# switches back. Old prefs without k stay a ruler.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

R = "(() => { const r = __inkwell.prefs.ruler; return {k: r.k || null, a: r.a, cx: r.cx, cy: r.cy, geo: document.getElementById('ruler').classList.contains('geo')}; })()"
LAST = """(() => { const it = [...__inkwell.cur.items.values()].filter(i => i.t === 's').pop(); if(!it) return null;
  const p = it.p, z = __inkwell.cam.z, xs = [], ys = []; for(let i = 0; i < p.length; i += 3){ xs.push(p[i]); ys.push(p[i + 1]); }
  return {xs, ys, n: [...__inkwell.cur.items.values()].length}; })()"""

async def boot(page):
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await boot(page)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.prefs.ruler.a = 0; __inkwell.setTool('pen'); }")
        await page.wait_for_timeout(300)
        if not await page.evaluate("__inkwell.prefs.ruler.on"): await page.click('#rulerBtn')
        await page.wait_for_timeout(300)
        r = await page.evaluate(R)
        check(r['k'] is None and not r['geo'], f'starts as the ruler ({r})')
        cdp = await ctx.new_cdp_session(page)
        async def touch(kind, pts):
            await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})
        pill = "(() => { const b = document.getElementById('rulerKind').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width, b.height]; })()"
        k = await page.evaluate(pill)
        ov = await page.evaluate("""(() => { const k = document.getElementById('rulerKind').getBoundingClientRect(), s = document.getElementById('rulerSnap').getBoundingClientRect(), a = document.getElementById('rulerAngle').getBoundingClientRect();
          const o = (p, q) => p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom; return o(k, s) || o(k, a); })()""")
        check(k[3] >= 44 and not ov, f'kind pill 44 px tall, not over Snap or the angle ({k}, overlap {ov})')
        await touch('touchStart', [(k[0], k[1])]); await page.wait_for_timeout(60); await touch('touchEnd', []); await page.wait_for_timeout(400)
        r2 = await page.evaluate(R)
        check(r2['k'] == 'g' and r2['geo'], f'tap switches to the set square ({r2})')
        k2 = await page.evaluate(pill)
        check(abs(k2[0] - k[0]) < 2 and abs(k2[1] - k[1]) < 2, f'pill stays under the finger ({k[:2]} -> {k2[:2]})')
        check((await page.evaluate(LAST)) is None, 'tap drew nothing')
        face = await page.evaluate("(() => { const f = document.getElementById('geoFace'); return {hidden: getComputedStyle(f).display === 'none', lines: f.querySelectorAll('line').length, texts: [...f.querySelectorAll('text')].map(t => t.textContent)}; })()")
        check(not face['hidden'] and face['lines'] > 200 and '90' in face['texts'] and '3' in face['texts'], f'scales drawn ({face["lines"]} lines)')

        st = await page.evaluate("(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.left, b.top]; })()")
        cx, cy = st[0] + r2['cx'], st[1] + r2['cy']
        z = await page.evaluate("__inkwell.cam.z")
        async def pen(pts):
            await page.mouse.move(*pts[0]); await page.mouse.down()
            for x, y in pts[1:]: await page.mouse.move(x, y)
            await page.mouse.up(); await page.wait_for_timeout(250)
            return await page.evaluate(LAST)
        # long edge: a wobbly line just below it comes out straight on the edge
        s = await pen([(cx - 150 + i * 10, cy + 6 + (i % 3) * 4) for i in range(31)])
        ok = s and max(s['ys']) - min(s['ys']) < 0.5
        check(ok, f'long edge: wobbly line drawn straight ({s and (min(s["ys"]), max(s["ys"]))})')
        # right leg (from (H,0) to (0,-H)): points just outside it, moving up-left
        pts = []
        for i in range(25):
            t = 60 + i * 8
            x, y = 300 - t / math.sqrt(2), -t / math.sqrt(2)
            o = 8 + (i % 2) * 5
            pts.append((cx + x + o / math.sqrt(2), cy + y - o / math.sqrt(2)))
        s = await pen(pts)
        if s:
            # all points on one 45 deg line: x - y constant (world coords, angle 0, any zoom)
            v = [x - y for x, y in zip(s['xs'], s['ys'])]
            check(max(v) - min(v) < 0.6 and len(v) > 10, f'right leg: line follows the 45 deg edge (spread {max(v) - min(v):.2f})')
        else: check(False, 'right leg drew a stroke')
        pts = [(cx - 300 + t / math.sqrt(2) - 10, cy - t / math.sqrt(2) - 3 * (i % 2)) for i, t in enumerate(range(60, 260, 8))]
        s = await pen(pts)
        if s:
            v = [x + y for x, y in zip(s['xs'], s['ys'])]
            check(max(v) - min(v) < 0.6, f'left leg: line follows the edge (spread {max(v) - min(v):.2f})')
        else: check(False, 'left leg drew a stroke')
        # far from every edge, outside the triangle: normal handwriting (not straightened)
        s = await pen([(cx - 400 + i * 6, cy - 250 + (i % 4) * 6) for i in range(20)])
        check(s and max(s['ys']) - min(s['ys']) > 10, 'away from the set square the pen writes freely')

        # one finger inside the triangle moves it
        before = await page.evaluate(R)
        await touch('touchStart', [(cx, cy - 40)])
        for i in range(1, 11): await touch('touchMove', [(cx + 4 * i, cy - 40)]); await page.wait_for_timeout(16)
        await touch('touchEnd', []); await page.wait_for_timeout(300)
        after = await page.evaluate(R)
        check(abs(after['cx'] - before['cx'] - 40) < 2, f'finger drag moves it ({after["cx"] - before["cx"]:.1f})')

        await page.reload(); await boot(page)
        r3 = await page.evaluate(R)
        check(r3['k'] == 'g' and r3['geo'], f'still a set square after reload ({r3})')
        if os.environ.get('SNAP_SHOT'): await page.screenshot(path=os.environ['SNAP_SHOT'])
        await page.click('#rulerKind'); await page.wait_for_timeout(300)
        r4 = await page.evaluate(R)
        check(r4['k'] is None and not r4['geo'], f'click switches back to the ruler ({r4})')
        check(not errs, f'no page errors ({errs[:2]})')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
