# 1.40: graph Look options (size, colours, curve width/style, grid fade, whole-graph fade, arrow tips, live preview)
# and Fade for any selection (optional item field o). Guest mode.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def set_range(page, sel, v):
    await page.evaluate("([s, v]) => { const r = document.querySelector(s); r.value = v; r.dispatchEvent(new Event('input', {bubbles: true})); r.dispatchEvent(new Event('change', {bubbles: true})); }", [sel, v])

# (1.57) graphs have a solid background: count drawn pixels that differ from the most common (background) colour
PREVIEW_INK = """() => { const c = document.getElementById('gPrev'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const cnt = new Map(); for(let i = 0; i < d.length; i += 4){ if(!d[i+3]) continue; const k = d[i] + ',' + d[i+1] + ',' + d[i+2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
  let bg = null, m = 0; for(const [k, v] of cnt) if(v > m){ m = v; bg = k; }
  let n = 0; for(let i = 0; i < d.length; i += 4){ if(!d[i+3]) continue; if(d[i] + ',' + d[i+1] + ',' + d[i+2] !== bg) n++; } return n; }"""

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

        # 1. default graph (no look changes) = the look from before: no fade on axes, arrows present
        await page.click('#shapeBtn'); await page.click('#graphOpen')
        await page.wait_for_selector('#graphDlg', state='visible'); await page.wait_for_timeout(200)
        n0 = await page.evaluate(PREVIEW_INK)
        check(n0 > 500, f'preview shows the graph ({n0} px)')
        await page.check('#gGrid')
        await page.wait_for_timeout(100)
        n1 = await page.evaluate(PREVIEW_INK)
        check(n1 > n0, f'preview updates when grid is switched on ({n0} -> {n1})')
        await page.click('#gInsert'); await page.wait_for_timeout(300)
        d = await page.evaluate("""() => { const its = [...__inkwell.cur.items.values()];
          const grid = its.filter(i => i.t === 's' && i.c === '#8A97A4'), axes = its.filter(i => i.t === 's' && i.c === 'auto');
          return {n: its.length, gridO: grid.map(i => i.o), axesO: axes.filter(i => i.o).length, axes: axes.length}; }""")
        check(d['axesO'] == 0, 'default axes are not faded')
        check(d['gridO'] and all(abs(o - 0.5) < 0.01 for o in d['gridO']), f"grid lines half faded by default ({set(d['gridO'])})")
        base_axes = d['axes']
        await page.evaluate("__inkwell.removeItems([...__inkwell.cur.items.keys()])")

        # 2. custom look
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(200)
        await page.click('#gSize button[data-v="1.4"]')
        await page.click('#gAxC [data-c="#8A97A4"]')
        await page.click('#gFnC [data-c="#C2362B"]')
        await page.click('#gFnW button[data-v="1.8"]')
        await page.click('#gFnS button[data-v="dash"]')
        await set_range(page, '#gGridO', 30)
        await set_range(page, '#gAllO', 60)
        await page.uncheck('#gArrows')
        await page.fill('#gFn', '0.1x^2')
        await page.wait_for_timeout(150)
        check(await page.evaluate("document.getElementById('gAllOv').textContent") == '60 %', 'fade value shown')
        check(await page.evaluate(PREVIEW_INK) > 300, 'preview still drawn with the custom look')
        await page.click('#gInsert'); await page.wait_for_timeout(300)
        d = await page.evaluate("""() => { const W = __inkwell, its = [...W.cur.items.values()];
          const grid = its.filter(i => i.t === 's' && i.c === '#8A97A4' && Math.abs(i.o - 0.18) < 0.001);
          const curve = its.filter(i => i.t === 's' && i.c === '#C2362B'), axes = its.filter(i => i.t === 's' && i.c === '#8A97A4' && !grid.includes(i));
          const m = its.filter(i => i.t === 'm');
          let x0 = 1e9, x1 = -1e9; for(const i of axes) for(let k = 0; k < i.p.length; k += 3){ x0 = Math.min(x0, i.p[k]); x1 = Math.max(x1, i.p[k]); }
          const el = document.querySelector('.it-math'); const g = new Set(its.map(i => i.g));
          return {curve: curve.length, curveO: [...new Set(curve.map(i => i.o))], gridO: [...new Set(grid.map(i => i.o))], axesO: [...new Set(axes.map(i => i.o))],
                  axes: axes.length, grid: grid.length, mc: [...new Set(m.map(i => i.c))], mo: [...new Set(m.map(i => i.o))], width: x1 - x0, elOp: el && el.style.opacity, groups: g.size,
                  sel: W.sel && W.sel.ids.length, n: its.length}; }""")
        check(d['curve'] > 6, f"dashed curve = many short strokes ({d['curve']})")
        check(d['curveO'] == [0.6] and d['axesO'] == [0.6], f"whole graph faded to 60 % ({d['curveO']}, {d['axesO']})")
        check(d['gridO'] == [0.18] and d['grid'] > 10, f"grid 30 % of 60 % ({d['gridO']}, {d['grid']} lines)")
        check(d['mc'] == ['#8A97A4'] and d['mo'] == [0.6], f"labels take the axes colour and fade ({d['mc']}, {d['mo']})")
        check(d['elOp'] == '0.6', f"formula element shown faded ({d['elOp']})")
        check(d['axes'] < base_axes, f"no arrow tips ({d['axes']} < {base_axes})")
        check(abs(d['width'] - (380 * 1.4 + 22 + 4)) < 2, f"Large = 1.4x wide ({d['width']:.0f})")
        check(d['groups'] == 1 and d['sel'] == d['n'], 'one group, selected after insert')

        # 3. Fade on the selection: one undo step, works on ink and formulas
        await page.click('#selFade'); await page.wait_for_selector('#fadePop', state='visible')
        check(await page.evaluate("document.getElementById('fadeRange').value") == '60', 'Fade slider starts at the current fade')
        for v in (50, 40, 30): await page.evaluate("v => { const r = document.getElementById('fadeRange'); r.value = v; r.dispatchEvent(new Event('input', {bubbles: true})); }", v)
        await page.evaluate("document.getElementById('fadeRange').dispatchEvent(new Event('change', {bubbles: true}))")
        d = await page.evaluate("() => { const its = [...__inkwell.cur.items.values()]; return {os: [...new Set(its.map(i => i.o))], u: __inkwell.cur.undo.length}; }")
        check(d['os'] == [0.3], f"everything at 30 % ({d['os']})")
        await page.keyboard.press('Escape')
        await page.click('#undo'); await page.wait_for_timeout(100)
        d2 = await page.evaluate("() => [...new Set([...__inkwell.cur.items.values()].map(i => i.o))].sort()")
        check(d2 == [0.18, 0.6], f'one Undo brings the old fade back ({d2})')
        await page.click('#redo')
        await page.evaluate("__inkwell.selectIds([...__inkwell.cur.items.keys()])")
        await page.click('#selFade'); await set_range(page, '#fadeRange', 100)
        d3 = await page.evaluate("() => [...__inkwell.cur.items.values()].filter(i => 'o' in i).length")
        check(d3 == 0, f'100 % removes the fade field ({d3} left)')

        # 4. saved, and the look is remembered
        await page.evaluate("async () => { const W = __inkwell; W.selectIds([...W.cur.items.keys()]); }")
        await page.click('#selFade'); await set_range(page, '#fadeRange', 45)
        await page.evaluate("__inkwell.flushSaves()")
        pid = await page.evaluate("__inkwell.cur.id")
        saved = await page.evaluate("async id => { const d = await __inkwell.IDB.get('docs', 'c_' + id); return [...new Set(d.data.items.map(i => i.o))]; }", pid)
        check(saved == [0.45], f'fade saved with the page ({saved})')
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("__inkwell.openPage(%r)" % pid); await page.wait_for_timeout(500)
        op = await page.evaluate("[...document.querySelectorAll('.it-math')].map(e => e.style.opacity)")
        check(op and all(o == '0.45' for o in op), f'fade still shown after reload ({set(op)})')
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(200)
        r = await page.evaluate("""() => ({size: document.querySelector('#gSize .on').dataset.v, fnS: document.querySelector('#gFnS .on').dataset.v, all: document.getElementById('gAllO').value, arrows: document.getElementById('gArrows').checked})""")
        check(r == {'size': '1.4', 'fnS': 'dash', 'all': '60', 'arrows': False}, f'look choices remembered ({r})')
        await page.keyboard.press('Escape')

        # 5. PDF file export with faded items does not fail
        await page.evaluate("document.querySelectorAll('.modal').forEach(m => m.hidden = true)")
        ok = await page.evaluate("""async () => { try { await __inkwell.exportPdfFile(); return !!(__inkwell.Pdf.file && __inkwell.Pdf.file.size > 1000); } catch(e){ return String(e); } }""")
        check(ok is True, f'PDF export with faded items ({ok})')
        check(not errs, 'no page errors: ' + '; '.join(errs[:3]))
        await b.close()
    if fails: raise SystemExit(1)
    print('ALL OK')
asyncio.run(main())
