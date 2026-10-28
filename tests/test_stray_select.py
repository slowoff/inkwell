# 1.69.2: iOS showed its Copy / Look Up / Translate bar at the top left while Rafael was writing (a text selection left
# somewhere else on the screen). Touching the page to write or move clears such a selection and leaves a focused field;
# a text box being typed in keeps its selection.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SEL = "(() => { const s = getSelection(); return [s.rangeCount ? s.toString() : '', document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '']; })()"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); document.getElementById('title').value = 'Power Grammatik'; }"); await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        cdp = await ctx.new_cdp_session(page)
        async def pen_stroke(x, y):
            for t, dx in (('mousePressed', 0), ('mouseMoved', 20), ('mouseMoved', 40), ('mouseReleased', 40)):
                await cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': st[0] + x + dx, 'y': st[1] + y + dx / 4, 'button': 'left', 'buttons': 0 if t == 'mouseReleased' else 1, 'clickCount': 1, 'pointerType': 'pen', 'force': 0.5})
                await page.wait_for_timeout(30)
            await page.wait_for_timeout(200)

        # 1. the page title is selected (focused, all text marked), then the Pencil writes on the page
        await page.evaluate("(() => { const t = document.getElementById('title'); t.focus(); t.select(); })()")
        r = await page.evaluate(SEL)
        check(r[1] == 'title', f'title focused and selected first ({r})')
        n0 = await page.evaluate("__inkwell.cur.items.size")
        await pen_stroke(400, 300)
        r = await page.evaluate(SEL)
        n1 = await page.evaluate("__inkwell.cur.items.size")
        check(r[1] != 'title', f'writing leaves the title ({r})')
        check(n1 == n0 + 1, f'the stroke is still written ({n0} -> {n1})')
        check(await page.evaluate("document.getElementById('title').value") == 'Power Grammatik', 'title text kept')

        # 2. words selected outside the page (non-editable text), then a finger moves the page
        await page.evaluate("""(() => { const el = document.createElement('div'); el.id = 'strayText'; el.textContent = 'Rechtsnorm Rechtsordnung'; el.style.cssText = 'position:fixed;left:0;top:0;user-select:text;-webkit-user-select:text'; document.body.appendChild(el);
          const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()""")
        r = await page.evaluate(SEL)
        check(len(r[0]) > 0, f'some text selected first ({r[0]!r})')
        await page.touchscreen.tap(st[0] + 600, st[1] + 400); await page.wait_for_timeout(200)
        r = await page.evaluate(SEL)
        check(r[0] == '', f'touching the page clears it ({r[0]!r})')

        # 3. the hidden paste field (top left corner) focused: writing leaves it
        await page.evaluate("(() => { const c = document.getElementById('pasteCatch'); c.value = 'x'; c.focus(); c.select(); })()")
        await pen_stroke(400, 420)
        r = await page.evaluate(SEL)
        check(r[1] != 'pasteCatch', f'writing leaves the hidden paste field ({r})')

        # 4. a text box being typed in keeps its own selection when tapped inside
        await page.evaluate("__inkwell.setTool('text')")
        await page.mouse.click(st[0] + 300, st[1] + 550); await page.wait_for_timeout(300)
        await page.keyboard.type('Rechtsordnung Grundzuege'); await page.wait_for_timeout(100)
        await page.keyboard.press('Shift+Home'); await page.wait_for_timeout(100)
        r1 = await page.evaluate(SEL)
        box = await page.evaluate("(() => { const e = document.querySelector('#worldFront .it-text[contenteditable=\"true\"]') || document.activeElement; const q = e.getBoundingClientRect(); return [q.left, q.top, q.width, q.height]; })()")
        await page.mouse.move(box[0] + 5, box[1] + box[3] / 2); await page.mouse.down(); await page.mouse.up(); await page.wait_for_timeout(150)
        r2 = await page.evaluate("(() => [document.activeElement && document.activeElement.isContentEditable])()")
        check('Rechtsordnung' in r1[0], f'text in the box selected ({r1})')
        check(r2[0], 'the box being typed in stays in editing after a tap inside')
        check(not errs, 'no page errors: ' + '; '.join(errs[:3]))
        await b.close()
    if fails: raise SystemExit(1)
    print('ALL OK')
asyncio.run(main())
