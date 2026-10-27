# 1.67.4 (second bug check 2026-10-27): each fix checked here.
# 1. Graph formulas with letters written together ("sinx", "xe^x") showed "Unknown name" and drew nothing.
# 2. loadScript: a second call while a library was still loading went on at once (PDFLib not defined); a failed load
#    (offline) counted as loaded until Inkwell restarted.
# 3. PDFs opened for import stayed in memory (pdf.js) until Inkwell was closed.
# 4. To formula put the formula on whatever page was open when Claude answered.
# 5. A picture not found (not downloaded yet) was asked for again on every scroll near it.
# 6. Fit everything on screen ignored the Max zoom setting.
# 7. An image import landed on the page that was open when it was ready, not the one it was imported on.
import asyncio, os, json, tempfile, io
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
TMP = tempfile.mkdtemp()
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

def make_pdf(n, name):
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    p = os.path.join(TMP, name); c = canvas.Canvas(p, pagesize=A4)
    for i in range(n):
        c.setFont('Helvetica', 14)
        for k in range(10): c.drawString(72, 760 - 30 * k, f'PDF page {i + 1}, line {k + 1}: some printed text')
        c.showPage()
    c.save(); return p
def make_png(name):
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (600, 400), 'white'); d = ImageDraw.Draw(im); d.rectangle([50, 50, 550, 350], outline='black', width=6)
    p = os.path.join(TMP, name); im.save(p); return p

async def main():
    pdf = make_pdf(2, 'two.pdf'); png = make_png('pic.png')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        allow = {'zz': False}   # the library is unreachable until the test allows it (the service worker may ask too)
        async def zz(route):
            if not allow['zz']: await route.abort(); return
            await asyncio.sleep(0.4)
            await route.fulfill(status=200, content_type='application/javascript', body='window.__zz = (window.__zz || 0) + 1;')
        await ctx.route('**/lib/zz-test.js', zz)
        async def ask(route):
            await asyncio.sleep(1.5)
            body = 'data: ' + json.dumps({'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'x^2'}}) + '\n\n'
            await route.fulfill(status=200, content_type='text/event-stream', body=body)
        await ctx.route('**/functions/v1/ask', ask)
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('!!(window.__inkwell && window.__inkwellBooted && window.__inkwell.cur)', timeout=15000)

        # ---- 1. graph formulas written together
        r = await page.evaluate("""async () => {
          document.getElementById('graphOpen').click(); await new Promise(r => setTimeout(r, 300));
          const out = {};
          for(const f of ['sinx', '2xe^(-x)', 'pix']){
            const el = document.getElementById('gFn'); el.value = f; el.dispatchEvent(new Event('input', {bubbles: true}));
            out[f] = document.getElementById('gFnMsg').textContent;
          }
          document.getElementById('gX0').value = '-5'; document.getElementById('gX1').value = '5'; document.getElementById('gY0').value = '-2'; document.getElementById('gY1').value = '2';
          document.getElementById('gFn').value = 'sinx';
          const before = __inkwell.cur.items.size;
          document.getElementById('gInsert').click(); await new Promise(r => setTimeout(r, 300));
          const its = [...__inkwell.cur.items.values()];
          out.curve = its.filter(i => i.t === 's' && i.c === (__inkwell.prefs.graph && __inkwell.prefs.graph.fnC || '#1F4FCF')).length;
          out.added = __inkwell.cur.items.size - before;
          return out;
        }""")
        check(r['sinx'] == '' and r['2xe^(-x)'] == '' and r['pix'] == '', f'"sinx", "2xe^(-x)", "pix" accepted in the graph window ({r})')
        check(r['curve'] >= 1, f'y = sinx is drawn as a curve ({r["curve"]} curve strokes)')

        # ---- 2. loadScript: second call waits, failed load is tried again
        e1 = await page.evaluate("""async () => {
          const L = __inkwell.loadScript;
          try { await Promise.all([L('lib/zz-test.js'), L('lib/zz-test.js')]); return ''; } catch(e){ return e.message; }
        }""")
        allow['zz'] = True
        r = await page.evaluate("""async () => {
          const L = __inkwell.loadScript;
          const p1 = L('lib/zz-test.js'), p2 = L('lib/zz-test.js');
          await p2;
          const after2 = window.__zz || 0;
          await p1;
          return {after2, n: window.__zz || 0, same: p1 === p2, tags: document.querySelectorAll('script[data-src="lib/zz-test.js"]').length};
        }""")
        check('Could not load' in e1, f'a failed load reports an error ({e1!r})')
        check(r['after2'] == 1 and r['n'] == 1 and r['same'] and r['tags'] == 1, f'after a failed load it loads again; a second call waits until it has loaded, runs once ({r})')

        # ---- 3. PDFs are let go
        async def pick(path):
            await page.click('#insertBtn'); await page.wait_for_timeout(200)
            await page.set_input_files('#importFile', path)
            await page.wait_for_function("!/^(Reading file|Turning)/.test(document.getElementById('impStatus').textContent) && !document.getElementById('impGo').disabled && document.querySelector('#importPreview canvas, #importPreview img')", timeout=60000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await pick(pdf)
        await page.add_script_tag(content="window.__p1 = imp && imp.pdf;")
        await page.evaluate("() => hideModal('importDlg')")
        r = await page.evaluate("async () => { try { await window.__p1.getPage(1); return 'open'; } catch(e){ return 'closed'; } }")
        check(r == 'closed', f'closing the import window lets the PDF go ({r})')
        await pick(pdf)
        await page.add_script_tag(content="window.__p2 = imp && imp.pdf;")
        await page.evaluate("() => { document.getElementById('toastText').textContent = ''; }")
        await page.click('#impGo')
        await page.wait_for_function("/^(Placed|Import stopped)/.test(document.getElementById('toastText').textContent)", timeout=60000)
        r = await page.evaluate("async () => { try { await window.__p2.getPage(1); return 'open'; } catch(e){ return 'closed'; } }")
        n = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'i').length")
        check(r == 'closed' and n == 2, f'after an import the PDF is let go, both pages placed ({r}, {n})')

        # ---- 4. To formula keeps to its page
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          W.Sync.sb = {auth: {getSession: async () => ({data: {session: {access_token: 'x'}}})}};
          await W.newPage(); const p1 = W.cur.id;
          const s1 = {t: 's', id: 's' + Date.now() + 'a', c: 'auto', w: 3, hl: 0, p: [100, 100, 0.5, 130, 140, 0.5, 160, 100, 0.5]};
          W.addItems([s1]); W.selectIds([s1.id]); await W.flushSaves();
          document.getElementById('selMath').click();
          await new Promise(r => setTimeout(r, 300));
          await W.newPage(); const p2 = W.cur.id;
          await new Promise(r => setTimeout(r, 2200));
          const onP2 = [...W.cur.items.values()].filter(i => i.t === 'm').length;
          await W.openPage(p1);
          const onP1 = [...W.cur.items.values()].map(i => i.t);
          return {onP2, onP1, toast: document.getElementById('toastText').textContent};
        }""")
        check(r['onP2'] == 0 and r['onP1'] == ['s'], f'To formula does not land on another page opened meanwhile; the ink stays ({r})')

        # ---- 5. a missing picture is not asked for on every scroll
        r = await page.evaluate("""async () => {
          const W = __inkwell; let n = 0;
          const keep = W.Sync.fetchAsset; W.Sync.fetchAsset = async () => { n++; return null; };
          W.addItems([{t: 'i', id: 'i-missing-' + Date.now(), x: 0, y: 0, w: 400, h: 300, a: 'a-not-here-' + Date.now()}]);
          for(let k = 0; k < 15; k++){ W.cam.oy += 3; W.invalidate(); await new Promise(r => setTimeout(r, 160)); }
          const msg = [...document.querySelectorAll('#worldBack .it-img span')].map(s => s.textContent).filter(Boolean);
          W.Sync.fetchAsset = keep;
          return {n, msg};
        }""")
        check(r['n'] == 1 and 'Not downloaded yet' in r['msg'], f'a missing picture is asked for once, not on every scroll ({r})')

        # ---- 6. Fit everything on screen respects Max zoom
        r = await page.evaluate("""async () => {
          const W = __inkwell; await W.newPage();
          W.prefs.zMax = 0.8;
          W.addItems([{t: 's', id: 's-fit-' + Date.now(), c: 'auto', w: 3, hl: 0, p: [10, 10, 0.5, 40, 30, 0.5]}]);
          document.getElementById('mFit').click(); await new Promise(r => setTimeout(r, 100));
          const z = W.cam.z; W.prefs.zMax = 8;
          return z;
        }""")
        check(r <= 0.8 + 1e-9, f'Fit everything on screen stays within Max zoom (zoom {r})')

        # ---- 7. an image import stays on its page
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        pidA = await page.evaluate("__inkwell.cur.id")
        await pick(png)
        await page.evaluate("() => { window.__keepSave = window.saveAsset; window.saveAsset = async b => { await new Promise(r => setTimeout(r, 900)); return window.__keepSave(b); }; document.getElementById('toastText').textContent = ''; }")
        await page.click('#impGo')
        await page.wait_for_timeout(250)
        await page.evaluate("async () => { await __inkwell.newPage(); }")
        pidB = await page.evaluate("__inkwell.cur.id")
        await page.wait_for_function("/^Placed/.test(document.getElementById('toastText').textContent)", timeout=15000)
        await page.evaluate("() => { window.saveAsset = window.__keepSave; }")
        r = await page.evaluate(f"""async () => {{
          const W = __inkwell; await W.flushSaves();
          const onB = [...W.cur.items.values()].filter(i => i.t === 'i').length;
          const recA = await W.IDB.get('docs', 'c_{pidA}');
          const onA = ((recA && recA.data && recA.data.items) || []).filter(i => i.t === 'i').length;
          await W.openPage('{pidA}');
          const shown = [...W.cur.items.values()].filter(i => i.t === 'i').length;
          return {{onA, onB, shown}};
        }}""")
        check(r['onA'] == 1 and r['onB'] == 0 and r['shown'] == 1, f'the picture goes onto the page it was imported on, not the one opened meanwhile ({r})')
        check(not errs, f'no page errors {errs[:3]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
