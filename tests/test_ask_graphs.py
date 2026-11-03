# 1.77: tables and graphs in Claude's answers; graphs stay out of "Put on page".
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
MD = r'''Intro with $x^2$.

| Before | After |
|---|---|
| **a** | $b$ |
| <img src=x> | d |

```graph
{"type":"function","title":"Parabola","x":[-3,3],"xlabel":"x","series":[{"label":"f","fn":"x^2-2"},{"label":"g","fn":"tan(x)"}]}
```

```graph
{"type":"line","series":[{"label":"v","points":[[0,0],[1,2],[2,1]],"dots":true}]}
```

```graph
{"type":"bar","title":"Bars","labels":["A","<b>B</b>"],"values":[3,-5]}
```

```graph
{broken
```

Not a table | just a pipe.

End.'''
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        h = await page.evaluate("md => __inkwell.renderMd(md)", MD)
        await page.evaluate("""h => { const d = document.createElement('div'); d.id = 'gt'; d.className = 'am bot'; d.style = 'position:fixed;left:0;top:0;width:420px;height:800px;overflow:auto;background:#fff;z-index:99'; d.innerHTML = h; document.body.append(d); }""", h)
        q = lambda s: page.evaluate("s => document.querySelectorAll('#gt ' + s).length", s)
        check(await q('table') == 1 and await q('th') == 2 and await q('tbody tr') == 2, 'one table, 2 columns, 2 rows')
        check(await q('td b') == 1 and await q('td .katex') == 1, 'bold and maths work in cells')
        check(await q('td img') == 0 and await q('.gr-lbl b') == 0, 'html in the answer is not run')
        check(await q('svg') == 2 and await q('path.gr-l') == 3, 'function and line graphs drawn')
        check(await q('circle') == 3, 'dots on the points')
        check(await q('.gr-row') == 2 and await q('.gr-track i.neg') == 1 and await q('canvas') == 0, 'bars are divs')
        check(await q('.graph-err') == 1, 'broken graph says so')
        t = await page.evaluate("() => document.getElementById('gt').innerText")
        check('"type"' not in t and 'just a pipe' in t, 'no JSON on show; a lone pipe stays text')
        d = await page.evaluate("() => { const p = document.querySelector('#gt path.gr-l').getAttribute('d'); return p.length; }")
        check(d > 500, 'curve has many points')
        wait = await page.evaluate("md => __inkwell.renderMd(md)", 'Hi\n\n```graph\n{"type":')
        check('Drawing graph' in wait and 'type' not in wait, 'half-arrived graph shows a waiting line')
        code = await page.evaluate("md => __inkwell.renderMd(md)", 'A\n\n```\n80 | *x*\n75 | y\n```\n\nB')
        check(code.count('<pre') == 1 and '```' not in code and '<i>' not in code and '80 | *x*\n75 | y' in code, 'code block stays one block')
        bl = await page.evaluate("md => JSON.stringify(__inkwell.answerBlocks(md))", MD)
        check(bl.count('"t":"g"') == 4 and 'End.' in bl, 'graphs are blocks for Put on page')
        # the Put on page path (the broken graph is left out)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        await page.evaluate("md => __inkwell.putAnswer(md)", MD); await page.wait_for_timeout(800)
        info = await page.evaluate("""async () => { const W = __inkwell, its = [...W.cur.items.values()].filter(i => i.t === 'i'); const out = [];
          for(const it of its){ const r = await W.IDB.get('assets', it.a), bm = await createImageBitmap(r.blob), c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0);
            const d = x.getImageData(0, 0, bm.width, bm.height).data; let blue = 0, white = 0, dark = 0;
            for(let i = 0; i < d.length; i += 4){ if(d[i] < 90 && d[i+1] > 100 && d[i+2] > 220) blue++; if(d[i] > 250 && d[i+1] > 250 && d[i+2] > 250) white++; if(d[i] < 120 && d[i+1] < 130 && d[i+2] < 140) dark++; }
            out.push({w: it.w, h: it.h, g: !!it.g, pw: bm.width, ph: bm.height, blue, white: white / (d.length / 4), dark}); }
          return out; }""")
        check(len(info) == 3 and all(i['g'] and abs(i['h'] / i['w'] - i['ph'] / i['pw']) < .01 for i in info), f'3 graph pictures on the page, right shape ({info})')
        check(all(i['blue'] > 200 and i['white'] > .4 and i['dark'] > 100 for i in info), 'pictures show blue ink, labels, white background')
        pdf = await page.evaluate("async () => { const W = __inkwell; await W.exportPdfFile(); return W.Pdf.file && W.Pdf.file.size; }")
        check(pdf and pdf > 3000, f'page with graphs exports to PDF ({pdf})')
        await page.evaluate("() => { const s = document.getElementById('gt'); s.remove(); }")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=os.environ.get('GSHOT2', '/tmp/claude-0/gt2.png'))
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
