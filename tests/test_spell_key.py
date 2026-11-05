# 1.74: Ctrl+Space (and Ctrl+Tab where the browser passes it on) takes the first spelling suggestion.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
TEXT = "() => document.querySelector('.it-text[contenteditable=true]').textContent"
FIRST = "() => { const b = document.querySelector('#spellBar [data-fix]'); return b && !document.getElementById('spellBar').hidden ? b.dataset.fix : null; }"
PUT = """w => { const el = document.querySelector('.it-text[contenteditable=true]'), t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for(let n = t.nextNode(); n; n = t.nextNode()){ const i = n.data.indexOf(w); if(i >= 0){ const r = document.createRange(); r.setStart(n, i + 2); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } } return false; }"""
CTRLTAB = """() => { const el = document.querySelector('.it-text[contenteditable=true]'); const e = new KeyboardEvent('keydown', {key: 'Tab', code: 'Tab', ctrlKey: true, bubbles: true, cancelable: true}); el.dispatchEvent(e); return e.defaultPrevented; }"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.prefs.spell = true; __inkwell.prefs.spellLang = 'de-CH'; __inkwell.setTool('text'); }"); await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        await page.mouse.click(st[0] + 200, st[1] + 200); await page.wait_for_timeout(300)
        await page.keyboard.type('Ich gehe in die Schulle und das Hasu ist ruhig ')
        async def bar_for(w):
            for _ in range(240):
                await page.evaluate(PUT, w); await page.wait_for_timeout(250)
                f = await page.evaluate(FIRST)
                if f: return f
            return None
        f = await bar_for('Schulle')
        check(bool(f), f'bar shows a first suggestion ({f})')
        await page.keyboard.press('Control+Space'); await page.wait_for_timeout(300)
        t = await page.evaluate(TEXT)
        check('Schulle' not in t and f in t, f'Ctrl+Space takes it ({t})')
        check(await page.evaluate("document.getElementById('spellBar').hidden"), 'bar closes')
        f = await bar_for('Hasu')
        check(bool(f), f'bar for the second word ({f})')
        check(await page.evaluate(CTRLTAB), 'Ctrl+Tab is handled when it reaches the page')
        await page.wait_for_timeout(300)
        t = await page.evaluate(TEXT)
        check('Hasu' not in t and f in t and '\t' not in t, f'Ctrl+Tab takes it, no tab typed ({t})')
        # no bar: nothing is changed
        before = await page.evaluate(TEXT)
        await page.evaluate(PUT, 'ruhig'); await page.wait_for_timeout(300)
        check(await page.evaluate(CTRLTAB) is False, 'Ctrl+Tab with no suggestion is left to the browser')
        await page.keyboard.press('Control+Space'); await page.wait_for_timeout(200)
        check(await page.evaluate(TEXT) == before, 'text unchanged with no suggestion')
        await page.keyboard.press('Tab'); await page.wait_for_timeout(200)
        check('\t' in await page.evaluate(TEXT), 'plain Tab still types a tab')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('FAILED' if fails else 'all ok'); raise SystemExit(1 if fails else 0)
asyncio.run(main())
