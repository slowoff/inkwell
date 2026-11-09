# 1.93.1: a pale highlighter colour (e.g. a light lemon yellow from the colour picker) drew dark grey: inkColor swapped
# any very light colour (brightness > 0.93) for dark ink, a rule meant for white pen ink on white paper. Highlighters
# now keep their colour (finished stroke, while drawing, PDF export); white pen ink is still swapped.
import asyncio, os, io
from playwright.async_api import async_playwright
from PIL import Image
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
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage(); W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.invalidate();
          W.prefs.hl.c = '#FFF96B'; W.prefs.hl.s = 60; W.setTool('hl'); }""")
        await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.x, r.y]; })()")
        cdp = await ctx.new_cdp_session(page)
        x0, y = 120, 200
        await cdp.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': st[0] + x0, 'y': st[1] + y, 'button': 'left', 'clickCount': 1, 'pointerType': 'pen', 'force': 0.5})
        for i in range(1, 30):
            await cdp.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': st[0] + x0 + i * 8, 'y': st[1] + y, 'button': 'left', 'buttons': 1, 'pointerType': 'pen', 'force': 0.5})
        await page.wait_for_timeout(150)
        live = Image.open(io.BytesIO(await page.screenshot())).convert('RGB').getpixel((int(st[0] + x0 + 100), int(st[1] + y)))
        await cdp.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': st[0] + x0 + 232, 'y': st[1] + y, 'button': 'left', 'clickCount': 1, 'pointerType': 'pen'})
        await page.wait_for_timeout(500)
        done = Image.open(io.BytesIO(await page.screenshot())).convert('RGB').getpixel((int(st[0] + x0 + 100), int(st[1] + y)))
        yellow = lambda c: c[0] > 200 and c[1] > 200 and c[2] < c[0] - 40
        exact = lambda c: abs(c[0] - 255) <= 4 and abs(c[1] - 249) <= 5 and abs(c[2] - 107) <= 8
        check(yellow(live), f'pale yellow highlighter is yellow while drawing {live}')
        check(yellow(done), f'pale yellow highlighter is yellow when finished {done}')
        check(exact(live) and exact(done), f'(1.94) it is the exact colour picked, #FFF96B (live {live}, finished {done})')
        it = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 's')")
        check(it and it['c'] == '#FFF96B' and it['hl'], 'stroke keeps the colour')
        # white pen ink is still shown dark on white paper
        await page.evaluate("""() => { const W = __inkwell; const p = []; for(let i = 0; i < 30; i++) p.push(120 + i * 8, 400, .5);
          W.addItems([{t: 's', id: 'wp', c: '#FFFFFF', w: 8, hl: 0, p}]); W.invalidate(); }""")
        await page.wait_for_timeout(500)
        wp = Image.open(io.BytesIO(await page.screenshot())).convert('RGB').getpixel((int(st[0] + 220), int(st[1] + 400)))
        check(max(wp) < 90, f'white pen ink still shows dark on white paper {wp}')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)
asyncio.run(main())
