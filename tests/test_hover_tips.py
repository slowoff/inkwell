# 2.4: with a mouse/trackpad, resting on a button shows a card with its name, a short description and the shortcut.
# Touch and Pencil never show it; the native title is held back while the card is up and put back afterwards.
import asyncio, os
from playwright.async_api import async_playwright

PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

TIP = "(() => { const t = document.getElementById('tip'); if(!t || t.hidden) return null; const r = t.getBoundingClientRect(); return {t: (t.querySelector('.tip-t')||{}).textContent, d: (t.querySelector('.tip-d')||{}).textContent || '', k: (t.querySelector('.tip-k')||{}).textContent || '', l: r.left, r: r.right, top: r.top, b: r.bottom, w: innerWidth, h: innerHeight}; })()"

async def ready(pg):
    await pg.goto(URL)
    await pg.wait_for_function('navigator.serviceWorker.controller', timeout=15000)
    await pg.wait_for_timeout(2500)

async def hover(pg, sel, wait=700):
    await pg.hover(sel); await pg.wait_for_timeout(wait)
    return await pg.evaluate(TIP)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await ready(pg)
        await pg.evaluate("__inkwell.setTool('pen')"); await pg.wait_for_timeout(200)

        t = await hover(pg, '[data-tool="pen"]')
        check(t and t['t'] == 'Pen' and 'pressure' in t['d'] and t['k'] == 'P', f'pen: title, description and shortcut ({t})')
        check(t and t['l'] >= 0 and t['r'] <= t['w'] and t['top'] >= 0 and t['b'] <= t['h'], f'card stays on screen ({t})')
        check(await pg.evaluate("!document.querySelector('[data-tool=\"pen\"]').hasAttribute('title')"), 'native title held back while the card shows')
        t = await hover(pg, '[data-tool="hl"]', 120)
        check(t and t['t'] == 'Highlighter' and t['k'] == 'H', f'moving to the next button switches at once ({t})')
        check(await pg.evaluate("document.querySelector('[data-tool=\"pen\"]').title") == 'Pen (P)', 'title put back on the button left')
        # a button with only a title "Name: what it does" is split into title + description
        await pg.evaluate("const x = document.createElement('button'); x.id = 'tipProbe'; x.title = 'Probe: does a thing (Q)'; x.textContent = '?'; x.style.cssText = 'position:fixed;left:600px;top:400px;z-index:9999'; document.body.appendChild(x)")
        t = await hover(pg, '#tipProbe')
        check(t and t['t'] == 'Probe' and t['d'] == 'Does a thing' and t['k'] == 'Q', f'title attribute parsed ({t})')
        # clicking hides it
        await pg.mouse.down(); await pg.mouse.up(); await pg.wait_for_timeout(100)
        check(await pg.evaluate(TIP) is None, 'pressing hides the card')
        # leaving to empty space hides it
        t = await hover(pg, '#sideBtn')
        await pg.mouse.move(600, 600); await pg.wait_for_timeout(200)
        check(t and await pg.evaluate(TIP) is None, 'moving off the button hides the card')
        # every tool in the bar gets a card with a description
        for tool in ['hl', 'eraser', 'lasso', 'text', 'math', 'tape', 'space', 'mark']:
            await pg.mouse.move(5, 790); await pg.wait_for_timeout(400)
            t = await hover(pg, f'[data-tool="{tool}"]')
            check(t and t['t'] and t['d'], f'{tool}: card with description ({t})')
        check(not errs, f'no page errors {errs}')
        await ctx.close()

        # touch / Pencil: never
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        pg = await ctx.new_page()
        await ready(pg)
        for ptype in ('touch', 'pen'):
            await pg.evaluate(f"(() => {{ const el = document.querySelector('[data-tool=\"pen\"]'); el.dispatchEvent(new PointerEvent('pointerover', {{bubbles: true, pointerType: '{ptype}'}})); }})()")
            await pg.wait_for_timeout(700)
            check(await pg.evaluate(TIP) is None, f'{ptype}: no card')
        await ctx.close()
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
