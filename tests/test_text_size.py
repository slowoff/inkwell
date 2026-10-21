# 1.54: text size dropdown in the text formatting bar. Selected words get the size; with nothing selected the
# whole box changes; an empty box changes its own size so typing comes out at that size. Undo, reload.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SIZE_OF = """w => { const el = document.querySelector('.it-text'); const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for(let n; (n = tw.nextNode());){ if(n.data.indexOf(w) >= 0) return Math.round(parseFloat(getComputedStyle(n.parentNode).fontSize)); }
  return null; }"""
SELECT = """w => { const el = document.querySelector('.it-text'); const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for(let n; (n = tw.nextNode());){ const i = n.data.indexOf(w); if(i >= 0){ const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
  return false; }"""

async def pick(page, px):
    await page.click('#fmtBar [data-act="tsize"]'); await page.wait_for_timeout(200)
    await page.click(f'#tsizeList [data-px="{px}"]'); await page.wait_for_timeout(200)

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
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await page.evaluate("() => __inkwell.setTool('text')")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        await page.mouse.click(st[0] + 250, st[1] + 200); await page.wait_for_timeout(300)

        vis = await page.evaluate("(() => { const b = document.querySelector('#fmtBar [data-act=tsize]'); const r = b.getBoundingClientRect(); return !document.getElementById('fmtBar').hidden && r.width > 30 && document.getElementById('tsizeVal').textContent; })()")
        check(vis == '17', f'size button in the formatting bar shows 17 for a new box ({vis})')
        await page.click('#fmtBar [data-act="tsize"]'); await page.wait_for_timeout(200)
        pop = await page.evaluate("""(() => { const p = document.getElementById('tsizePop'); const r = p.getBoundingClientRect();
          return {open: !p.hidden, n: p.querySelectorAll('[data-px]').length, on: (p.querySelector('.on') || {}).dataset?.px,
                  inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
                  editing: !!document.querySelector('.it-text[contenteditable=true]'), focus: document.activeElement.classList.contains('it-text')}; })()""")
        check(pop['open'] and pop['n'] == 11 and pop['on'] == '17' and pop['inside'], f'dropdown opens with 11 sizes, 17 marked, on screen ({pop})')
        check(pop['editing'] and pop['focus'], 'box stays open and focused while the dropdown is open')
        await page.click('#fmtBar [data-act="tsize"]'); await page.wait_for_timeout(150)
        check(await page.evaluate("document.getElementById('tsizePop').hidden"), 'tapping the button again closes the dropdown')

        # empty box -> box size
        await pick(page, 28)
        fs = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'x').fs")
        check(abs(fs - 28 / 17) < 0.002, f'empty box: the box gets the size (fs {fs})')
        await page.keyboard.type('Hello world'); await page.wait_for_timeout(200)
        check(await page.evaluate(SIZE_OF, 'Hello') == 28, 'typing after it comes out at 28')

        # selected word
        await page.evaluate(SELECT, 'world'); await page.wait_for_timeout(100)
        await pick(page, 40)
        s1 = await page.evaluate(SIZE_OF, 'world'); s0 = await page.evaluate(SIZE_OF, 'Hello')
        check(s1 == 40 and s0 == 28, f'selected word gets 40, the rest stays 28 ({s1}, {s0})')
        sel = await page.evaluate("getSelection().toString()")
        check(sel == 'world', f'selection kept after picking a size ({sel!r})')
        check(await page.evaluate("document.getElementById('tsizeVal').textContent") == '40', 'button shows the size of the selection')
        # resize the same word again: no nested sizes
        await pick(page, 12)
        nest = await page.evaluate("document.querySelector('.it-text').querySelectorAll(':scope [style*=\"font-size\"] [style*=\"font-size\"]').length")
        check(await page.evaluate(SIZE_OF, 'world') == 12 and nest == 0, f'resizing again gives 12, no nested sizes ({nest})')

        # nothing selected -> whole box (heading included)
        await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('Title')
        await page.click('#fmtBar [data-block="h1"]'); await page.wait_for_timeout(150)
        await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft')
        await pick(page, 20)
        sizes = [await page.evaluate(SIZE_OF, w) for w in ('Hello', 'world', 'Title')]
        check(sizes == [20, 20, 20], f'nothing selected: whole box incl. heading becomes 20 ({sizes})')
        caret = await page.evaluate("(() => { const s = getSelection(); return s.isCollapsed && s.anchorNode.textContent.includes('Title') && s.anchorOffset; })()")
        check(caret == 3, f'cursor put back where it was ({caret})')
        check(await page.evaluate("document.querySelector('.it-text').querySelectorAll('font').length") == 0, 'no <font> left in the box')

        # finish, undo, redo
        await page.keyboard.press('Escape'); await page.wait_for_timeout(400)
        html = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'x').html")
        check('font-size: 20px' in html and '<h1>' in html, f'sizes saved in the box ({html})')
        check(await page.evaluate("__inkwell.cleanHTML(" + repr(html) + ")") == html, 'saved html survives cleanHTML unchanged')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(300)
        n = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'x').length")
        check(n == 0, 'undo removes the new box in one step')
        await page.evaluate("__inkwell.redo()"); await page.wait_for_timeout(300)
        check(await page.evaluate(SIZE_OF, 'Title') == 20, 'redo brings it back with its sizes')

        await page.evaluate("async () => { await __inkwell.flushSaves(); }"); await page.wait_for_timeout(300)
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        sizes = [await page.evaluate(SIZE_OF, w) for w in ('Hello', 'Title')]
        check(sizes == [20, 20], f'sizes kept after a reload ({sizes})')

        # an old box (no sizes) is not changed by just opening and closing it
        await page.evaluate("""() => { const it = {t:'x', id:'xold1', x: 0, y: 700, w: 300, fs: 1, html: '<p>Old note</p>'}; __inkwell.addItems([it]); }""")
        await page.wait_for_timeout(300)
        await page.evaluate("() => __inkwell.setTool('text')")
        box = await page.evaluate("(() => { const r = document.querySelector('[data-id=xold1]').getBoundingClientRect(); return [r.left + 20, r.top + 10]; })()")
        await page.mouse.click(box[0], box[1]); await page.wait_for_timeout(300)
        lbl = await page.evaluate("document.getElementById('tsizeVal').textContent")
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        h = await page.evaluate("__inkwell.cur.items.get('xold1').html")
        check(lbl == '17' and h == '<p>Old note</p>', f'old box shows 17 and stays unchanged ({lbl}, {h})')

        # touch size
        tctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await tctx.route('**/*.supabase.co/**', lambda r: r.abort())
        tp = await tctx.new_page()
        await tp.goto(URL); await tp.wait_for_timeout(3000)
        await tp.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await tp.evaluate("async () => { await __inkwell.newPage(); }"); await tp.wait_for_timeout(400)
        await tp.evaluate("() => __inkwell.setTool('text')")
        await tp.mouse.click(st[0] + 250, st[1] + 200); await tp.wait_for_timeout(300)
        hb = await tp.evaluate("document.querySelector('#fmtBar [data-act=tsize]').getBoundingClientRect().height")
        await tp.evaluate("document.querySelector('#fmtBar [data-act=tsize]').click()"); await tp.wait_for_timeout(200)
        hl = await tp.evaluate("document.querySelector('#tsizeList [data-px]').getBoundingClientRect().height")
        check(hb >= 44 and hl >= 44, f'touch: button and rows are 44 px ({hb}, {hl})')
        await tctx.close()

        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
