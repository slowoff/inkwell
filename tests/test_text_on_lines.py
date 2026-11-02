# 1.73.6: text on ruled answer lines stays on them when its size changes (Rafael's screenshot: after making the text
# smaller, each row was a little taller than the ruling, so the text slid across the lines row by row).
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
# baselines (world px, from the top of the box) of every paragraph's text
BASE = """id => { const el = document.querySelector(`[data-id="${id}"]`), z = __inkwell.cam.z, top = el.getBoundingClientRect().top, out = [];
  el.querySelectorAll('p').forEach(p => { const m = document.createElement('span'); m.style.cssText = 'display:inline-block;width:0;height:0';
    const host = p.querySelector('span,font,b') || p; host.appendChild(m); out.push((m.getBoundingClientRect().bottom - top) / z); m.remove(); });
  return out; }"""
def steps(b): return [round(b[i+1] - b[i], 2) for i in range(len(b) - 1)]
HTML = lambda style: ''.join(f'<p><span style="{style}">Zeile {i} mit Text gypq</span></p>' for i in range(6))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.cam.ox = 60; __inkwell.cam.oy = 40; __inkwell.cam.z = 1; __inkwell.invalidate(1, 1, 1); }")
        await page.wait_for_timeout(200)
        LH = 41.2
        add = """([id, y, html, lh, fs]) => __inkwell.addItems([Object.assign({t: 'x', id, x: 20, y, w: 700, fs, html}, lh ? {lh} : {})])"""
        await page.evaluate(add, ['same', 10, HTML(''), LH, 1.5])
        ref = await page.evaluate(BASE, 'same')
        check(all(abs(s - LH) < 0.3 for s in steps(ref)), f'plain text: rows on the ruling {steps(ref)}')
        for name, style, y in [('smaller', 'font-size:15px', 300), ('bigger', 'font-size:34px', 300), ('tiny', 'font-size:9px', 300)]:
            await page.evaluate(add, [name, y, HTML(style), LH, 1.5])
            r = await page.evaluate(BASE, name)
            check(all(abs(s - LH) < 0.3 for s in steps(r)), f'{name} text: rows stay on the ruling {steps(r)}')
            check(all(abs(a - c) < 0.6 for a, c in zip(r, ref)), f'{name} text: same baselines as the box text (off by {max(abs(a - c) for a, c in zip(r, ref)):.2f})')
            await page.evaluate("id => { const el = document.querySelector(`[data-id=\"${id}\"]`); if(el) el.style.display = 'none'; }", name)
        # bold and marked parts on a line
        await page.evaluate(add, ['mix', 300, '<p>a <b>b</b> <mark>c</mark> <span style="font-size:12px">d</span></p><p>e</p><p>f <sup>2</sup></p>', LH, 1.5])
        h = await page.evaluate("document.querySelector('[data-id=mix]').offsetHeight")
        check(abs(h - (3 * LH + 4)) < 1, f'mixed styles and sup: 3 rows are exactly 3 ruled lines ({h})')
        # the real size menu on a real snapped-style box, whole box: row height stays
        await page.evaluate("id => document.querySelector(`[data-id=\"${id}\"]`).style.display = 'none'", 'mix')
        await page.evaluate(add, ['menu', 300, ''.join(f'<p>Zeile {i}</p>' for i in range(6)), LH, 1.5])
        await page.evaluate("""() => { const W = __inkwell, r = document.querySelector('[data-id=menu]').getBoundingClientRect(); W.setTool('text'); }""")
        r0 = await page.evaluate(BASE, 'menu')
        await page.evaluate("""async () => { const W = __inkwell, it = W.cur.items.get('menu');
          W.startEditing ? W.startEditing('menu') : startEditing('menu'); TSize.apply(14); await new Promise(f => setTimeout(f, 100)); }""")
        h2 = await page.evaluate("document.querySelector('[data-id=menu]').offsetHeight")
        check(abs(h2 - (6 * LH + 4)) < 1, f'size menu: 6 rows still 6 ruled lines ({h2})')
        r1 = await page.evaluate(BASE, 'menu')
        check(all(abs(a - c) < 0.6 for a, c in zip(r0, r1)), f'size menu: baselines stay ({steps(r1)})')
        await page.evaluate("finishEditing()")
        # html2canvas (PDF export) keeps the rows
        await page.evaluate("loadScript('lib/docx/html2canvas.min.js')"); await page.wait_for_timeout(300)
        rows = await page.evaluate("""async () => { const el = document.querySelector('[data-id=menu]'), box = el.cloneNode(true);
          box.style.cssText += ';transform:none;left:0;top:0;position:absolute;background:#fff;color:#000'; document.body.appendChild(box);
          const c = await html2canvas(box, {scale: 1, backgroundColor: '#fff', logging: false}); box.remove();
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, out = []; let on = false;
          for(let y = 0; y < c.height; y++){ let ink = false; for(let x = 0; x < c.width; x++) if(d[(y * c.width + x) * 4] < 120){ ink = true; break; }
            if(ink && !on) out.push(y); on = ink; } return out; }""")
        ok = len(rows) == 6 and all(abs((rows[i+1] - rows[i]) - LH) < 2 for i in range(5))
        check(ok, f'PDF export draws the rows on the ruling too ({rows})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('FAILED' if fails else 'all ok'); raise SystemExit(1 if fails else 0)
asyncio.run(main())
