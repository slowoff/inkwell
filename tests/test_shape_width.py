# 1.73.4: shapes and hold-to-straighten lines are as thick as the Pencil's own writing at the same pen size.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
LAST = """() => { const s = [...__inkwell.cur.items.values()].filter(i => i.t === 's').pop(), a = [];
  for(let i = 2; i < s.p.length; i += 3) a.push(s.p[i]); a.sort((x, y) => x - y); return {w: s.w, pr: a[a.length >> 1], n: a.length}; }"""
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
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.prefs.wheel = 'off'; delete __inkwell.prefs.penPr; __inkwell.setTool('pen'); }")
        await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        cdp = await ctx.new_cdp_session(page)
        async def pen(t, x, y, f):
            await cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': st[0] + x, 'y': st[1] + y, 'button': 'left', 'buttons': 1 if t != 'mouseReleased' else 0, 'clickCount': 1, 'pointerType': 'pen', 'force': f})
        async def wave(y, f, hold=0):
            await pen('mousePressed', 100, y, f)
            for i in range(1, 30):
                await pen('mouseMoved', 100 + i * 8, y + (0 if hold else 12 * math.sin(i / 2)), f); await page.wait_for_timeout(5)
            if hold: await page.wait_for_timeout(hold)
            await pen('mouseReleased', 100 + 29 * 8, y, f); await page.wait_for_timeout(120)
        check(await page.evaluate('__inkwell.shapePr()') == 0.55, 'no Pencil used yet: shapes as before')
        async def shape(kind):
            await page.click('#shapeBtn'); await page.wait_for_selector('#shapeGrid', state='visible')
            await page.click(f'#shapeGrid button[data-shape="{kind}"]'); await page.wait_for_timeout(150)
            await page.mouse.move(st[0] + 500, st[1] + 300); await page.mouse.down()
            await page.mouse.move(st[0] + 700, st[1] + 450, steps=5); await page.mouse.up(); await page.wait_for_timeout(200)
        await page.evaluate("__inkwell.prefs.snapHold = 0")
        await wave(100, 0.2)
        ink = await page.evaluate(LAST)
        await shape('rect')
        sh = await page.evaluate(LAST)
        check(abs(sh['pr'] - ink['pr']) < 0.02 and sh['w'] == ink['w'], f'rectangle as thick as light writing (ink {ink}, shape {sh})')
        await page.evaluate("__inkwell.setTool('pen')")
        for _ in range(8): await wave(200, 0.7)
        check(abs(await page.evaluate('__inkwell.shapePr()') - 0.7) < 0.08, 'follows a harder touch')
        await page.evaluate("__inkwell.prefs.snapHold = 300")
        await wave(500, 0.3, hold=700)
        ln = await page.evaluate(LAST)
        check(abs(ln['pr'] - 0.3) < 0.02, f'held line keeps its own stroke thickness ({ln})')
        await page.evaluate("__inkwell.flushSaves()"); await page.wait_for_timeout(400)
        before = await page.evaluate('__inkwell.shapePr()')
        await page.reload(); await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        check(abs(await page.evaluate('__inkwell.shapePr()') - before) < 1e-6, 'remembered after reload')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('FAILED' if fails else 'all ok'); raise SystemExit(1 if fails else 0)
asyncio.run(main())
