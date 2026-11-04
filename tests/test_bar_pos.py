# 1.81: Settings -> Top bar position.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
R = """() => { const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return {l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height}; };
  const S = __inkwell; return {bar: r('.bar1'), tools: r('.bar2'), stage: r('#stage'), side: r('#main'), ask: r('#askBtn'), paper: r('#paperBtn'), lbl: getComputedStyle(document.querySelector('#paperBtn .lbl')).display}; }"""
SHOT = os.environ.get('GSHOT')
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.click('#sideBtn'); await page.wait_for_timeout(300)
        async def setpos(v):
            await page.click('#settingsBtn') if await page.is_visible('#settingsBtn') else await page.evaluate("document.getElementById('settingsBtn').click()")
            await page.wait_for_selector('#settingsDlg', state='visible')
            await page.click(f'#setBar [data-v={v}]'); await page.wait_for_timeout(200)
            check(await page.evaluate(f"document.querySelector('#setBar [data-v={v}]').classList.contains('on')"), f'{v}: chosen in Settings')
            await page.click('#settingsDlg [data-close]'); await page.wait_for_timeout(400)
        d0 = await page.evaluate(R)
        check(d0['bar']['b'] <= d0['tools']['t'] + 1, 'default: on top')
        for v in ('bottom', 'left', 'right', 'top'):
            await page.evaluate("document.getElementById('settingsBtn').click()")
            await page.wait_for_selector('#settingsDlg', state='visible')
            await page.click(f'#setBar [data-v={v}]'); await page.wait_for_timeout(200)
            await page.click('#settingsDlg [data-close]'); await page.wait_for_timeout(500)
            d = await page.evaluate(R)
            st = d['stage']; bar = d['bar']
            T = d['tools']
            ok = {'bottom': bar['t'] >= st['b'] - 1 and T['t'] >= st['b'] - 1, 'left': bar['r'] <= st['l'] + 1 and T['r'] <= st['l'] + 1, 'right': bar['l'] >= st['r'] - 1 and T['l'] >= st['r'] - 1, 'top': bar['b'] <= T['t'] + 1 and T['b'] <= st['t'] + 1}[v]
            check(ok and st['w'] > 300 and st['h'] > 300, f'{v}: bar in place, page beside it ({bar}, {st})')
            # drawing surface matches the stage
            cv = await page.evaluate("(() => { const c = document.getElementById('ink').getBoundingClientRect(); return [c.width, c.height]; })()")
            check(abs(cv[0] - st['w']) < 2 and abs(cv[1] - st['h']) < 2, f'{v}: ink layer fits the stage ({cv})')
            if v in ('left', 'right'):
                for q in ('#undo', '#redo', '#swatches', '.tools'):
                    ok2 = await page.evaluate("s => { const b = document.querySelector(s).getBoundingClientRect(); return b.width > 0 && b.top >= 0 && b.bottom <= innerHeight; }", q)
                    check(ok2, f'{v}: {q} always on screen')
                check(await page.is_hidden('#paperBtn') and await page.is_hidden('#title'), f'{v}: the rest is tucked away')
                if v in ('left', 'right'):
                    q = await page.evaluate("""() => { const r = s => document.querySelector(s).getBoundingClientRect(); const u = r('#undo'), m = r('#barMore'), p = r('[data-tool=pen]'), k = r('[data-tool=mark]'), sw = r('#swatches .swatch'); return {u: u.right, m: m.right, p: p.right, k: k.right, sw: sw.right, bottom: sw.bottom, W: innerWidth}; }""")
                    lq = await page.evaluate("(() => { const r = s => document.querySelector(s).getBoundingClientRect().left; return {u: r('#undo'), p: r('[data-tool=pen]'), sw: r('#swatches .swatch'), m: r('#main')}; })()")
                    check((q['W'] - q['u'] < 20 and q['W'] - q['p'] < 20 and q['W'] - q['sw'] < 20) if v == 'right' else (lq['u'] - lq['m'] < 20 and lq['p'] - lq['m'] < 20 and lq['sw'] - lq['m'] < 20), f'{v}: undo, pen and first colour by the edge ({q}, {lq})')
                    er = await page.evaluate("(() => { const r = s => document.querySelector(s).getBoundingClientRect(); return {pen: r('[data-tool=pen]').bottom, hl: r('[data-tool=hl]').bottom, er: r('[data-tool=eraser]').bottom, redo: r('#redo').bottom, more: r('#barMore').top, hide: r('#sideBtn').top, w: r('#toolbar').width, stage: r('#stage').width}; })()")
                    check(er['er'] < 170 and er['redo'] < 60 and er['w'] <= 113, f'{v}: undo, redo, pen, highlighter, eraser in the top corner; narrow ({er})')
                    check(er['more'] > 700 and er['hide'] > 700, f'{v}: menu and hide at the foot ({er})')
                    for tool in ('lasso', 'text', 'eraser', 'pen'):
                        await page.evaluate(f"__inkwell.setTool('{tool}')"); await page.wait_for_timeout(150)
                        if SHOT: await page.screenshot(path=f'{SHOT}-{v}-{tool}.png')
                        cl = await page.evaluate("(() => { const T = document.getElementById('toolbar'), b = T.getBoundingClientRect(), f = document.getElementById('barMore').getBoundingClientRect(); return [...T.querySelectorAll('button,input')].filter(e => e.offsetWidth).some(e => { const q = e.getBoundingClientRect(); return q.left < b.left - 1 || q.right > b.right + 1; }); })()")
                        check(not cl, f'{v}: nothing cut off sideways with {tool}')
                    w0 = await page.evaluate("document.getElementById('stage').getBoundingClientRect().width")
                    await page.click('#sideBtn'); await page.wait_for_timeout(300); await page.click('#sideBtn'); await page.wait_for_timeout(300)
                    w0 = await page.evaluate("document.getElementById('stage').getBoundingClientRect().width")
                    await page.click('#barMore'); await page.wait_for_timeout(150)
                    check(await page.is_visible('#barHide') and await page.evaluate("document.getElementById('barHide').parentElement.id") == 'barExtra', f'{v}: hide arrow in the panel')
                    if SHOT: await page.screenshot(path=f'{SHOT}-{v}-panel2.png')
                    await page.click('#barHide'); await page.wait_for_timeout(300)
                    w1 = await page.evaluate("document.getElementById('stage').getBoundingClientRect().width")
                    check(w1 > w0 + 100 and await page.is_hidden('#toolbar') and await page.is_visible('#barShow'), f'{v}: hide gives the page the room, handle shows ({w0}, {w1})')
                    if SHOT: await page.screenshot(path=f'{SHOT}-{v}-hidden.png')
                    await page.reload(); await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000); await page.wait_for_timeout(600)
                    check(await page.is_hidden('#toolbar'), f'{v}: stays hidden after a reload')
                    await page.click('#barShow'); await page.wait_for_timeout(300)
                    check(await page.is_visible('#toolbar') and await page.is_hidden('#barShow'), f'{v}: handle brings it back')
                    if SHOT: await page.screenshot(path=f'{SHOT}-{v}-full.png')
                await page.click('#barMore'); await page.wait_for_timeout(200)
                pn = await page.evaluate("(() => { const b = document.getElementById('barExtra').getBoundingClientRect(); return {l: b.left, r: b.right, t: b.top, b: b.bottom}; })()")
                check(pn['b'] <= 820 and pn['l'] >= 0 and pn['r'] <= 1180 and (pn['l'] >= bar['r'] or pn['r'] <= bar['l']), f'{v}: panel beside the column ({pn})')
                d = await page.evaluate(R)
                check(d['lbl'] != 'none' and d['paper']['w'] > 120, f'{v}: panel has labels ({d["lbl"]}, {d["paper"]["w"]})')
                if SHOT: await page.screenshot(path=f'{SHOT}-{v}-panel.png')
            await page.click('#paperBtn'); await page.wait_for_timeout(200)
            pop = await page.evaluate("(() => { const b = document.getElementById('paperPop').getBoundingClientRect(); return {l: b.left, t: b.top, r: b.right, b: b.bottom}; })()")
            inside = pop['l'] >= 0 and pop['r'] <= 1180 and pop['t'] >= 0 and pop['b'] <= 820
            over = any(pop['l'] < q['r'] - 1 and pop['r'] > q['l'] + 1 and pop['t'] < q['b'] - 1 and pop['b'] > q['t'] + 1 for q in (bar, d['tools'])) if v not in ('left', 'right') else pop['l'] < pn['r'] - 1 and pop['r'] > pn['l'] + 1
            check(inside and (v == 'top' or not over), f'{v}: menu on screen and not over the bars ({pop})')
            if SHOT: await page.screenshot(path=f'{SHOT}-{v}.png')
            for tool in ('pen', 'lasso', 'text', 'eraser', 'hl'):
                await page.evaluate(f"__inkwell.setTool('{tool}')"); await page.wait_for_timeout(120)
                over = await page.evaluate("(() => { const b = document.getElementById('toolbar'); return b.scrollWidth - b.clientWidth; })()")
                check(over <= 1, f'{v}: {tool} options fit across ({over})')
                if SHOT and v == 'left' and tool == 'lasso': await page.screenshot(path=f'{SHOT}-left-lasso.png')
            await page.evaluate("__inkwell.setTool('pen')")
            await page.mouse.click(st['l'] + 40, st['b'] - 40); await page.wait_for_timeout(200)
            if v in ('left', 'right'):
                check(await page.is_hidden('#paperBtn'), f'{v}: tapping the page closes the panel')
                await page.click('#barMore'); await page.click('#calcBtn'); await page.wait_for_timeout(200)
                check(await page.is_hidden('#barExtra'), f'{v}: a button without a menu closes the panel')
                await page.evaluate("document.getElementById('calcBtn').click()"); await page.wait_for_timeout(150)
            if v == 'left':
                # writes where the pen is
                await page.evaluate("async () => { __inkwell.setTool('pen'); }")
                n0 = await page.evaluate("__inkwell.cur.items.size")
                X, Y = st['l'] + 300, st['t'] + 300
                await page.mouse.move(X, Y); await page.mouse.down(); await page.mouse.move(X + 60, Y + 20, steps=6); await page.mouse.up(); await page.wait_for_timeout(300)
                w = await page.evaluate("""([X, Y]) => { const W = __inkwell, it = [...W.cur.items.values()].at(-1), s = document.getElementById('stage').getBoundingClientRect(); return [it.p[0] * W.cam.z + W.cam.ox + s.left - X, it.p[1] * W.cam.z + W.cam.oy + s.top - Y]; }""", [X, Y])
                check(abs(w[0]) < 3 and abs(w[1]) < 3, f'left: ink lands under the pen ({w})')
            if v == 'right':
                await page.reload(); await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000); await page.wait_for_timeout(600)
                check(await page.evaluate("document.getElementById('main').dataset.bar") == 'right', 'kept after a reload')
                if await page.evaluate("getComputedStyle(document.querySelector('.side')).display") != 'none' : pass
        await page.set_viewport_size({'width': 390, 'height': 800}); await page.evaluate("__inkwell.prefs.barPos = 'left'; document.getElementById('main').dataset.bar = 'left'"); await page.wait_for_timeout(400)
        c = await page.evaluate("getComputedStyle(document.getElementById('main')).display")
        check(c != 'grid', f'phone-sized: side position is not used ({c})')
        await page.set_viewport_size({'width': 1180, 'height': 820}); await page.evaluate("__inkwell.prefs.barPos = 'left'; __inkwell.prefs.barCol = false; applyBarPos(); __inkwell.cur.bg = Object.assign({}, __inkwell.cur.bg); delete __inkwell.cur.bg.ml"); await page.wait_for_timeout(400)
        await page.click('#barMore'); await page.click('#paperBtn'); await page.wait_for_timeout(200)
        await page.click('#mlOn'); await page.wait_for_timeout(250)
        pb = await page.evaluate("(() => { const b = document.getElementById('paperPop').getBoundingClientRect(); return [b.top, b.bottom, document.getElementById('main').getBoundingClientRect().bottom]; })()")
        check(pb[1] <= pb[2] and pb[0] >= 0, f'menu that grows while open stays on screen ({pb})')
        check(await page.is_visible('#paperDefault') , 'last button of the menu reachable')
        await page.mouse.click(900, 700); await page.wait_for_timeout(150)
        await page.set_viewport_size({'width': 1180, 'height': 420}); await page.wait_for_timeout(300)
        await page.click('#barMore'); await page.click('#paperBtn'); await page.wait_for_timeout(200)
        pb = await page.evaluate("(() => { const p = document.getElementById('paperPop'), b = p.getBoundingClientRect(); return [b.top, b.bottom, innerHeight, p.scrollHeight > p.clientHeight]; })()")
        check(pb[0] >= 0 and pb[1] <= pb[2] and pb[3], f'menu taller than the screen scrolls ({pb})')
        await page.mouse.click(900, 300); await page.wait_for_timeout(150)
        await page.set_viewport_size({'width': 1180, 'height': 820}); await page.evaluate("__inkwell.prefs.barPos = 'top'; __inkwell.prefs.barCol = false; applyBarPos()"); await page.wait_for_timeout(300)
        order = await page.evaluate("(() => { const r = s => document.querySelector(s).getBoundingClientRect().left; return [r('#sideBtn'), r('#title'), r('#undo'), r('#insertBtn')]; })()")
        check(order == sorted(order) and await page.is_hidden('#barHide'), f'back on top: same order as before ({order})')
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
