# 1.48: Tab in a text box types a tab (text after it jumps forward to the next tab stop) instead of leaving the box;
# Shift+Tab removes it; the tab survives finishing the box and a reload.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

WORD_X = """w => { const el = document.querySelector('.it-text'); const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for(let n; (n = tw.nextNode());){ const i = n.data.indexOf(w); if(i >= 0){ const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); return r.getBoundingClientRect().left - el.getBoundingClientRect().left; } }
  return null; }"""

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
        await page.keyboard.type('a'); await page.keyboard.press('Tab'); await page.keyboard.type('Name')
        await page.keyboard.press('Enter'); await page.keyboard.type('bb'); await page.keyboard.press('Tab'); await page.keyboard.type('Wert')
        await page.wait_for_timeout(200)
        ed = await page.evaluate("!!document.querySelector('.it-text[contenteditable=true]')")
        check(ed, 'Tab keeps the cursor in the box (does not jump to another control)')
        x1 = await page.evaluate(WORD_X, 'Name'); x2 = await page.evaluate(WORD_X, 'Wert'); x0 = await page.evaluate(WORD_X, 'a')
        check(x1 is not None and x1 - x0 > 25, f'text after Tab moves forward ({x0} -> {x1})')
        check(x1 is not None and x2 is not None and abs(x1 - x2) < 2, f'tabs line up like tab stops ({x1} vs {x2})')
        await page.keyboard.press('Shift+Tab'); await page.wait_for_timeout(100)
        t = await page.evaluate("document.querySelector('.it-text').textContent")
        check(t.count('\t') == 2, 'Shift+Tab after text does nothing harmful')
        await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('Shift+Tab'); await page.wait_for_timeout(100)
        t = await page.evaluate("document.querySelector('.it-text').textContent")
        check(t.count('\t') == 1 and 'bbWert' in t, f'Shift+Tab right after a tab removes it ({t!r})')
        await page.keyboard.press('Tab'); await page.wait_for_timeout(100)
        await page.keyboard.press('Escape'); await page.wait_for_timeout(400)
        html = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'x').html")
        check(html.count('\t') == 2 and 'white-space:pre' in html.replace(' ', ''), f'tabs saved ({html})')
        await page.evaluate("async () => { await __inkwell.flushSaves(); }"); await page.wait_for_timeout(300)
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        x1 = await page.evaluate(WORD_X, 'Name'); x2 = await page.evaluate(WORD_X, 'Wert')
        check(x1 is not None and x2 is not None and abs(x1 - x2) < 2 and x1 > 25, f'after a reload the tabs still line up ({x1}, {x2})')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
