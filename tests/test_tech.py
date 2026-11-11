# 2.0 stage 1: technical notebooks. Switch in the notebook's edit form; line types for the pen and shapes; shapes and
# held lines snap onto the mm grid and onto ends / corners of what is there; the exact shape is remembered (it.geo) and
# follows moves; dashed lines are drawn as dashes; pages in other notebooks are unchanged.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
MM = 96 / 25.4
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

STROKES = "[...__inkwell.cur.items.values()].filter(i => i.t === 's').map(i => ({id: i.id, ls: i.ls || '', w: i.w, geo: i.geo || null, n: i.p.length / 3, a: [i.p[0], i.p[1]], b: [i.p[i.p.length-3], i.p[i.p.length-2]]}))"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500); await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); }"); await page.wait_for_timeout(300)
        check(await page.evaluate("document.getElementById('techBtn').hidden"), 'normal notebook: no line type button')
        # switch the notebook to technical in its edit form
        nb = await page.evaluate("(() => { const W = __inkwell, pg = W.docs.get(W.cur.id), s = W.docs.get(pg.data.sec); return s.data.nb; })()")
        await page.evaluate(f"document.querySelector('[data-nb=\"{nb}\"]') || null")
        opened = await page.evaluate(f"""(() => {{ const b = document.querySelector('[data-editnb="{nb}"]'); if(!b) return false; b.click(); return true; }})()""")
        check(opened, 'notebook edit button found')
        await page.wait_for_timeout(200)
        has = await page.evaluate("!!document.querySelector('.edit-form [data-tech]')")
        check(has, 'edit form has the Technical notebook switch')
        await page.evaluate("document.querySelector('.edit-form [data-tech]').click(); document.querySelector('.edit-form button[type=submit]').click()"); await page.wait_for_timeout(400)
        check(await page.evaluate(f"__inkwell.docs.get('{nb}').data.tech === true"), 'Technical notebook switch saves on the notebook')
        check(await page.evaluate(f"!!document.querySelector('[data-nb=\"{nb}\"] .nb-tech')"), 'notebook shows the technical mark')
        check(not await page.evaluate("document.getElementById('techBtn').hidden"), 'technical page: line type button shown for the pen')
        await page.evaluate("__inkwell.setTool('hl')")
        check(await page.evaluate("document.getElementById('techBtn').hidden"), 'not shown for the highlighter')
        await page.evaluate("__inkwell.setTool('pen')")
        # popover: pick Thick and 5 mm
        await page.evaluate("document.getElementById('techBtn').click()"); await page.wait_for_timeout(200)
        n_ls = await page.evaluate("document.querySelectorAll('#techLs [data-ls]').length")
        check(n_ls == 5, f'five line types offered ({n_ls})')
        await page.evaluate("document.querySelector('#techLs [data-ls=\"k\"]').click()"); await page.wait_for_timeout(100)
        await page.evaluate("document.getElementById('techBtn').click(); document.querySelector('#techSnap [data-step=\"5\"]').click(); closePops()")
        check(await page.evaluate("__inkwell.prefs.techLs === 'k' && __inkwell.prefs.techSnap === 5"), 'Thick and 5 mm chosen')
        await page.evaluate("() => { const W = __inkwell; W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.invalidate(); }")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        async def drag(pts, hold_at=None):
            await page.mouse.move(st[0] + pts[0][0], st[1] + pts[0][1]); await page.mouse.down()
            for i, (x, y) in enumerate(pts[1:], 1):
                await page.mouse.move(st[0] + x, st[1] + y, steps=8)
                if hold_at == i: await page.wait_for_timeout(900)
            await page.mouse.up(); await page.wait_for_timeout(300)
        # freehand thick line: constant width, ls k, not handwriting
        await drag([(100, 400), (160, 420), (220, 405)])
        s = await page.evaluate(STROKES)
        check(len(s) == 1 and s[0]['ls'] == 'k' and abs(s[0]['w'] - 0.7 * MM) < 0.01, f'pen stroke is a thick technical line ({s})')
        # Line shape, snapped to the 5 mm grid at both ends
        await page.evaluate("__inkwell.startPick({kind: 'shape', shape: 'line'})")
        await drag([(101, 100), (150, 101), (198.6, 101.5)])
        s = await page.evaluate(STROKES); ln = [x for x in s if x['geo'] and x['geo']['k'] == 'l']
        check(len(ln) == 1, f'line shape remembers its exact line ({len(ln)})')
        if ln:
            v = ln[0]['geo']['v']; step = 5 * MM
            on = all(abs(c / step - round(c / step)) < 1e-6 for c in v)
            check(on, f'both ends on the 5 mm grid ({[round(c / MM, 2) for c in v]} mm)')
            check(ln[0]['ls'] == 'k', 'shape uses the chosen line type')
        # rectangle, then a line starting near its corner snaps exactly onto the corner
        await page.evaluate("__inkwell.setTool('pen'); __inkwell.startPick({kind: 'shape', shape: 'rect'})")
        await drag([(300, 200), (360, 240), (420.4, 271)])
        s = await page.evaluate(STROKES); rc = [x for x in s if x['geo'] and x['geo']['k'] == 'r']
        check(len(rc) == 1, 'rectangle remembers its exact shape')
        if rc:
            L, T, R, B = rc[0]['geo']['v']
            await page.evaluate("__inkwell.setTool('pen'); __inkwell.prefs.techSnap = 0; __inkwell.startPick({kind: 'shape', shape: 'line'})")
            await drag([(R + 4, B - 3), (R + 60, B + 40), (R + 100, B + 80)])
            s2 = await page.evaluate(STROKES); new = [x for x in s2 if x['id'] not in {y['id'] for y in s}]
            ok = new and new[0]['geo'] and abs(new[0]['geo']['v'][0] - R) < 1e-6 and abs(new[0]['geo']['v'][1] - B) < 1e-6
            check(bool(ok), f'line snaps onto the rectangle corner ({new[0]["geo"]["v"][:2] if new and new[0]["geo"] else new} vs {[R, B]})')
            await page.evaluate("__inkwell.prefs.techSnap = 5")
        # held pen line becomes a line (with geo), its end lands on whole 5 mm lengths
        await page.evaluate("__inkwell.setTool('pen'); __inkwell.prefs.techLs = 'h'; __inkwell.prefs.snapHold = 400")
        before = {x['id'] for x in await page.evaluate(STROKES)}
        await drag([(100, 600), (200, 601), (260, 602), (261, 602), (330, 640)], hold_at=3)
        s = await page.evaluate(STROKES); new = [x for x in s if x['id'] not in before]
        check(len(new) == 1 and new[0]['geo'] and new[0]['geo']['k'] == 'l' and new[0]['ls'] == 'h', f'held pen stroke became a hidden (dashed) line with its exact shape ({new})')
        if new and new[0]['geo']:
            v = new[0]['geo']['v']; L_ = math.hypot(v[2] - v[0], v[3] - v[1]) / MM
            check(abs(L_ / 5 - round(L_ / 5)) < 1e-6, f'its length is whole 5 mm steps ({L_:.3f} mm)')
            dashes = await page.evaluate(f"(__inkwell.HLS && 1, (() => {{ const it = __inkwell.cur.items.get('{new[0]['id']}'); const d = InkGeo.strokePath(it, true); return (d.match(/M/g) || []).length; }})())")
            check(dashes >= 4, f'drawn as separate dashes ({dashes})')
        # moving keeps the exact shape in step
        lid = ln[0]['id'] if ln else None
        if lid:
            await page.evaluate(f"() => {{ const W = __inkwell; W.selectIds(['{lid}']); }}")
            moved = await page.evaluate(f"""(() => {{ const W = __inkwell, it = W.cur.items.get('{lid}'); const o = transformItem(it, {{ax: 0, ay: 0, s: 1.5, dx: 20, dy: 10}}); return [Tech.geoOf(o) ? 1 : 0, o.geo.v, [o.p[0], o.p[1]]]; }})()""")
            check(moved[0] == 1 and abs(moved[1][0] - moved[2][0]) < 1e-6, f'moved / resized line keeps a valid exact shape ({moved})')
            cut = await page.evaluate(f"""(() => {{ const it = __inkwell.cur.items.get('{lid}'); const o = Object.assign({{}}, it, {{p: it.p.slice(0, 9)}}); return Tech.geoOf(o) ? 1 : 0; }})()""")
            check(cut == 0, 'a cut piece of the line no longer claims the exact shape')
        # live size label while dragging a line
        await page.evaluate("__inkwell.startPick({kind: 'shape', shape: 'line'})")
        await page.mouse.move(st[0] + 500, st[1] + 500); await page.mouse.down(); await page.mouse.move(st[0] + 600, st[1] + 500, steps=6)
        lab = await page.evaluate("(() => { let t = ''; const o = Tech.label; Tech.label = (x, ...r) => { t = x; return o.call(Tech, x, ...r); }; drawLive(); Tech.label = o; return t; })()")
        await page.mouse.up(); await page.wait_for_timeout(200)
        check(lab.endswith('mm · 0°'), f'size shown while drawing ({lab!r})')
        # another notebook's page is unchanged
        await page.evaluate("""async () => { const W = __inkwell; document.getElementById('addNb').click(); await new Promise(r => setTimeout(r, 300)); document.querySelector('.edit-form button[type=submit]').click(); await new Promise(r => setTimeout(r, 200)); await W.newPage(); W.setTool('pen'); }""")
        await page.wait_for_timeout(300)
        check(await page.evaluate("document.getElementById('techBtn').hidden && !Tech.on()"), 'pages in other notebooks: normal pen, no technical tools')
        await drag([(100, 300), (160, 320), (220, 305)])
        s = await page.evaluate(STROKES)
        check(len(s) == 1 and not s[0]['ls'] and not s[0]['geo'], f'normal stroke there ({s})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
