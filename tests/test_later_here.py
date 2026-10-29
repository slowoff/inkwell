# 1.71: the Later list shows an "On this page" group on top (marks on the open page, top to bottom), then
# "Other pages". Tapping a row and Done still act on the right mark.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

def mark(i, x, y, at):
    return "{t: 's', id: '%s', c: '#8B5CF6', w: 14, hl: 1, mk: 1, at: %d, p: [%d,%d,.5,%d,%d,.5,%d,%d,.5]}" % (i, at, x, y, x + 60, y, x + 120, y)

LIST = """(() => [...document.querySelectorAll('#laterList > *')].map(e => e.classList.contains('later-head') ? 'H:' + e.textContent.trim()
  : e.classList.contains('later-row') ? 'R:' + e.dataset.i : e.classList.contains('later-empty') ? 'E:' + e.textContent.trim() : '?'))()"""

async def open_later(page):
    if not await page.evaluate("document.getElementById('laterPop').hidden"):
        await page.click('#laterBtn'); await page.wait_for_timeout(300)
    await page.click('#laterBtn'); await page.wait_for_timeout(900)
    return await page.evaluate(LIST)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1366, 'height': 1024})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        # page A: one mark (older)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await page.evaluate("() => __inkwell.addItems([%s])" % mark('mA', 100, 300, 1000))
        pidA = await page.evaluate("__inkwell.cur.id")
        await page.evaluate("__inkwell.flushSaves()"); await page.wait_for_timeout(400)
        # page B (open): two marks, the lower one newer
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await page.evaluate("() => __inkwell.addItems([%s, %s])" % (mark('mLow', 100, 900, 3000), mark('mTop', 100, 200, 2000)))
        pidB = await page.evaluate("__inkwell.cur.id")
        await page.evaluate("__inkwell.flushSaves()"); await page.wait_for_timeout(400)
        l = await open_later(page)
        check(l[0].startswith('H:On this page') and '2' in l[0], f'"On this page" heading first, with count ({l})')
        check(l[1:3] == ['R:0', 'R:1'] and l[3].startswith('H:Other pages') and l[4] == 'R:2' and len(l) == 5, f'this page\'s 2 marks, then Other pages with 1 ({l})')
        # top-to-bottom order on this page: row 0 is the top mark
        await page.click('[data-go="0"]'); await page.wait_for_timeout(700)
        cy = await page.evaluate("(() => { const c = __inkwell.cam; return (window.innerHeight * 0.42 - c.oy) / c.z; })()")
        check(abs(cy - 200) < 120, f'first row on this page jumps to the top mark (world y {cy:.0f})')
        # the other page's row opens page A
        await open_later(page)
        await page.click('[data-go="2"]'); await page.wait_for_timeout(1200)
        check(await page.evaluate("__inkwell.cur.id") == pidA, 'row under Other pages opens that page')
        l = await open_later(page)
        check(l[0].startswith('H:On this page') and l[1] == 'R:0' and l[2].startswith('H:Other pages') and l[3:] == ['R:1', 'R:2'], f'on page A the groups swap ({l})')
        # Done on the this-page row removes the right mark
        await page.click('[data-done="0"]'); await page.wait_for_timeout(1200)
        check(not await page.evaluate("__inkwell.cur.items.has('mA')"), 'Done removes the mark on this page')
        l = await page.evaluate(LIST)
        check(l[0].startswith('H:On this page') and l[1].startswith('E:Nothing marked on this page') and l[2].startswith('H:Other pages') and len(l) == 5, f'empty this-page group says so, others still listed ({l})')
        check(await page.evaluate("document.getElementById('laterCount').textContent") == '2', 'badge counts 2')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
