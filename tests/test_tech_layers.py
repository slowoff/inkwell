# 2.0 stage 4: layers on technical pages (Drawing, Dimensions, Wiring, Notes) and the Claude robotics helper flag.
import asyncio, os, json
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
MM = 96 / 25.4
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        sent = []
        async def ask(route):
            sent.append(json.loads(route.request.post_data or '{}'))
            sse = 'data: ' + json.dumps({'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'Looks buildable.'}}) + '\n\n'
            await route.fulfill(status=200, headers={'Content-Type': 'text/event-stream', 'x-ask-model': 'claude-sonnet-5-5'}, body=sse)
        await ctx.route('**/functions/v1/ask', ask)
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500); await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate("async () => { const W = __inkwell; await W.newPage(); W.setTool('pen'); }")
        check(await page.evaluate("document.getElementById('layerBtn').hidden"), 'normal notebook: no Layers button')
        await page.evaluate("""() => { const W = __inkwell, pg = W.docs.get(W.cur.id), s = W.docs.get(pg.data.sec); W.docs.get(s.data.nb).data.tech = true;
            W.prefs.techSnap = 0; W.prefs.techLayer = 'd'; W.cam.z = 1; W.cam.ox = 0; W.cam.oy = 0; W.setTool('pen'); W.invalidate(); }""")
        check(not await page.evaluate("document.getElementById('layerBtn').hidden"), 'technical page: Layers button')
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        async def drag(pts):
            await page.mouse.move(st[0] + pts[0][0], st[1] + pts[0][1]); await page.mouse.down()
            for x, y in pts[1:]: await page.mouse.move(st[0] + x, st[1] + y, steps=6)
            await page.mouse.up(); await page.wait_for_timeout(250)
        # rectangle on Drawing, dimension on Dimensions (by itself)
        await page.evaluate("__inkwell.startPick({kind: 'shape', shape: 'rect'})")
        await drag([(100, 200), (200, 260), (300, 300)])
        await page.evaluate("__inkwell.startPick({kind: 'shape', shape: 'dim'})")
        await drag([(100, 200), (200, 190), (300, 200)])
        lys = await page.evaluate("[...__inkwell.cur.items.values()].reduce((o, i) => (o[i.ly || 'd'] = (o[i.ly || 'd'] || 0) + 1, o), {})")
        check(lys.get('d') == 1 and lys.get('m', 0) >= 5, f'rectangle on Drawing, dimension on Dimensions ({lys})')
        # choose Wiring in the popover, draw: goes on Wiring
        await page.evaluate("__inkwell.setTool('pen'); document.getElementById('layerBtn').click()"); await page.wait_for_timeout(150)
        rows = await page.evaluate("document.querySelectorAll('#layerList .layer-row').length")
        check(rows == 4, f'four layers listed ({rows})')
        await page.evaluate("document.querySelector('#layerList [data-ly=\"w\"]').click(); closePops()")
        await drag([(120, 450), (200, 470), (280, 455)])
        w = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.ly === 'w').length")
        check(w == 1, f'new stroke goes on Wiring ({w})')
        # hide Dimensions
        await page.evaluate("document.getElementById('layerBtn').click()"); await page.wait_for_timeout(100)
        await page.evaluate("document.querySelector('#layerList [data-eye=\"m\"]').click()"); await page.wait_for_timeout(300)
        hide = await page.evaluate("__inkwell.docs.get(__inkwell.cur.id).data.lyHide")
        check(hide == ['m'], f'hidden layers saved with the page ({hide})')
        txt_hidden = await page.evaluate("(() => { const t = [...__inkwell.cur.items.values()].find(i => i.t === 'x' && i.ly === 'm'); const el = document.querySelector(`[data-id=\"${t.id}\"]`); return getComputedStyle(el).display === 'none'; })()")
        check(txt_hidden, 'the dimension number disappears')
        await page.evaluate("closePops(); __inkwell.setTool('lasso'); __inkwell.prefs.lassoMode = 'box'")
        await drag([(60, 150), (300, 400), (380, 520)])
        selly = await page.evaluate("(__inkwell.sel ? __inkwell.sel.ids : []).map(id => __inkwell.cur.items.get(id).ly || 'd').sort().join(',')")
        check('m' not in selly and 'd' in selly, f'hidden layer is not selected ({selly})')
        await page.evaluate("__inkwell.clearSel && 0")
        # eraser passes over the hidden dimension line: it stays
        await page.evaluate("__inkwell.setTool('eraser'); __inkwell.prefs.eraser.mode = 'stroke'")
        dline_y = await page.evaluate("(() => { const d = [...__inkwell.cur.items.values()].find(i => i.dim); return d.p[1]; })()")
        n_before = await page.evaluate("__inkwell.cur.items.size")
        await drag([(110, dline_y), (200, dline_y), (290, dline_y)])
        n_dim = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.ly === 'm').length")
        check(n_dim >= 5, f'eraser leaves the hidden layer alone ({n_dim})')
        # drawing on a hidden layer shows it again
        await page.evaluate("__inkwell.prefs.techLayer = 'm'; __inkwell.setTool('pen')")
        await drag([(400, 450), (450, 470), (500, 455)])
        hide = await page.evaluate("__inkwell.docs.get(__inkwell.cur.id).data.lyHide")
        check(hide == [], f'drawing on a hidden layer shows it again ({hide})')
        await page.evaluate("__inkwell.prefs.techLayer = 'd'")
        # Claude: Robotics tag and tech flag on technical pages
        await page.evaluate("""() => { const W = __inkwell; W.Sync.sb = W.Sync.sb || {}; W.Sync.sb.auth = {getSession: async () => ({data: {session: {access_token: 'tok'}}})}; W.Ask.open(); }""")
        check(await page.evaluate("!document.getElementById('askTech').hidden"), 'Claude panel shows the Robotics tag')
        await page.fill('#askIn', 'Can a SG90 lift this arm?'); await page.click('#askSend'); await page.wait_for_timeout(800)
        check(sent and sent[-1].get('tech') == 1, f'request marks the technical notebook ({sent[-1].get("tech") if sent else None})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
