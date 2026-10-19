# 1.38: Copy in the select tool's menu, Paste in the select tool's bar (and Ctrl/Cmd+C/X/V).
# Copies strokes (points kept), text, formulas and pictures (same asset id) with new ids and new group ids,
# to another page (centred in the view) or the same page (just beside the original). Guest mode.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

ITEMS = """[
  {t:'s', id:'s_a', c:'#C2362B', w:3, hl:0, p:[100,100,0.5, 140,120,0.6, 180,110,0.7], g:'g1'},
  {t:'m', id:'m_a', x:120, y:160, tex:'x^2', fs:1, c:'auto', g:'g1'},
  {t:'x', id:'x_a', x:100, y:220, w:200, fs:1, html:'<p>hello copy</p>'},
  {t:'i', id:'i_a', x:320, y:100, w:120, h:90, a:'asset-xyz'}
]"""

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
        src = await page.evaluate("async () => { const W = __inkwell; await W.newPage(); W.addItems(" + ITEMS + "); await W.flushSaves(); return W.cur.id; }")
        await page.keyboard.press('l')
        check(await page.evaluate("document.getElementById('pasteBtn').hidden"), 'no Paste button before anything is copied')
        await page.evaluate("__inkwell.selectIds(['s_a','m_a','x_a','i_a'])")
        await page.wait_for_selector('#selCopy', state='visible')
        await page.click('#selCopy')
        clip = await page.evaluate("JSON.parse(localStorage.getItem('inkwell.clip'))")
        check(clip and len(clip['items']) == 4, 'Copy stores 4 items')
        check(isinstance(clip['items'][0].get('p') if clip['items'][0]['t'] == 's' else next(i for i in clip['items'] if i['t'] == 's')['p'], str), 'stroke points stored encoded')
        check(await page.evaluate("!document.getElementById('pasteBtn').hidden && !document.getElementById('opts').hidden"), 'Paste button shows in the Select bar')
        # paste on another page
        await page.evaluate("async () => { await __inkwell.newPage(); }")
        await page.wait_for_timeout(300)
        await page.keyboard.press('l')
        dst = await page.evaluate("__inkwell.cur.id")
        check(dst != src, 'on a new page')
        check(await page.evaluate("!document.getElementById('pasteBtn').hidden"), 'Paste button still there on the other page')
        await page.click('#pasteBtn')
        r = await page.evaluate("""() => { const W = __inkwell, its = [...W.cur.items.values()];
          const s = its.find(i => i.t === 's'), m = its.find(i => i.t === 'm'), x = its.find(i => i.t === 'x'), im = its.find(i => i.t === 'i');
          return {n: its.length, ids: its.map(i => i.id), sp: s && Array.from(s.p), sg: s && s.g, mg: m && m.g, xh: x && x.html, ia: im && im.a, sx: s && s.p[0], mx: m && m.x,
                  sel: W.sel && W.sel.ids.length, cam: {z: W.cam.z, ox: W.cam.ox, oy: W.cam.oy}}; }""")
        check(r['n'] == 4, f"4 items pasted ({r['n']})")
        check(not set(r['ids']) & {'s_a', 'm_a', 'x_a', 'i_a'}, 'pasted items have new ids')
        check(r['sg'] and r['sg'] == r['mg'] and r['sg'] != 'g1', 'group kept together with a new group id')
        check(r['xh'] == '<p>hello copy</p>', 'text copied')
        check(r['ia'] == 'asset-xyz', 'picture keeps its asset')
        check(r['sp'] and len(r['sp']) == 9 and abs((r['sp'][3] - r['sp'][0]) - 40) < 0.6, 'stroke shape kept')
        check(abs((r['mx'] - r['sx']) - 20) < 0.6, 'items keep their positions to each other')
        check(r['sel'] == 4, 'pasted items are selected')
        # centred in the view
        z, ox, oy = r['cam']['z'], r['cam']['ox'], r['cam']['oy']
        b0 = clip['b']; cx = (b0[0] + b0[2]) / 2 + (r['sx'] - 100); scx = cx * z + ox
        check(abs(scx - await page.evaluate("document.getElementById('stage').clientWidth") / 2) < 40, f'pasted in the middle of the view ({scx:.0f})')
        # saved with the page
        await page.evaluate("__inkwell.flushSaves()")
        saved = await page.evaluate("async id => { const d = await __inkwell.IDB.get('docs', 'c_' + id); return d && d.data.items.length; }", dst)
        check(saved == 4, f'pasted items saved ({saved})')
        # same page: Ctrl+V puts the copy just beside it
        await page.evaluate("__inkwell.openPage(%r)" % src); await page.wait_for_timeout(500)
        await page.evaluate("document.activeElement && document.activeElement.blur()")
        await page.keyboard.press('Control+v')
        r2 = await page.evaluate("() => { const its = [...__inkwell.cur.items.values()].filter(i => i.t === 'i'); return {n: __inkwell.cur.items.size, xs: its.map(i => i.x)}; }")
        check(r2['n'] == 8, f'Ctrl+V pasted on the same page ({r2["n"]})')
        dx = max(r2['xs']) - min(r2['xs'])
        check(0 < dx < 60, f'same page: copy sits just beside the original ({dx:.1f})')
        # Ctrl+X cuts the selection
        await page.keyboard.press('Control+x')
        n3 = await page.evaluate("__inkwell.cur.items.size")
        check(n3 == 4, f'Ctrl+X removes the selection ({n3})')
        # clipboard survives a reload
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.keyboard.press('l')
        check(await page.evaluate("!document.getElementById('pasteBtn').hidden"), 'Paste still available after reload')
        await page.keyboard.press('p')
        check(await page.evaluate("document.getElementById('pasteBtn').hidden && !document.getElementById('sizeWrap').hidden"), 'pen bar unchanged (no Paste, size slider back)')
        check(not errs, 'no page errors: ' + '; '.join(errs[:3]))
        await b.close()
    if fails: raise SystemExit(1)
    print('ALL OK')
asyncio.run(main())
