# 1.52: select text on imported pages with the lasso. Lines of the page's text (ptxt) inside the loop light up;
# Copy puts them on the clipboard; Text… opens a window to copy part of it or put it on the page as a text box.
# PDFs imported from 1.52 store x0/x1/h per line (one column can be picked); older lines (y only) pick whole rows.
import asyncio, os, io, base64
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

def two_column_pdf():
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=A4); W, H = A4
    c.setFont('Helvetica', 12)
    for i in range(8):
        c.drawString(50, H - 100 - i * 20, f'Left column line {i + 1}')
        c.drawString(320, H - 100 - i * 20, f'Right column line {i + 1}')
    c.showPage(); c.save()
    return base64.b64encode(buf.getvalue()).decode()

async def boot(page):
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, permissions=['clipboard-read', 'clipboard-write'])
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await boot(page)

        # 0. real PDF: pdfLines keeps where each line is
        b64 = two_column_pdf()
        L = await page.evaluate("""async (b64) => {
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const pdf = await pdfjsLib.getDocument({data: bytes}).promise, pg = await pdf.getPage(1);
          return await __inkwell.pdfLines(pg); }""", b64)
        left = [l for l in L if l[1].startswith('Left')]; right = [l for l in L if l[1].startswith('Right')]
        check(len(L) == 16 and len(left) == 8 and len(right) == 8, f'PDF columns read as separate lines ({len(L)} lines; first {L[:1]})')
        check(all(len(l) == 5 for l in L), 'each line has [y, text, x0, x1, h]')
        check(all(l[3] < 0.5 for l in left) and all(l[2] > 0.5 for l in right) and all(0.005 < l[4] < 0.05 for l in L),
              f'left column ends before the middle, right starts after it, sensible height ({left[0]}, {right[0]})')

        # a page picture with that text (as an import would make it), and an old-style page (y only) below it
        await page.evaluate("""async (L) => { const W = __inkwell; await W.newPage(); W.setTool('lasso');
          W.addItems([{t: 'i', id: 'iPdf', x: 0, y: 0, w: 600, h: 848, a: 'aPdf', doc: 1},
                      {t: 'i', id: 'iOld', x: 0, y: 900, w: 600, h: 848, a: 'aOld', doc: 1}]);
          await W.savePtxt('aPdf', 'pdf', L);
          await W.savePtxt('aOld', 'ocr', [[0.10, 'Old row one'], [0.13, 'Old row two'], [0.16, 'Old row three'], [0.19, 'Old row four']]);
          W.cam.z = 1; W.cam.ox = 40; W.cam.oy = 20; }""", L)
        await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.left, b.top]; })()")
        cam = {'z': 1, 'ox': 40, 'oy': 20}
        async def readcam():
            cam.update(await page.evaluate("({z: __inkwell.cam.z, ox: __inkwell.cam.ox, oy: __inkwell.cam.oy})"))
        def scr(wx, wy): return (st[0] + cam['ox'] + wx * cam['z'], st[1] + cam['oy'] + wy * cam['z'])
        async def lasso(x0, y0, x1, y1):
            await readcam()
            pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0 + 2)]
            await page.mouse.move(*scr(*pts[0])); await page.mouse.down()
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                for k in range(1, 9): await page.mouse.move(*scr(ax + (bx - ax) * k / 8, ay + (by - ay) * k / 8))
            await page.mouse.up(); await page.wait_for_timeout(300)
        async def scroll(dx, dy):
            await page.mouse.move(st[0] + 300, st[1] + 300); await page.mouse.wheel(dx, dy); await page.wait_for_timeout(400); await readcam()
        async def state():
            return await page.evaluate("""(() => ({lines: __inkwell.TS.lines.map(l => l.s), menu: !document.getElementById('tsLayer').hidden,
              hl: document.querySelectorAll('#tsBox i').length, sel: __inkwell.sel ? __inkwell.sel.ids.length : 0,
              selText: !document.getElementById('selText').hidden}))()""")

        # 1. loop around lines 2-4 of the left column only
        y2, y4 = left[1][0] * 848, left[3][0] * 848 + left[3][4] * 848
        await lasso(20, y2 - 4, 280, y4 + 4)
        s = await state()
        check(s['lines'] == ['Left column line 2', 'Left column line 3', 'Left column line 4'], f'left column lines 2-4 picked ({s["lines"]})')
        check(s['menu'] and s['hl'] == 3 and s['sel'] == 0, f'3 lines light up with the text menu, nothing else selected ({s})')
        n = await page.inner_text('#tsN')
        check(n.strip() == '3 lines', f'menu says "{n}"')
        hl = await page.evaluate("[...document.querySelectorAll('#tsBox i')].map(e => e.getBoundingClientRect()).map(r => [r.left, r.top, r.width, r.height])")
        lx0 = scr(left[1][2] * 600, 0)[0]
        check(abs(hl[0][0] - lx0) < 2 and hl[0][2] < 300, f'highlight sits on the line ({hl[0]}, line starts at {lx0:.1f})')

        # 2. Copy
        await page.click('#tsCopy'); await page.wait_for_timeout(200)
        clip = await page.evaluate("navigator.clipboard.readText()")
        check(clip == 'Left column line 2\nLeft column line 3\nLeft column line 4', f'Copy puts the lines on the clipboard ({clip!r})')

        # 3. Text… window: select part, copy part, put on page
        await page.click('#tsOpen'); await page.wait_for_timeout(200)
        v = await page.evaluate("(() => ({open: !document.getElementById('tsDlg').hidden, t: document.getElementById('tsText').value}))()")
        check(v['open'] and v['t'] == clip, 'Text… opens the window with the text')
        await page.evaluate("(() => { const t = document.getElementById('tsText'); t.focus(); t.setSelectionRange(5, 18); })()")
        await page.click('#tsDlgCopy'); await page.wait_for_timeout(200)
        clip2 = await page.evaluate("navigator.clipboard.readText()")
        check(clip2 == 'column line 2', f'Copy in the window copies only the selected part ({clip2!r})')
        await page.evaluate("(() => { const t = document.getElementById('tsText'); t.focus(); t.setSelectionRange(0, t.value.length); })()")
        await page.click('#tsDlgPut'); await page.wait_for_timeout(300)
        x = await page.evaluate("""(() => { const it = [...__inkwell.cur.items.values()].filter(i => i.t === 'x').pop();
          return it ? {x: it.x, y: it.y, text: __inkwell.htmlText(it.html), closed: document.getElementById('tsDlg').hidden, menu: !document.getElementById('tsLayer').hidden} : null; })()""")
        check(x and x['closed'] and not x['menu'], f'Put on page closes the window and the highlight ({x})')
        check(x and 'Left column line 2' in x['text'] and 'Left column line 4' in x['text'] and x['x'] >= 600 and abs(x['y'] - y2) < 3,
              f'text box with the lines right of the page at the first line ({x})')

        # 4. old page (y only): a loop across the rows picks whole rows
        await scroll(0, 900)
        await lasso(200, 900 + 0.125 * 848, 400, 900 + 0.185 * 848)
        s = await state()
        check(s['lines'] == ['Old row two', 'Old row three'], f'old-style page: rows inside the loop ({s["lines"]})')

        # 5. tap elsewhere clears it
        await readcam(); await page.mouse.click(*scr(-25, 900 + 450)); await page.wait_for_timeout(200)   # empty space left of the page
        s = await state()
        check(not s['menu'] and s['lines'] == [], f'tap elsewhere clears the text selection ({s})')

        # 6. loop that also catches ink: normal selection, with a Text button
        await scroll(0, -900)
        await page.evaluate("""() => { const W = __inkwell; const p = []; for(let i = 0; i < 30; i++) p.push(330 + i * 4, %f + 4, 0.5);
          W.addItems([{t: 's', id: 'sInk', c: '#d00', w: 2, p}]); }""" % (right[1][0] * 848))
        await lasso(310, right[1][0] * 848 - 6, 590, right[2][0] * 848 + right[2][4] * 848 + 4)
        s = await state()
        check(s['sel'] == 1 and s['selText'] and not s['menu'], f'ink selected, Text button in its menu ({s})')
        check(s['lines'] == ['Right column line 2', 'Right column line 3'], f'right column lines found ({s["lines"]})')
        await page.click('#selText'); await page.wait_for_timeout(200)
        v = await page.evaluate("(() => ({open: !document.getElementById('tsDlg').hidden, t: document.getElementById('tsText').value}))()")
        check(v['open'] and v['t'] == 'Right column line 2\nRight column line 3', f'Text button opens the window ({v})')
        await page.keyboard.press('Escape'); await page.evaluate("document.querySelector('#tsDlg [data-close]').click()"); await page.wait_for_timeout(150)

        # 7. a loop over plain ink (no imported page) does not show anything new
        await page.evaluate("__inkwell.addItems([{t: 's', id: 'sFar', c: '#000', w: 2, p: [440,680,.5,560,680,.5,560,720,.5]}])")
        await page.evaluate("__inkwell.removeItems(['iPdf'])"); await page.wait_for_timeout(200)
        await lasso(420, 660, 580, 740)
        s = await state()
        check(s['sel'] == 1 and not s['selText'] and not s['menu'], f'lasso away from imported pages works as before ({s})')

        # 8. zoom and scroll: the highlight follows the page
        await page.evaluate("__inkwell.undo ? 0 : 0")
        await page.keyboard.press('Control+z'); await page.wait_for_timeout(300)   # brings the PDF page back
        back = await page.evaluate("__inkwell.cur.items.has('iPdf')")
        check(back, 'page back after undo')
        await lasso(20, y2 - 4, 280, y4 + 4)
        await page.mouse.move(st[0] + 200, st[1] + 200)
        await page.keyboard.down('Control'); await page.mouse.wheel(0, -300); await page.keyboard.up('Control'); await page.wait_for_timeout(400)
        await scroll(0, 40)
        r = await page.evaluate("(() => { const e = document.querySelector('#tsBox i'); return e ? e.getBoundingClientRect().top : null; })()")
        want = scr(0, y2)[1]
        check(cam['z'] > 1.05 and r is not None and abs(r - want) < 3, f'highlight follows zoom {cam["z"]:.2f} and scroll ({r} vs {want:.1f})')
        if os.environ.get('SNAP_SHOT'): await page.screenshot(path=os.environ['SNAP_SHOT'])
        check(not errs, f'no page errors ({errs[:2]})')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
