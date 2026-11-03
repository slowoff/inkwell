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
        bl = await page.evaluate("md => JSON.stringify(__inkwell.answerBlocks(md))", MD)
        check('Parabola' not in bl and 'End.' in bl, 'Put on page leaves graphs out')
        await page.locator('#gt').screenshot(path=os.environ.get('GSHOT', '/tmp/claude-0/gt.png'))
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
