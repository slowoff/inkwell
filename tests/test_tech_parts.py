# 2.0 stage 3: robotics symbols (Shapes menu, technical notebooks only) and a parts list that keeps itself up to date.
import asyncio, os, re
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
MM = 96 / 25.4
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SYMS = "[...__inkwell.cur.items.values()].filter(i => i.sym).map(i => ({id: i.id, sym: i.sym, g: i.g}))"
PL = "[...__inkwell.cur.items.values()].filter(i => i.pl).map(i => i.html.replace(/<[^>]+>/g, '|').replace(/\\|+/g, '|'))"

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
        await page.evaluate("document.getElementById('shapeRail').click()"); await page.wait_for_timeout(200)
        check(await page.evaluate("document.querySelector('#shapePop .sym-panel').hidden"), 'normal notebook: no robotics parts in Shapes')
        await page.evaluate("closePops()")
        await page.evaluate("""() => { const W = __inkwell, pg = W.docs.get(W.cur.id), s = W.docs.get(pg.data.sec); W.docs.get(s.data.nb).data.tech = true;
            W.prefs.techSnap = 0; W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.invalidate(); }""")
        await page.evaluate("document.getElementById('shapeRail').click()"); await page.wait_for_timeout(200)
        n = await page.evaluate("document.querySelector('#shapePop .sym-panel').hidden ? -1 : document.querySelectorAll('#symGrid [data-sym]').length")
        check(n == 14, f'technical notebook: 14 symbols in Shapes ({n})')
        names = await page.evaluate("[...document.querySelectorAll('#symGrid [data-sym]')].map(b => b.dataset.sym).join(',')")
        check(all(k in names for k in ['gear', 'wheel', 'bearing', 'pivot', 'horn', 'shaft', 'motor', 'servo', 'battery', 'switch', 'led', 'resistor', 'sensor', 'board']), 'mechanical and electronic parts')
        await page.evaluate("document.querySelector('#symGrid [data-sym=\"servo\"]').click()"); await page.wait_for_timeout(100)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        await page.mouse.click(st[0] + 200, st[1] + 200); await page.wait_for_timeout(300)
        s = await page.evaluate(SYMS)
        check(len(s) == 1 and s[0]['sym'] == 'servo', f'servo placed with a tap ({s})')
        grp = await page.evaluate(f"[...__inkwell.cur.items.values()].filter(i => i.g === '{s[0]['g']}').length")
        check(grp >= 5, f'symbol is one group of strokes ({grp})')
        # gear dragged into a 60 mm box: scaled to fit
        await page.evaluate("__inkwell.setTool('pen'); __inkwell.startPick({kind: 'shape', shape: 'sym:gear'})")
        x0, y0 = 330, 120
        await page.mouse.move(st[0] + x0, st[1] + y0); await page.mouse.down(); await page.mouse.move(st[0] + x0 + 60 * MM, st[1] + y0 + 60 * MM, steps=6); await page.mouse.up(); await page.wait_for_timeout(300)
        gid = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.sym === 'gear').g")
        w = await page.evaluate(f"(() => {{ let a = Infinity, z = -Infinity; for(const i of __inkwell.cur.items.values()) if(i.g === '{gid}') for(let k = 0; k < i.p.length; k += 3){{ a = Math.min(a, i.p[k]); z = Math.max(z, i.p[k]); }} return (z - a) / (96 / 25.4); }})()")
        check(abs(w - 60) < 1.5, f'gear fits the 60 mm box ({w:.1f} mm)')
        # parts list
        await page.evaluate("__inkwell.setTool('pen'); __inkwell.startPick({kind: 'shape', shape: 'parts'})")
        await page.mouse.click(st[0] + 450, st[1] + 330); await page.wait_for_timeout(300)
        pl = await page.evaluate(PL)
        check(len(pl) == 1 and '1 × Gear' in pl[0] and '1 × Servo' in pl[0], f'parts list counts what is on the page ({pl})')
        await page.evaluate("__inkwell.setTool('pen'); __inkwell.startPick({kind: 'shape', shape: 'sym:servo'})")
        await page.mouse.click(st[0] + 200, st[1] + 450); await page.wait_for_timeout(300)
        pl = await page.evaluate(PL)
        check(pl and '2 × Servo' in pl[0], f'another servo: list updates by itself ({pl})')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(200)
        pl = await page.evaluate(PL)
        check(pl and '1 × Servo' in pl[0], f'undo takes the servo and the count back together ({pl})')
        ids = await page.evaluate(f"[...__inkwell.cur.items.values()].filter(i => i.g === '{gid}').map(i => i.id)")
        await page.evaluate(f"__inkwell.removeItems({ids})"); await page.wait_for_timeout(200)
        pl = await page.evaluate(PL)
        check(pl and 'Gear' not in pl[0] and '1 × Servo' in pl[0], f'deleting the gear removes it from the list ({pl})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
