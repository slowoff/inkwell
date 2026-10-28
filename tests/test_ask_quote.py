# 1.69.3: "> text" lines in Claude answers showed a raw ">" (seen on the iPad: "Als Satz:" followed by "> Die schweizerische Rechtsordnung ...").
# Now renderMd makes a <blockquote>; Put on page (answerBlocks) drops the marker.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

ANSWER = """**Als Satz:**
> Die schweizerische Rechtsordnung ist die Gesamtheit aller Rechtsnormen. Sie ist als Stufenbau aufgebaut (Verfassung, Gesetz, Verordnung).

**Idee dahinter:** Die Rechtsordnung ist ein geordnetes System, in dem $a > b$ gilt.

- Punkt eins
- Punkt zwei

> Erste Zeile
> zweite **fett**
>
> neuer Absatz
>> verschachtelt"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        r = await page.evaluate("""md => { const d = document.createElement('div'); d.className = 'am bot'; d.innerHTML = __inkwell.renderMd(md); document.body.appendChild(d);
            const qs = [...d.querySelectorAll('blockquote')];
            const cs = qs.length ? getComputedStyle(qs[0]) : null;
            return {qs: qs.map(q => ({ps: q.querySelectorAll('p').length, text: q.textContent, b: !!q.querySelector('b')})),
                    raw: (() => { const c = d.cloneNode(true); c.querySelectorAll('.katex').forEach(k => k.remove()); return /(^|\\n)\\s*>/.test(c.textContent) || c.textContent.includes('> Die'); })(), gt: d.innerHTML.includes('&gt; Die'), katex: !!d.querySelector('.katex'), lis: d.querySelectorAll('li').length,
                    border: cs && cs.borderLeftWidth, html: d.innerHTML.slice(0, 400)}; }""", ANSWER)
        check(len(r['qs']) == 2, f"two quote blocks ({r['qs']})")
        check(r['qs'] and r['qs'][0]['text'].startswith('Die schweizerische Rechtsordnung'), 'first quote holds the sentence without ">"')
        check(not r['raw'] and not r['gt'], f"no stray > shown ({r['html']})")
        check(len(r['qs']) == 2 and r['qs'][1]['ps'] == 2 and r['qs'][1]['b'], 'blank ">" line splits paragraphs, bold still works inside')
        check(len(r['qs']) == 2 and 'verschachtelt' in r['qs'][1]['text'] and '>' not in r['qs'][1]['text'], 'nested ">>" handled')
        check(r['katex'] and r['lis'] == 2, 'maths with ">" and lists still render')
        check(r['border'] == '3px', f"quote has the side bar ({r['border']})")
        # comparisons in normal text and maths are untouched
        r2 = await page.evaluate("() => __inkwell.renderMd('x > 3 means bigger').includes('x &gt; 3')")
        check(r2, 'a ">" inside a line stays as text')
        blocks = await page.evaluate("md => __inkwell.answerBlocks(md).map(b => b.html || b.tex)", ANSWER)
        joined = ' '.join(blocks)
        check('&gt; Die' not in joined and 'Die schweizerische' in joined, 'Put on page drops the ">" marker')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
