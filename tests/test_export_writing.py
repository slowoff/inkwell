# 1.85: Export: only the writing (transparent), and into the original PDF as a layer.
import asyncio, base64, io, os
from playwright.async_api import async_playwright
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
def make_pdf(rot_second=False, npages=3, tag='ORIGTEXT'):
    buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=A4); W, H = A4
    for i in range(npages):
        if rot_second and i == 1: c.setPageRotation(90) if hasattr(c, 'setPageRotation') else c.setPageSize((W, H)); c._pageRotation = 90
        c.setFont('Helvetica', 20); c.drawString(72, H - 100, f'{tag} {i + 1}'); c.showPage()
    c.save(); return buf.getvalue()
# renders the file; returns text of each page and how much red shows, with the layer on and off
RENDER = """async ({layerOff}) => {
  const W = window.__inkwell; if(!window.pdfjsLib) await W.loadScript('lib/pdf.min.js');
  const pdf = await pdfjsLib.getDocument({data: await W.Pdf.file.arrayBuffer()}).promise;
  const oc = await pdf.getOptionalContentConfig(), groups = oc.getGroups() ? Object.entries(oc.getGroups()).map(([id, g]) => ({id, name: g.name})) : [];
  if(layerOff) for(const g of groups) oc.setVisibility(g.id, false);
  const out = [];
  for(let i = 1; i <= pdf.numPages; i++){
    const pg = await pdf.getPage(i), vp = pg.getViewport({scale: 1.5});
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; const x = c.getContext('2d');
    await pg.render({canvasContext: x, viewport: vp, background: 'rgba(0,0,0,0)', optionalContentConfigPromise: Promise.resolve(oc)}).promise;
    const d = x.getImageData(0, 0, c.width, c.height).data; let red = 0, sx = 0, sy = 0, any = 0;
    for(let k = 0; k < d.length; k += 4){ if(d[k+3] > 10) any++; if(d[k] > 150 && d[k+1] < 90 && d[k+2] < 90 && d[k+3] > 100){ red++; sx += (k / 4) % c.width; sy += Math.floor(k / 4 / c.width); } }
    const t = await pg.getTextContent();
    out.push({text: t.items.map(q => q.str).join(' '), red, cx: red ? sx / red / c.width : 0, cy: red ? sy / red / c.height : 0, any: any / (d.length / 4), w: vp.width, h: vp.height});
  }
  return {pages: out, groups: groups.map(g => g.name), name: W.Pdf.file.name};
}"""
ADD = """(pts) => { const W = __inkwell; const it = {t: 's', id: 'sred' + Math.random(), c: '#FF0000', w: 8, hl: 0, p: pts}; W.addItems([it]); }"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, accept_downloads=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        # real import of pages 1 and 3 of the file, so the page numbers are tested too
        await page.click('#insertBtn'); await page.wait_for_timeout(200)
        pdf = make_pdf()
        os.makedirs('/tmp/claude-0', exist_ok=True); P = '/tmp/claude-0/orig_test.pdf'; open(P, 'wb').write(pdf)
        await page.set_input_files('#importFile', P)
        await page.wait_for_function("!/^(Reading file|Turning)/.test(document.getElementById('impStatus').textContent) && !document.getElementById('impGo').disabled", timeout=30000); await page.wait_for_timeout(300)
        await page.fill('#impPages', '1,3'); await page.wait_for_timeout(150)
        await page.click('#impGo'); await page.wait_for_timeout(2500)
        docs = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.doc).sort((a, b) => a.y - b.y).map(i => ({pn: i.pn, x: i.x, y: i.y, w: i.w, h: i.h}))")
        check([d['pn'] for d in docs] == [0, 2], f'imported pages remember their page in the file ({docs})')
        d1 = docs[1]
        # red mark in the lower right of the second imported page (page 3 of the file)
        fx, fy = 0.75, 0.75; cx, cy = d1['x'] + d1['w'] * fx, d1['y'] + d1['h'] * fy
        await page.evaluate(ADD, [cx - 20, cy, .5, cx, cy, .5, cx + 20, cy, .5])
        await page.evaluate("() => __inkwell.exportPdfFile()"); await page.wait_for_function("__inkwell.Pdf.file", timeout=30000)
        # 0. whole page with a transparent background
        await page.evaluate("() => { const W = __inkwell; W.cur.bg = Object.assign({}, W.cur.bg, {type: 'grid', ml: 'blue', mx: 300}); W.addItems([{t: 's', id: 'fillp', c: 'paper', w: 1, hl: 0, fl: 1, p: [W.cur.items.size * 0 + 700, 100, .5, 900, 100, .5, 900, 300, .5, 700, 300, .5]}]); }")
        await page.wait_for_timeout(200); await page.evaluate("() => __inkwell.exportPdfFile()"); await page.wait_for_timeout(1500); await page.wait_for_function("__inkwell.Pdf.file", timeout=30000)
        BLUE = """async () => { const W = window.__inkwell; if(!window.pdfjsLib) await W.loadScript('lib/pdf.min.js');
          const pdf = await pdfjsLib.getDocument({data: await W.Pdf.file.arrayBuffer()}).promise, pg = await pdf.getPage(1), ops = await pg.getOperatorList(); return {imgs: ops.fnArray.filter(f => f === pdfjsLib.OPS.paintImageXObject || f === pdfjsLib.OPS.paintJpegXObject).length, n: ops.fnArray.length, name: W.Pdf.file.name}; }"""
        full = await page.evaluate(BLUE)
        check(await page.is_visible('#exportClearWrap') and await page.is_visible('#exportPrint'), 'switch shows for Whole page')
        await page.check('#exportClear'); await page.wait_for_timeout(1500); await page.wait_for_function("__inkwell.Pdf.file", timeout=30000)
        clr = await page.evaluate(BLUE)
        check(clr['imgs'] >= 1 and clr['imgs'] == full['imgs'] and clr['n'] < full['n'] and 'transparent' in clr['name'], f'imported pages stay, paper lines and fills go ({full}, {clr})')
        await page.click('#exportMode [data-m=ink]'); await page.wait_for_timeout(300)
        check(await page.is_hidden('#exportClearWrap'), 'switch only for Whole page')
        await page.click('#exportDlg [data-close]'); await page.wait_for_timeout(200)
        await page.evaluate("() => { const W = __inkwell; W.removeItems(['fillp']); W.exportPdfFile(); }"); await page.wait_for_timeout(1500); await page.wait_for_function("__inkwell.Pdf.file", timeout=30000)
        check(not await page.is_checked('#exportClear'), 'off again next time')
        # 1. only the writing
        await page.click('#exportMode [data-m=ink]'); await page.wait_for_timeout(1500); await page.wait_for_function("__inkwell.Pdf.file", timeout=30000)
        r = await page.evaluate(RENDER, {'layerOff': False})
        check(len(r['pages']) == 2 and 'only writing' in r['name'], f'only writing keeps one page per imported page ({len(r["pages"])}, {r["name"]})')
        check(r['pages'][1]['red'] > 50 and r['pages'][0]['red'] == 0, 'the writing is on its page')
        check(r['pages'][0]['any'] < 0.001 and r['pages'][1]['any'] < 0.02, f'background is transparent: no paper, no page picture ({r["pages"][0]["any"]}, {r["pages"][1]["any"]})')
        check(abs(r['pages'][1]['cx'] - fx) < .03 and abs(r['pages'][1]['cy'] - fy) < .03, f'in the right place ({r["pages"][1]["cx"]}, {r["pages"][1]["cy"]})')
        # 2. into the original
        await page.click('#exportMode [data-m=orig]'); await page.wait_for_timeout(300)
        check(await page.evaluate("document.getElementById('exportSave').disabled") and 'Choose' in await page.inner_text('#exportInfo'), 'asks for the file first')
        if os.environ.get('GSHOT'): await page.screenshot(path=os.environ['GSHOT'])
        wrong = '/tmp/claude-0/wrong_test.pdf'; open(wrong, 'wb').write(make_pdf(npages=1, tag='OTHER'))
        await page.set_input_files('#exportOrigFile', wrong); await page.wait_for_timeout(1000)
        check('right PDF' in await page.inner_text('#exportInfo') and await page.evaluate("document.getElementById('exportSave').disabled"), 'a file with too few pages is refused')
        await page.set_input_files('#exportOrigFile', P); await page.wait_for_timeout(800); await page.wait_for_function("__inkwell.Pdf.file", timeout=30000)
        r = await page.evaluate(RENDER, {'layerOff': False})
        check(len(r['pages']) == 3 and all(f'ORIGTEXT {i + 1}' in r['pages'][i]['text'] for i in range(3)), f'all 3 original pages with their real text ({[q["text"] for q in r["pages"]]})')
        check('with notes' in r['name'] and 'orig_test' in r['name'], f'file name ({r["name"]})')
        check(r['groups'] == ['Inkwell notes'], f'one layer called Inkwell notes ({r["groups"]})')
        q = r['pages'][2]
        check(q['red'] > 50 and r['pages'][0]['red'] == 0 and r['pages'][1]['red'] == 0, f'the writing lands on page 3 of the file ({[x["red"] for x in r["pages"]]})')
        check(abs(q['cx'] - fx) < .02 and abs(q['cy'] - fy) < .02, f'at the same spot ({q["cx"]}, {q["cy"]})')
        r2 = await page.evaluate(RENDER, {'layerOff': True})
        check(r2['pages'][2]['red'] == 0 and 'ORIGTEXT 3' in r2['pages'][2]['text'], f'layer off hides the writing only ({r2["pages"][2]["red"]})')
        # 3. a page shown turned in the file
        rot = '/tmp/claude-0/rot_test.pdf'
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        await page.evaluate("""async () => { const W = __inkwell; await W.loadScript('lib/pdf-lib.min.js');
          const d = await PDFLib.PDFDocument.create(); const pg = d.addPage([400, 600]); pg.setRotation(PDFLib.degrees(90)); const bytes = await d.save(); window.__rot = Array.from(bytes);
          W.addItems([{t: 'i', id: 'irot', x: 0, y: 0, w: 600, h: 400, a: 'none', doc: 1, pn: 0}, {t: 's', id: 'srot', c: '#FF0000', w: 8, hl: 0, p: [440, 90, .5, 460, 90, .5, 480, 90, .5]}]); }""")
        open(rot, 'wb').write(bytes(await page.evaluate("window.__rot")))
        await page.evaluate("() => __inkwell.exportPdfFile()"); await page.wait_for_timeout(600)
        await page.click('#exportMode [data-m=orig]'); await page.wait_for_timeout(200)
        await page.set_input_files('#exportOrigFile', rot); await page.wait_for_timeout(800); await page.wait_for_function("__inkwell.Pdf.file", timeout=30000)
        r = await page.evaluate(RENDER, {'layerOff': False}); q = r['pages'][0]
        check(q['w'] > q['h'] and abs(q['cx'] - .767) < .03 and abs(q['cy'] - .225) < .03, f'a turned page: the writing is where it was written ({q})')
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
