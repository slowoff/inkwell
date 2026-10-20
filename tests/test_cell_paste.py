# 1.44.1: several lines pasted into a table-cell text box stay readable with normal line spacing
# (before: shrunk to 6 px letters with 3 huge line gaps); a short answer still fills the cell as one line.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

PASTE = """t => { const el = document.querySelector('.it-text[contenteditable=true]'); const dt = new DataTransfer(); dt.setData('text/plain', t);
  el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); }"""
LINES = ('Plafonierung der Rente (150% max)\\nAnspruch auf\\nWitwen-/Witwerrente\\nAHV-Beiträge werden bei Scheidung aufgeteilt\\n'
         'Bei Nichterwerbstätigkeit kann der Ehepartner/in die Mindestbeiträge des Ehepartners begleichen, sofern mind. 2x der Mindestbetrag erreicht wird')

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
        # a cell box like the one tapping a worksheet table cell makes: 300 wide, 260 high, page text 12 px
        await page.evaluate("""() => { const c = __inkwell.cam, x = (60 - c.ox) / c.z, y = (60 - c.oy) / c.z;
          __inkwell.addItems([{t: 'x', id: 'cell', x, y, w: 300, fs: 12 / 17, fs0: 12 / 17, lh: 260, ch: 260, html: ''}]); }""")
        await page.evaluate("() => __inkwell.setTool('text')")
        box = await page.evaluate("(() => { const r = document.querySelector('.it-text').getBoundingClientRect(); return [r.left + 20, r.top + 20]; })()")
        await page.mouse.click(*box); await page.wait_for_timeout(300)
        await page.evaluate(PASTE, LINES.replace('\\n', '\n')); await page.wait_for_timeout(300)
        it = await page.evaluate("(() => { const it = __inkwell.cur.items.get('cell'); const el = document.querySelector('.it-text'); return {F: it.fs * 17, lh: it.lh, h: el.scrollHeight, html: it.html}; })()")
        check('Mindestbetrag' in it['html'], 'pasted text is in the box')
        check(it['F'] >= 7, f'pasted lines stay readable ({it["F"]:.1f} px, was 6 px)')
        check(it['lh'] <= it['F'] * 1.5, f'normal line spacing ({it["lh"]:.1f} px for {it["F"]:.1f} px letters)')
        check(it['h'] <= 260 + 5, f'it fits in the cell here ({it["h"]} <= 260)')
        # a short answer still fills the cell as one line
        await page.evaluate("""() => { const c = __inkwell.cam, x = (500 - c.ox) / c.z, y = (500 - c.oy) / c.z;
          __inkwell.addItems([{t: 'x', id: 'cell2', x, y, w: 200, fs: 12 / 17, fs0: 12 / 17, lh: 20, ch: 20, html: ''}]); }""")
        await page.keyboard.press('Escape'); await page.wait_for_timeout(600)
        box = await page.evaluate("(() => { const r = [...document.querySelectorAll('.it-text')][1].getBoundingClientRect(); return [r.left + 10, r.top + 8]; })()")
        await page.mouse.click(*box); await page.wait_for_timeout(300); await page.keyboard.type('Art. 90 ZGB'); await page.wait_for_timeout(200)
        it2 = await page.evaluate("(() => { const it = __inkwell.cur.items.get('cell2'); return {F: it.fs * 17, lh: it.lh}; })()")
        check(it2['lh'] == 20 and 10 <= it2['F'] <= 12.1, f'short answer: one line in the cell ({it2})')
        # a box squeezed by an older version is fixed when tapped
        await page.keyboard.press('Escape'); await page.wait_for_timeout(600)
        await page.evaluate("""() => { const c = __inkwell.cam, x = (60 - c.ox) / c.z, y = (500 - c.oy) / c.z;
          __inkwell.addItems([{t: 'x', id: 'old', x, y, w: 300, fs: 6 / 17, fs0: 12 / 17, lh: 86.67, ch: 260, html: '<p>Plafonierung der Rente</p><p>Anspruch auf</p><p>Witwen-/Witwerrente</p><p>AHV-Beiträge</p>'}]); }""")
        box = await page.evaluate("(() => { const r = [...document.querySelectorAll('.it-text')][2].getBoundingClientRect(); return [r.left + 10, r.top + 30]; })()")
        await page.mouse.click(*box); await page.wait_for_timeout(300)
        it3 = await page.evaluate("(() => { const it = __inkwell.cur.items.get('old'); return {F: it.fs * 17, lh: it.lh}; })()")
        check(it3['F'] >= 7 and it3['lh'] < 30, f'an old squeezed box is redone when tapped ({it3})')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
