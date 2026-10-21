# 1.58.3: imported pages/pictures are laid out at the settled zoom (no big stretched layer, which iPad Safari turns
# blocky above ~300 %). Geometry must be right while zooming and after settling; PDF fill-in fields stay in place.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

GEO = """() => { const W = __inkwell, it = W.cur.items.get('ipg'), el = document.querySelector('[data-id=ipg]'), st = document.getElementById('stage').getBoundingClientRect();
  const r = el.getBoundingClientRect(), f = document.querySelector('textarea.pf-tx').getBoundingClientRect(), z = W.cam.z;
  const want = [st.left + it.x * z + W.cam.ox, st.top + it.y * z + W.cam.oy, it.w * z, it.h * z];
  const fw = [want[0] + it.f[0].x * it.w * z, want[1] + it.f[0].y * it.h * z, it.f[0].w * it.w * z];
  return {z, r: [r.left, r.top, r.width, r.height], want, f: [f.left, f.top, f.width], fw, layer: document.getElementById('worldBack').style.transform, sw: el.style.width}; }"""

def close(a, b, tol=1.0): return all(abs(x - y) <= tol for x, y in zip(a, b))

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
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        await page.evaluate("""async () => {
          const cv = document.createElement('canvas'); cv.width = 800; cv.height = 1100; const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 800, 1100);
          g.strokeStyle = '#000'; for(let i = 0; i < 20; i++){ g.beginPath(); g.moveTo(50, 50 + i * 50); g.lineTo(750, 50 + i * 50); g.stroke(); }
          const a = await __inkwell.saveAsset(await new Promise(r => cv.toBlob(r, 'image/png')));
          __inkwell.addItems([{t: 'i', id: 'ipg', x: 40, y: 30, w: 600, h: 825, a, doc: 1, f: [{k: 'tx', ml: 1, x: 0.2, y: 0.3, w: 0.4, h: 0.08, v: 'Feld'}]}]);
        }""")
        await page.wait_for_timeout(1500)
        g = await page.evaluate(GEO)
        check(close(g['r'], g['want']) and close(g['f'], g['fw']), f'100 %: page and its field where they belong ({g})')
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        await page.mouse.move(st[0], st[1])
        for _ in range(28):
            await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control')
        g = await page.evaluate(GEO)
        check(g['z'] > 2.9, f'zoomed to {g["z"]:.2f}')
        check(close(g['r'], g['want'], 1.5) and close(g['f'], g['fw'], 1.5), f'right while still zooming ({g["r"]} vs {g["want"]})')
        await page.wait_for_timeout(400)
        g = await page.evaluate(GEO)
        check('scale' not in g['layer'], f'after the zoom settles the page layer is not stretched ({g["layer"]})')
        check(abs(float(g['sw'][:-2]) - 600 * g['z']) < 0.5, f'the page is laid out at its on-screen size ({g["sw"]})')
        check(close(g['r'], g['want']) and close(g['f'], g['fw'], 1.5), f'settled: page and field still in place ({g["r"]} vs {g["want"]}; {g["f"]} vs {g["fw"]})')
        # pan after settling: still in place
        await page.mouse.wheel(120, 80); await page.wait_for_timeout(300)
        g = await page.evaluate(GEO)
        check(close(g['r'], g['want']) and close(g['f'], g['fw'], 1.5), 'after panning: in place')
        # the field still works when zoomed
        await page.mouse.click(g['f'][0] + g['f'][2] / 2, g['f'][1] + 10); await page.wait_for_timeout(200)
        await page.keyboard.press('End'); await page.keyboard.type(' 2'); await page.wait_for_timeout(200)
        v = await page.evaluate("__inkwell.cur.items.get('ipg').f[0].v")
        check(v == 'Feld 2', f'typing in the field when zoomed ({v!r})')
        fs = await page.evaluate("[getComputedStyle(document.querySelector('textarea.pf-tx')).fontSize, document.querySelector('textarea.pf-tx').getBoundingClientRect().height / __inkwell.cam.z]")
        check(abs(fs[1] - 0.08 * 825) < 1, f'field keeps its size on the page ({fs})')
        await page.keyboard.press('Escape')
        # zoom back out, then a new page keeps working
        await page.mouse.move(st[0], st[1])
        for _ in range(40):
            await page.keyboard.down('Control'); await page.mouse.wheel(0, 100); await page.keyboard.up('Control')
        await page.wait_for_timeout(400)
        g = await page.evaluate(GEO)
        check(close(g['r'], g['want']) and close(g['f'], g['fw'], 1.5), f'zoomed out ({g["z"]:.2f}): in place')
        # reopen the page at the settled zoom: elements made fresh are placed right too
        pid = await page.evaluate("__inkwell.cur.id || __inkwell.cur.page || null")
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur && document.querySelector("[data-id=ipg]")', timeout=15000)
        await page.wait_for_timeout(800)
        g = await page.evaluate(GEO)
        check(close(g['r'], g['want']) and close(g['f'], g['fw'], 1.5), f'after a reload ({g["z"]:.2f}): in place')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
