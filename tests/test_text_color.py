# 1.58.6: text colour picked with nothing selected colours the text typed next
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
COL = """w => { const el = document.querySelector('.it-text'); const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for(let n; (n = tw.nextNode());){ if(n.data.includes(w)) return getComputedStyle(n.parentNode).color; } return null; }"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        await page.evaluate("() => __inkwell.setTool('text')")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        await page.mouse.click(st[0] + 250, st[1] + 200); await page.wait_for_timeout(300)
        await page.keyboard.type('black ')
        await page.click('#fmtBar [data-act="tcolor"]'); await page.click('#tpalette [data-tc="#1F4FCF"]'); await page.wait_for_timeout(100)
        await page.keyboard.type('blue words'); await page.wait_for_timeout(200)
        check(await page.evaluate(COL, 'blue') == 'rgb(31, 79, 207)', 'colour picked with nothing selected: typed text is blue')
        check(await page.evaluate(COL, 'black') != 'rgb(31, 79, 207)', 'text before it unchanged')
        await page.click('#fmtBar [data-act="tcolor"]'); await page.click('#tpalette [data-tc=""]'); await page.wait_for_timeout(100)
        await page.keyboard.type(' plain'); await page.wait_for_timeout(200)
        check(await page.evaluate(COL, 'plain') == await page.evaluate(COL, 'black'), 'default colour picked: back to normal')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        html = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'x').html")
        check('#1f4fcf' in html.lower() or '31, 79, 207' in html, f'saved ({html})')
        check('254' not in html, 'no marker colour left in the saved text')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)
asyncio.run(main())
