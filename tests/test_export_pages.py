# 1.66 (Rafael: "make me able to export singular pages too"). Export as PDF has "All pages" / "Only some pages"
# ("3", "2-5, 8"). A page made of imported document pages gets one PDF page per imported page (so page 94 of a
# book is page 94 of the export); notes further down follow on A4. Other pages are cut into A4 sheets as before.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

INFO = """async () => { const W = __inkwell;
  for(let i = 0; i < 100 && (!W.Pdf.file || document.getElementById('exportSave').disabled); i++) await new Promise(r => setTimeout(r, 100));
  const f = W.Pdf.file; if(!f) return {err: document.getElementById('exportInfo').textContent};
  const d = await PDFLib.PDFDocument.load(await f.arrayBuffer());
  return {n: d.getPageCount(), sizes: d.getPages().map(p => [Math.round(p.getWidth()), Math.round(p.getHeight())]), name: f.name,
          info: document.getElementById('exportInfo').textContent, pick: !document.getElementById('exportPick').hidden}; }"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.wait_for_timeout(500)

        # a page of 6 imported document pages, with writing on page 3 and notes below the last one
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage();
          const A4W = 794, A4H = 1123, items = [];
          for(let i = 0; i < 6; i++) items.push({t: 'i', id: 'd' + i, x: 0, y: i * (A4H + 24), w: A4W, h: A4H, doc: 1});
          items.push({t: 's', id: 's1', c: '#1F4FCF', w: 3, p: [100, 2 * (A4H + 24) + 300, .5, 500, 2 * (A4H + 24) + 340, .5]});
          W.addItems(items); }""")
        await page.evaluate("() => __inkwell.exportPdfFile()")
        r = await page.evaluate(INFO)
        check(r.get('n') == 6 and r['pick'], f'imported document: one PDF page per imported page ({r.get("n")}, {r.get("info")})')
        ok_size = r.get('sizes') == [[595, 842]] * 6
        check(ok_size, f'each keeps the shape of the original page ({r.get("sizes")})')

        await page.click('#exportPick [data-pick="some"]'); await page.wait_for_timeout(200)
        vis = await page.evaluate("() => !document.getElementById('exportPages').hidden && document.getElementById('exportSave').disabled")
        check(vis, 'Only some pages: a box for the page numbers, Save waits for them')
        await page.fill('#exportPages', '3')
        await page.wait_for_timeout(800)
        r = await page.evaluate(INFO)
        check(r.get('n') == 1 and '(page 3)' in r.get('name', '') and 'page 3 of 6' in r.get('info', ''), f'"3": only page 3 ({r})')
        await page.fill('#exportPages', '2-4, 6')
        await page.wait_for_timeout(800)
        r = await page.evaluate(INFO)
        check(r.get('n') == 4 and '2–4, 6' in r.get('info', '') and '(pages 2-4, 6)' in r.get('name', ''), f'"2-4, 6": four pages ({r.get("n")}, {r.get("info")}, {r.get("name")})')
        await page.fill('#exportPages', '9')
        await page.wait_for_timeout(800)
        st = await page.evaluate("() => [document.getElementById('exportSave').disabled, document.getElementById('exportInfo').textContent]")
        check(st[0] and 'from 1 to 6' in st[1], f'a page that does not exist: explained, nothing to save ({st})')
        await page.click('#exportPick [data-pick="all"]'); await page.wait_for_timeout(300)
        r = await page.evaluate(INFO)
        check(r.get('n') == 6 and '(page' not in r.get('name', ''), f'back to All pages ({r.get("n")}, {r.get("name")})')
        await page.evaluate("() => document.querySelector('#exportDlg [data-close]').click()")

        # writing beside one page makes only that PDF page wider
        await page.evaluate("() => __inkwell.addItems([{t: 's', id: 's3', c: '#1F4FCF', w: 3, p: [900, 4 * (1123 + 24) + 300, .5, 1100, 4 * (1123 + 24) + 400, .5]}])")
        await page.evaluate("() => __inkwell.exportPdfFile()")
        r = await page.evaluate(INFO)
        sz = r.get('sizes', [])
        check(len(sz) == 6 and sz[4][1] < 842 and all(s == [595, 842] for i, s in enumerate(sz) if i != 4), f'notes beside page 5: only page 5 is wider ({sz})')
        await page.evaluate("() => { __inkwell.removeItems(['s3']); document.querySelector('#exportDlg [data-close]').click(); }")

        # notes below the imported pages follow on A4
        await page.evaluate("""() => { const W = __inkwell; const y = 6 * (1123 + 24) + 200;
          W.addItems([{t: 's', id: 's2', c: '#1F4FCF', w: 3, p: [100, y, .5, 500, y + 1500, .5]}]); }""")
        await page.evaluate("() => __inkwell.exportPdfFile()")
        r = await page.evaluate(INFO)
        check(r.get('n') == 8 and r['sizes'][-1][1] == 842, f'notes below the last imported page: A4 sheets after it ({r.get("n")}, {r.get("sizes", [])[-2:]})')
        await page.evaluate("() => document.querySelector('#exportDlg [data-close]').click()")

        # an ordinary handwritten page: A4 sheets as before
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage();
          W.addItems([{t: 's', id: 'w1', c: '#1F4FCF', w: 3, p: [100, 100, .5, 600, 2500, .5]}]); }""")
        await page.evaluate("() => __inkwell.exportPdfFile()")
        r = await page.evaluate(INFO)
        check(r.get('n') == 3 and all(s == [595, 842] for s in r['sizes']), f'handwritten page: A4 sheets ({r.get("n")}, {r.get("sizes")})')
        await page.click('#exportPick [data-pick="some"]')
        await page.fill('#exportPages', '2'); await page.wait_for_timeout(800)
        r = await page.evaluate(INFO)
        check(r.get('n') == 1 and r['sizes'] == [[595, 842]], f'and one sheet of it can be exported ({r})')
        await page.evaluate("() => document.querySelector('#exportDlg [data-close]').click()")

        # a one-sheet page: no page choice
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage();
          W.addItems([{t: 's', id: 'o1', c: '#1F4FCF', w: 3, p: [100, 100, .5, 300, 200, .5]}]); }""")
        await page.evaluate("() => __inkwell.exportPdfFile()")
        r = await page.evaluate(INFO)
        check(r.get('n') == 1 and not r['pick'], f'one page: no page choice shown ({r.get("pick")})')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
