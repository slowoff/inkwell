# 1.86: Movable export: PDF annotations and an SVG of separate objects.
import asyncio, io, os
from playwright.async_api import async_playwright
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
READ = """async ({mode}) => {
  const W = window.__inkwell; if(!window.pdfjsLib) await W.loadScript('lib/pdf.min.js');
  const pdf = await pdfjsLib.getDocument({data: await W.Pdf.file.arrayBuffer()}).promise, out = [];
  for(let i = 1; i <= pdf.numPages; i++){
    const pg = await pdf.getPage(i), vp = pg.getViewport({scale: 1.5}), an = await pg.getAnnotations();
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; const x = c.getContext('2d');
    await pg.render({canvasContext: x, viewport: vp, annotationMode: mode}).promise;
    const d = x.getImageData(0, 0, c.width, c.height).data; let red = 0, sx = 0, sy = 0, dark = 0;
    for(let k = 0; k < d.length; k += 4){ if(d[k] > 150 && d[k+1] < 90 && d[k+2] < 90){ red++; sx += (k / 4) % c.width; sy += Math.floor(k / 4 / c.width); } if(d[k] < 70 && d[k+1] < 70 && d[k+2] < 70) dark++; }
    out.push({an: an.map(a => ({t: a.subtype, s: a.contents || (a.contentsObj && a.contentsObj.str) || '', rect: a.rect, ink: a.inkLists && a.inkLists[0] && a.inkLists[0].length, bw: a.borderStyle && a.borderStyle.width, c: a.color && Array.from(a.color), o: a.opacity})), red, dark, cx: red ? sx / red / c.width : 0, cy: red ? sy / red / c.height : 0, h: vp.height / 1.5, w: vp.width / 1.5});
    if(i === 1 && mode && window.__shot !== undefined) window.__shot = c.toDataURL('image/png');
  }
  return {pages: out, name: W.Pdf.file.name, extra: W.Pdf.extra && W.Pdf.extra.name};
}"""
SVG = """async () => {
  const W = window.__inkwell, t = await W.Pdf.extra.text(), doc = new DOMParser().parseFromString(t, 'image/svg+xml');
  const root = doc.documentElement, ids = [...root.children].map(e => e.tagName + '#' + e.id);
  const u = URL.createObjectURL(new Blob([t], {type: 'image/svg+xml'})), img = new Image();
  await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = u; });
  const vb = root.getAttribute('viewBox').split(' ').map(Number), c = document.createElement('canvas'); c.width = 600; c.height = Math.round(600 * vb[3] / vb[2]);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data; let red = 0, sx = 0, sy = 0;
  for(let k = 0; k < d.length; k += 4) if(d[k] > 150 && d[k+1] < 90 && d[k+2] < 90){ red++; sx += ((k / 4) % c.width) / c.width * vb[2] + vb[0]; sy += Math.floor(k / 4 / c.width) / c.height * vb[3] + vb[1]; }
  return {err: !!doc.querySelector('parsererror'), ids, text: root.querySelector('text') && root.querySelector('text').textContent, tspans: root.querySelectorAll('tspan').length, locked: root.querySelector('image[id^=imported]') && root.querySelector('image[id^=imported]').getAttribute('sodipodi:insensitive'), red, cx: red ? sx / red : 0, cy: red ? sy / red : 0, name: W.Pdf.extra.name, type: W.Pdf.extra.type};
}"""
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
        buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=A4)
        for i in range(2): c.setFont('Helvetica', 20); c.drawString(72, A4[1] - 100, f'WORKSHEET {i + 1}'); c.showPage()
        c.save(); os.makedirs('/tmp/claude-0', exist_ok=True); P = '/tmp/claude-0/mov.pdf'; open(P, 'wb').write(buf.getvalue())
        await page.click('#insertBtn'); await page.wait_for_timeout(200)
        await page.set_input_files('#importFile', P)
        await page.wait_for_function("!/^(Reading file|Turning)/.test(document.getElementById('impStatus').textContent) && !document.getElementById('impGo').disabled", timeout=30000); await page.wait_for_timeout(200)
        await page.click('#impGo'); await page.wait_for_timeout(2500)
        docs = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.doc).sort((a, b) => a.y - b.y).map(i => ({x: i.x, y: i.y, w: i.w, h: i.h}))")
        d = docs[1]; cx, cy = d['x'] + d['w'] * .7, d['y'] + d['h'] * .6
        await page.evaluate("""([cx, cy, d]) => { const W = __inkwell; const line = (x, y) => { const p = []; for(let i = 0; i <= 20; i++) p.push(x + i * 4, y + Math.sin(i / 3) * 6, .5); return p; };
          W.addItems([{t: 's', id: 'red1', c: '#FF0000', w: 6, hl: 0, p: line(cx, cy)}, {t: 's', id: 'red2', c: '#FF0000', w: 6, hl: 0, p: line(cx, cy + 40)},
            {t: 's', id: 'hl1', c: '#F5C400', w: 18, hl: 1, p: line(cx, cy + 90)},
            {t: 'x', id: 'tx1', x: d.x + 60, y: d.y + 200, w: 300, fs: 1, html: '<h2>Grüezi Titel</h2><p>hello world &amp; more text that goes on so it wraps onto a second line surely</p><ul><li>punkt</li></ul>'},
            {t: 'm', id: 'mx1', x: d.x + 60, y: d.y + 420, fs: 22, c: 'auto', tex: 'x^2 + 1'}]); }""", [cx, cy, d])
        await page.wait_for_timeout(600)
        await page.evaluate("() => __inkwell.exportPdfFile()"); await page.wait_for_timeout(1000); await page.wait_for_function("__inkwell.Pdf.file", timeout=30000)
        await page.click('#exportMode [data-m=move]'); await page.wait_for_timeout(1500); await page.wait_for_function("__inkwell.Pdf.file && __inkwell.Pdf.extra", timeout=30000)
        if os.environ.get('GSHOT'): await page.screenshot(path=os.environ['GSHOT'] + '-dlg.png')
        check(await page.inner_text('#exportSave') == 'Save both' and await page.is_hidden('#exportPick') and await page.is_hidden('#exportClearWrap'), 'dialog: Save both, no page or transparent choices')
        r = await page.evaluate(READ, {'mode': 0})
        P2 = r['pages']; types = [a['t'] for a in P2[1]['an']]
        check(len(P2) == 2 and P2[0]['an'] == [] , f'imported pages kept, writing on its page ({len(P2)}, {len(P2[0]["an"])})')
        check(types.count('Ink') == 3 and types.count('FreeText') == 1 and types.count('Stamp') == 1, f'3 ink, 1 text, 1 stamp annotations ({types})')
        check(P2[1]['red'] == 0, f'with annotations off the page has no ink: nothing is fused ({P2[1]["red"]})')
        ft = [a for a in P2[1]['an'] if a['t'] == 'FreeText'][0]
        check('Grüezi Titel' in ft['s'] and 'hello world & more' in ft['s'] and '\u2022 punkt' in ft['s'] and 'more text' in ft['s'], f'text stays real text ({ft["s"]!r})')
        inks = [a for a in P2[1]['an'] if a['t'] == 'Ink']
        check(inks[0]['ink'] and inks[0]['ink'] > 10 and inks[-1]['bw'] and inks[-1]['bw'] > 0 , f'ink has its line and width ({inks[-1]})')
        hl = [a for a in inks if a['c'] and a['c'][2] < 60 and a['c'][0] > 200 and a['c'][1] > 150]
        r = await page.evaluate(READ, {'mode': 1}); q = r['pages'][1]
        check(q['red'] > 50 and abs(q['cx'] - .75) < .1 and abs(q['cy'] - .63) < .1, f'shows at the right spot ({q["red"]}, {q["cx"]}, {q["cy"]})')
        s = await page.evaluate(SVG)
        check(not s['err'] and s['name'].endswith('(movable).svg') and s['type'] == 'image/svg+xml', f'valid SVG ({s["err"]}, {s["name"]})')
        check(sum(i.startswith('path#') for i in s['ids']) == 3 and sum(i.startswith('text#') for i in s['ids']) == 1 and sum(i.startswith('image#formula') for i in s['ids']) == 1 and sum(i.startswith('image#imported') for i in s['ids']) == 2, f'separate top-level objects ({s["ids"]})')
        check('Grüezi Titel' in s['text'] and s['tspans'] >= 4, f'real text with its lines ({s["text"]!r}, {s["tspans"]})')
        check(s['locked'] == 'true', 'imported pages marked locked')
        check(s['red'] > 20 and abs(s['cx'] - (cx + 40)) < 25 and abs(s['cy'] - (cy + 20)) < 40, f'ink in the right place ({s["red"]}, {s["cx"]}, {s["cy"]}, want {cx + 40}, {cy + 20})')
        # other modes unchanged
        await page.click('#exportMode [data-m=page]'); await page.wait_for_timeout(1500); await page.wait_for_function("__inkwell.Pdf.file", timeout=30000)
        r = await page.evaluate(READ, {'mode': 0})
        check(r['pages'][1]['red'] > 50 and r['pages'][1]['an'] == [] and r['extra'] is None and await page.inner_text('#exportSave') == 'Save PDF', 'Whole page still fused, one file')
        # downloads both on a computer
        await page.click('#exportMode [data-m=move]'); await page.wait_for_timeout(1500); await page.wait_for_function("__inkwell.Pdf.file && __inkwell.Pdf.extra", timeout=30000)
        got = []
        page.on('download', lambda d: got.append(d.suggested_filename))
        await page.click('#exportSave'); await page.wait_for_timeout(1500)
        check(len(got) == 2 and got[0].endswith('.pdf') and got[1].endswith('.svg'), f'both files saved ({got})')
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
