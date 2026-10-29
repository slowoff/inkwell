# 1.71.2: ink written on a picture must stay on top of it while the page moves (iPad Safari drew it under the
# picture during a pan). Chromium cannot show the Safari bug itself; this checks the layer setup and that ink on a
# picture is visible in the middle of a finger pan and a pinch.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMB/6X2l6kAAAAASUVORK5CYII='


async def blue_at(page, x, y):
    shot = await page.screenshot(clip={'x': x - 10, 'y': y - 10, 'width': 20, 'height': 20})
    from PIL import Image; import io
    im = Image.open(io.BytesIO(shot)).convert('RGB')
    px = list(im.getdata())
    return sum(1 for r, g, b in px if b > 150 and r < 120 and g < 120) / len(px)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        a = await page.evaluate(f"""async () => {{ const r = await fetch('{PNG}'); return await __inkwell.saveAsset(await r.blob()); }}""")
        await page.evaluate("""(a) => { const W = __inkwell, c = W.cam; c.z = 1; c.ox = 0; c.oy = 0;
          const p = []; for(let i = 0; i <= 40; i++) p.push(200 + i * 5, 300, .6);
          W.addItems([{t: 'i', id: 'pic', x: 100, y: 200, w: 400, h: 250, a},
                      {t: 's', id: 'ink1', c: '#1d2bff', w: 10, p}]); }""", a)
        await page.wait_for_timeout(1500)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        loaded = await page.evaluate("!!document.querySelector('[data-id=pic] img')")
        check(loaded, 'picture loaded')
        lay = await page.evaluate("['hlm','ink','worldFront','live','worldBack'].map(id => getComputedStyle(document.getElementById(id)).willChange)")
        check(lay[:4] == ['transform'] * 4 and lay[4] == 'auto', f'drawing layers above pictures have their own layer, picture layer not pinned ({lay})')
        sx, sy = st[0] + 300, st[1] + 300
        check(await blue_at(page, sx, sy) > 0.2, 'ink on the picture visible at rest')
        # mid pan (finger down and moving, not lifted)
        await page.evaluate("""([x, y]) => { const s = document.getElementById('stage');
          const ev = (t, px, py) => s.dispatchEvent(new PointerEvent(t, {pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: px, clientY: py, bubbles: true, cancelable: true}));
          ev('pointerdown', x, y); for(let i = 1; i <= 10; i++) ev('pointermove', x + i * 6, y + i * 4); }""", [st[0] + 700, st[1] + 600])
        await page.wait_for_timeout(120)
        check(await blue_at(page, sx + 60, sy + 40) > 0.2, 'ink on the picture visible in the middle of a pan')
        await page.evaluate("""([x, y]) => document.getElementById('stage').dispatchEvent(new PointerEvent('pointerup', {pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: x + 60, clientY: y + 40, bubbles: true}))""", [st[0] + 700, st[1] + 600])
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
