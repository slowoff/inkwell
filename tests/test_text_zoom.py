# 1.59.2: typed text and formulas are zoomed with CSS zoom (laid out at their on-screen size) instead of a
# transform scale, so iPad Safari cannot paint them at 1x and stretch them (blurry text with the pen tool).
# Checks that every item still sits exactly where the world camera puts it, and measurements stay in world units.
import asyncio, os
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
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          await W.newPage(); await new Promise(r => setTimeout(r, 300));
          W.addItems([{t: 'x', id: 'xa', x: 120, y: 80, w: 300, fs: 1, html: '<p>Hello world, typed text</p>'},
                      {t: 'm', id: 'ma', x: 140, y: 200, tex: '\\\\frac{a}{b}+c', fs: 30, c: 'auto'}]);
          const out = [];
          for(const z of [1, 3.11, 0.5]){
            W.cam.z = z; W.cam.ox = 37; W.cam.oy = -15; W.invalidate();
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const st = document.getElementById('stage').getBoundingClientRect();
            for(const id of ['xa', 'ma']){
              const el = document.querySelector(`#worldFront [data-id="${id}"]`), it = W.cur.items.get(id);
              const rc = el.getBoundingClientRect();
              out.push({z, id, dx: rc.left - st.left - (37 + it.x * z), dy: rc.top - st.top - (-15 + it.y * z),
                        rw: rc.width / el.offsetWidth, ow: el.offsetWidth, tf: getComputedStyle(el).transform, zoom: el.style.zoom});
            }
          }
          return out;
        }""")
        for o in r:
            check(abs(o['dx']) < 1.5 and abs(o['dy']) < 1.5, f"{o['id']} at zoom {o['z']} in place (off by {o['dx']:.2f}, {o['dy']:.2f})")
            check(abs(o['rw'] - o['z']) < 0.02, f"{o['id']} at zoom {o['z']} drawn {o['rw']:.3f}x its world width")
            check(o['tf'] in ('none', ''), f"{o['id']} at zoom {o['z']} has no transform ({o['tf']})")
        w1 = [o['ow'] for o in r if o['id'] == 'xa']
        check(max(w1) - min(w1) < 1, f'text box width stays in world units at every zoom ({w1})')
        # editing at 311 %: the box handles sit beside the box
        r2 = await page.evaluate("""async () => {
          const W = __inkwell;
          W.cam.z = 3.11; W.cam.ox = 10; W.cam.oy = 10; W.invalidate();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          W.setTool('text');
          const el = document.querySelector('#worldFront [data-id="xa"]');
          const rc = el.getBoundingClientRect();
          return {x: rc.left + 20, y: rc.top + rc.height / 2};
        }""")
        await page.mouse.click(r2['x'], r2['y']); await page.wait_for_timeout(500)
        r3 = await page.evaluate("""() => {
          const el = document.querySelector('#worldFront [data-id="xa"]'), rc = el.getBoundingClientRect();
          const h = document.getElementById('tHandle').getBoundingClientRect(), m = document.getElementById('tMove').getBoundingClientRect();
          return {edit: el.isContentEditable || !!el.querySelector('[contenteditable=true]'), hx: h.left - rc.right, hy: (h.top + h.bottom) / 2 - rc.top, mx: rc.left - m.right, bh: rc.height, hv: h.width > 0, mv: m.width > 0};
        }""")
        check(r3['edit'], 'text box opens for typing at 311 %')
        check(r3['hv'] and abs(r3['hx']) < 40 and -5 < r3['hy'] < r3['bh'] + 40, f'width handle beside the box ({r3["hx"]:.1f}, {r3["hy"]:.1f})')
        check(r3['mv'] and -5 < r3['mx'] < 60, f'move hand left of the box ({r3["mx"]:.1f})')
        await page.keyboard.press('End'); await page.keyboard.type(' more')
        await page.mouse.click(5, 700); await page.wait_for_timeout(500)
        html = await page.evaluate("__inkwell.cur.items.get('xa').html")
        check('more' in html, 'typing at 311 % is saved')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
