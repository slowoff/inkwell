# 1.56: the text formatting bar also styles a PDF's own fill-in text field (whole field): bold, italic,
# underline, size, colour; spell check; headings/lists/link stay greyed. Undo, reload, export HTML.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

ST = """(() => { const f = document.getElementById('fmtBar'), c = document.querySelector('textarea.pf-tx');
  const it = __inkwell.cur.items.get('ipdf'), fl = it.f[0];
  return {shown: !f.hidden, idle: f.classList.contains('idle'), field: f.classList.contains('field'),
          h1: getComputedStyle(f.querySelector('[data-block=h1]')).pointerEvents, focus: document.activeElement === c,
          boldOn: f.querySelector('[data-cmd=bold]').classList.contains('on'), size: document.getElementById('tsizeVal').textContent,
          fw: c.style.fontWeight, fst: c.style.fontStyle, td: c.style.textDecoration, col: c.style.color, fs: c.style.fontSize,
          b: fl.b || 0, it: fl.it || 0, u: fl.u || 0, c: fl.c || '', s: fl.s || 0, v: fl.v || '', spell: c.spellcheck}; })()"""

async def boot(page):
    await page.goto(URL); await page.wait_for_timeout(3000)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await boot(page)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await page.evaluate("""async () => {
          const cv = document.createElement('canvas'); cv.width = 600; cv.height = 400; const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 400);
          g.strokeStyle = '#000'; g.strokeRect(100, 100, 300, 120);
          const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
          const a = await __inkwell.saveAsset(blob);
          __inkwell.addItems([{t: 'i', id: 'ipdf', x: 0, y: 0, w: 600, h: 400, a, doc: 1,
            f: [{k: 'tx', ml: 1, x: 100 / 600, y: 100 / 400, w: 300 / 600, h: 120 / 400, v: 'Art 168 StPo'}]}]);
        }""")
        await page.wait_for_timeout(1500)
        await page.evaluate("() => __inkwell.setTool('text')"); await page.wait_for_timeout(200)
        r = await page.evaluate("(() => { const r = document.querySelector('textarea.pf-tx').getBoundingClientRect(); return [r.left + 60, r.top + 20, r.width]; })()")
        check(r[2] > 50, f'test PDF field on screen ({r})')
        await page.mouse.click(r[0], r[1]); await page.wait_for_timeout(300)
        s = await page.evaluate(ST)
        check(s['shown'] and not s['idle'] and s['field'] and s['focus'], f'cursor in the PDF field: bar active in field mode ({s})')
        check(s['h1'] == 'none', 'headings/lists/link greyed in a field')
        sz0 = s['size']
        await page.click('#fmtBar [data-cmd="bold"]'); await page.wait_for_timeout(300)
        s = await page.evaluate(STATE := ST)
        check(s['b'] == 1 and s['fw'] == '700' and s['boldOn'] and s['focus'], f'Bold makes the field bold, button lit, cursor stays ({s})')
        await page.click('#fmtBar [data-cmd="italic"]'); await page.click('#fmtBar [data-cmd="underline"]'); await page.wait_for_timeout(300)
        s = await page.evaluate(ST)
        check(s['it'] == 1 and s['u'] == 1 and s['fst'] == 'italic' and 'underline' in s['td'], 'Italic and Underline')
        await page.click('#fmtBar [data-act="tsize"]'); await page.wait_for_timeout(200)
        on = await page.evaluate("(document.querySelector('#tsizeList .on') || {}).dataset?.px || null")
        await page.click('#tsizeList [data-px="28"]'); await page.wait_for_timeout(300)
        s = await page.evaluate(ST)
        check(s['size'] == '28' and abs(float(s['fs'][:-2]) - 28) < 0.05 and s['focus'], f'size 28 for the field (was {sz0}, marked {on}) ({s})')
        await page.click('#fmtBar [data-act="tcolor"]'); await page.wait_for_timeout(200)
        await page.click('#tpalette [data-tc="#C2362B"]'); await page.wait_for_timeout(300)
        s = await page.evaluate(ST)
        check(s['c'] == '#C2362B' and s['col'] in ('rgb(194, 54, 43)', '#c2362b') and s['focus'], f'colour for the field ({s["c"]}, {s["col"]})')
        await page.keyboard.press('End'); await page.keyboard.type(' Abs. 1'); await page.wait_for_timeout(200)
        s = await page.evaluate(ST)
        check(s['v'] == 'Art 168 StPo Abs. 1' and s['b'] == 1, f'typing still works and keeps the look ({s["v"]})')
        await page.click('#fmtBar [data-act="spell"]'); await page.wait_for_timeout(300)
        s = await page.evaluate(ST)
        check(s['spell'] is False and s['focus'], 'Spelling off reaches the field, cursor stays')
        await page.click('#fmtBar [data-act="spell"]'); await page.wait_for_timeout(300)
        await page.click('#fmtBar [data-act="done"]'); await page.wait_for_timeout(400)
        s = await page.evaluate(ST)
        check(not s['focus'] and s['idle'] and not s['field'], f'Done leaves the field, bar back to greyed ({s})')
        # undo steps: colour, size, underline, italic, bold (typing is its own step)
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(200)
        s = await page.evaluate(ST)
        check(s['v'] == 'Art 168 StPo' and s['c'] == '#C2362B', f'undo removes the typing first ({s["v"]}, {s["c"]})')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(200)
        s = await page.evaluate(ST)
        check(s['c'] == '' and s['s'] > 0, 'next undo removes the colour')
        await page.evaluate("__inkwell.redo(); __inkwell.redo()"); await page.wait_for_timeout(300)
        s = await page.evaluate(ST)
        check(s['c'] == '#C2362B' and s['v'].endswith('Abs. 1'), 'redo brings them back')
        await page.evaluate("async () => { await __inkwell.flushSaves(); }"); await page.wait_for_timeout(500)
        await page.reload(); await page.wait_for_timeout(3500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur && document.querySelector("textarea.pf-tx")', timeout=15000)
        s = await page.evaluate(ST)
        check(s['b'] == 1 and s['fw'] == '700' and abs(float(s['fs'][:-2]) - 28) < 0.05 and s['col'] in ('rgb(194, 54, 43)', '#c2362b'), f'look kept after a reload ({s})')
        # pen tool: focusing the field still shows the bar; leaving hides it
        await page.evaluate("() => __inkwell.setTool('pen')"); await page.wait_for_timeout(200)
        r = await page.evaluate("(() => { const r = document.querySelector('textarea.pf-tx').getBoundingClientRect(); return [r.left + 60, r.top + 20]; })()")
        await page.evaluate("document.querySelector('textarea.pf-tx').focus()"); await page.wait_for_timeout(300)
        s = await page.evaluate(ST)
        check(s['shown'] and s['field'], 'field focused with the pen tool: bar shows for it')
        await page.evaluate("document.querySelector('textarea.pf-tx').blur()"); await page.wait_for_timeout(400)
        s = await page.evaluate(ST)
        check(not s['shown'], 'left the field with the pen tool: bar hidden again')
        ex = await page.evaluate("__inkwell.fieldParts(__inkwell.cur.items.get('ipdf'), 0, 0).map(p => p.h).join('')")
        check('font-weight:700' in ex and 'font-style:italic' in ex and 'underline' in ex and '#C2362B' in ex and 'Abs. 1' in ex, 'PDF export draws the field with its look')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
