# 1.91: (1) "Scan with Claude" button in the side column's tool grid (#askQuick); (2) Paste button for any tool right
# after a copy in Inkwell (#freshPaste, under the zoom % in the side column, after it on the top bar).
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

R = "s => { const e = document.querySelector(s); if(!e || e.hidden) return null; const b = e.getBoundingClientRect(); return b.width ? {l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height} : null; }"
VIS = "s => { const e = document.querySelector(s); return !!e && !e.hidden && e.getBoundingClientRect().width > 0; }"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=URL.rstrip('/'))
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        vis = lambda s: page.evaluate(f"({VIS})('{s}')")
        rect = lambda s: page.evaluate(f"({R})('{s}')")
        async def bar(v):
            await page.evaluate(f"(() => {{ __inkwell.prefs.barPos = '{v}'; applyBarPos(); }})()"); await page.wait_for_timeout(400)

        # ---- top bar: no extra Claude button (Ask Claude is in plain view there)
        check(not await vis('#askQuick'), 'top bar: no Scan with Claude button in the tools')
        check(await vis('#askBtn'), 'top bar: Ask Claude still in the bar')
        check(not await vis('#freshPaste'), 'nothing copied yet: no fresh Paste button')

        # ---- side column
        await bar('left')
        q, mark = await rect('#askQuick'), await rect('.tool[data-tool="mark"]')
        check(q and mark and abs(q['t'] - mark['t']) < 1 and q['l'] > mark['r'], f'left: Claude button next to Mark for later in the tool grid ({q}, {mark})')
        check(q and q['w'] >= 43.5 and q['h'] >= 43.5, 'left: Claude button is 44 px')
        tool0 = await page.evaluate("__inkwell.prefs.tool")
        await page.tap('#askQuick'); await page.wait_for_timeout(300)
        st = await page.evaluate("({pick: document.body.classList.contains('scanning'), panel: !document.getElementById('askPanel').hidden, tool: __inkwell.prefs.tool, bar: !document.getElementById('scanBar').hidden, bg: getComputedStyle(document.getElementById('askQuick')).backgroundColor})")
        check(st['pick'] and st['bar'] and st['panel'], f'tap: scanning starts straight away, Claude panel open ({st})')
        check(st['tool'] == tool0, 'tap: the drawing tool does not change')
        check(st['bg'] not in ('rgba(0, 0, 0, 0)', 'transparent'), f'button lit while scanning ({st["bg"]})')
        # draw the box: the scan is attached
        sr = await rect('#stage')
        x0, y0 = sr['l'] + 120, sr['t'] + 80
        await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x0 + 200, y0 + 120, steps=8); await page.mouse.up()
        await page.wait_for_timeout(1200)
        n = await page.evaluate("Array.isArray(__inkwell.Ask.pending) ? __inkwell.Ask.pending.length : 0")
        check(n == 1, f'box drawn: one scan attached to the question ({n})')
        check(not await page.evaluate("document.body.classList.contains('scanning')"), 'scanning ends after the box')
        # tap twice: stops; the panel was already open, so it stays
        await page.tap('#askQuick'); await page.wait_for_timeout(200); await page.tap('#askQuick'); await page.wait_for_timeout(200)
        st = await page.evaluate("({pick: document.body.classList.contains('scanning'), panel: !document.getElementById('askPanel').hidden})")
        check(not st['pick'] and st['panel'], f'second tap stops scanning, open panel stays ({st})')
        # from a closed panel with nothing attached: start + stop closes it again
        await page.evaluate("(() => { __inkwell.Ask.pending = null; __inkwell.Ask.renderPending(); __inkwell.Ask.close(); })()")
        await page.tap('#askQuick'); await page.wait_for_timeout(200)
        await page.tap('#askQuick'); await page.wait_for_timeout(200)
        st = await page.evaluate("({pick: document.body.classList.contains('scanning'), panel: !document.getElementById('askPanel').hidden, tool: __inkwell.prefs.tool})")
        check(not st['pick'] and not st['panel'] and st['tool'] == tool0, f'start + stop from a closed panel: panel closed again, tool unchanged ({st})')
        await bar('right')
        q, mark = await rect('#askQuick'), await rect('.tool[data-tool="mark"]')
        check(q and mark and abs(q['t'] - mark['t']) < 1 and q['r'] < mark['l'], f'right column: mirrored beside Mark for later ({q}, {mark})')
        await bar('left')

        # ---- fresh Paste
        await page.evaluate("async () => { const W = __inkwell; await W.newPage(); W.addItems([{t:'s', id:'s_q', c:'#C2362B', w:3, hl:0, p:[100,100,0.5, 160,130,0.6, 220,110,0.7]}]); await W.flushSaves(); }")
        await page.evaluate("__inkwell.setTool('lasso')"); await page.wait_for_timeout(100)
        check(await vis('#pasteBtn') and not await vis('#freshPaste'), 'Select tool, nothing copied: its own Paste button only')
        await page.evaluate("__inkwell.selectIds(['s_q'])"); await page.wait_for_selector('#selCopy', state='visible')
        await page.click('#selCopy'); await page.wait_for_timeout(500)
        check(await vis('#freshPaste') and not await vis('#pasteBtn'), 'after Copy: the fresh Paste shows, never two Paste buttons')
        z, fp = await rect('#zoomBtn'), await rect('#freshPaste')
        check(z and fp and fp['t'] >= z['b'] - 1 and fp['t'] - z['b'] < 30 and abs((fp['l'] + fp['r']) / 2 - (z['l'] + z['r']) / 2) < 2, f'left: under the zoom %, centred ({z}, {fp})')
        foot = await rect('#sideBtn')
        check(foot and fp['b'] <= foot['t'] - 4, f'clear of the buttons at the foot ({foot})')
        check(fp['h'] >= 43.5, 'fresh Paste is 44 px tall')
        for t in ('pen', 'eraser', 'text', 'math', 'tape', 'space', 'mark', 'hl'):
            await page.evaluate(f"__inkwell.setTool('{t}')"); await page.wait_for_timeout(60)
            if not await vis('#freshPaste'): check(False, f'fresh Paste shows with the {t} tool')
        check(True, 'fresh Paste shows with every tool')
        # paste with the pen tool on another page
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        await page.evaluate("__inkwell.setTool('pen')"); await page.wait_for_timeout(100)
        await page.tap('#freshPaste'); await page.wait_for_timeout(800)
        r = await page.evaluate("({n: __inkwell.cur.items.size, sel: __inkwell.sel ? __inkwell.sel.ids.length : 0, f: JSON.parse(localStorage.getItem('inkwell.fresh'))})")
        check(r['n'] == 1 and r['sel'] == 1, f'tap with the pen tool: pasted and selected ({r})')
        check(r['f'] and r['f']['used'] >= r['f']['at'], 'paste recorded')
        check(await vis('#freshPaste'), 'still there right after pasting (to paste again)')
        await page.tap('#freshPaste'); await page.wait_for_timeout(800)
        check(await page.evaluate("__inkwell.cur.items.size") == 2, 'paste again works')
        # one minute after the last paste it goes
        await page.evaluate("(() => { const f = JSON.parse(localStorage.getItem('inkwell.fresh')); f.used = Date.now() - 61000; f.at = f.used - 2000; localStorage.setItem('inkwell.fresh', JSON.stringify(f)); __inkwell.Fresh.render(); })()")
        check(not await vis('#freshPaste'), 'gone one minute after the last paste')
        await page.evaluate("__inkwell.setTool('lasso')"); await page.wait_for_timeout(60)
        check(await vis('#pasteBtn'), 'Select tool gets its own Paste back')
        # the timer hides it on its own
        await page.evaluate("(() => { localStorage.setItem('inkwell.fresh', JSON.stringify({at: Date.now() - 61000, used: Date.now() - 59400})); __inkwell.Fresh.render(); })()")
        check(await vis('#freshPaste'), 'shown again')
        await page.wait_for_timeout(1000)
        check(not await vis('#freshPaste'), 'timer hides it without a tap')
        # not pasted: 30 minutes
        await page.evaluate("(() => { localStorage.setItem('inkwell.fresh', JSON.stringify({at: Date.now() - 29 * 60000, used: 0})); __inkwell.Fresh.render(); })()")
        check(await vis('#freshPaste'), 'not pasted: still there after 29 minutes')
        await page.evaluate("(() => { localStorage.setItem('inkwell.fresh', JSON.stringify({at: Date.now() - 31 * 60000, used: 0})); __inkwell.Fresh.render(); })()")
        check(not await vis('#freshPaste'), 'not pasted: gone after 30 minutes')
        # other copies inside Inkwell count too: a copy event (text in a box, the title, the Claude panel)
        await page.evaluate("document.dispatchEvent(new ClipboardEvent('copy', {bubbles: true}))"); await page.wait_for_timeout(200)
        check(await vis('#freshPaste'), 'a copy event (e.g. text copied in a text box) shows it')
        # page text copy
        await page.evaluate("localStorage.removeItem('inkwell.fresh'); __inkwell.Fresh.render()")
        await page.evaluate("__inkwell.TS.copy ? __inkwell.TS.copy('some page text') : null"); await page.wait_for_timeout(300)
        ts = await page.evaluate("typeof __inkwell.TS.copy")
        if ts == 'function': check(await vis('#freshPaste'), 'page text copied: shows')
        # survives a reload while fresh
        await page.evaluate("__inkwell.Fresh.copied()")
        await page.reload(); await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000); await page.wait_for_timeout(1500)
        check(await vis('#freshPaste'), 'still there after the app restarts')
        # top bar: after the zoom %, bar still fits
        await bar('top')
        if await page.evaluate("document.querySelector('.side').getBoundingClientRect().width") > 10:
            await page.evaluate("document.getElementById('sideBtn').click()"); await page.wait_for_timeout(500)
        for t in ('pen', 'lasso', 'eraser', 'text'):
            await page.evaluate(f"__inkwell.setTool('{t}')"); await page.wait_for_timeout(300)
            s = await page.evaluate("(() => { const b = document.getElementById('toolbar'), r = b.getBoundingClientRect(), f = document.getElementById('freshPaste').getBoundingClientRect(); return {over: b.scrollWidth - b.clientWidth, fr: f.right, br: r.right, cls: b.className}; })()")
            check(s['over'] <= 1 and s['fr'] <= s['br'] + 0.5, f'top bar, notebooks closed, {t}: whole bar fits with the fresh Paste ({s})')
        await page.evaluate("__inkwell.setTool('pen')"); await page.wait_for_timeout(300)
        z, fp = await rect('#zoomBtn'), await rect('#freshPaste')
        over = await page.evaluate("(() => { const b = document.getElementById('toolbar'); return b.scrollWidth - b.clientWidth; })()")
        check(z and fp and fp['l'] >= z['r'] - 1 and abs(fp['t'] - z['t']) < 8, f'top bar: right after the zoom % ({z}, {fp})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    if fails: print(f'{len(fails)} FAILED'); raise SystemExit(1)
    print('all passed')
asyncio.run(main())
