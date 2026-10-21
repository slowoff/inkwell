# 1.45: a hand next to the text box being typed in moves the box (mouse and finger); one undo step puts it back;
# the box stays open while it moves and the move survives a reload.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await page.evaluate("() => __inkwell.setTool('text')")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        await page.mouse.click(st[0] + 250, st[1] + 200); await page.wait_for_timeout(300)
        await page.keyboard.type('Move me'); await page.wait_for_timeout(200)
        g = await page.evaluate("(() => { const m = document.getElementById('tMove'); if(m.hidden) return null; const r = m.getBoundingClientRect(), t = document.querySelector('.it-text').getBoundingClientRect(); return {m: [r.left + r.width / 2, r.top + r.height / 2, r.right], t: [t.left, t.top]}; })()")
        check(g is not None, 'a hand shows next to the text box while typing')
        if g: check(g['m'][2] <= g['t'][0] + 2, 'the hand sits left of the box (not over the text)')
        it0 = await page.evaluate("(() => { const i = [...__inkwell.cur.items.values()].find(i => i.t === 'x'); return [i.x, i.y, i.id]; })()")
        z = await page.evaluate("__inkwell.cam.z")
        # mouse drag
        await page.mouse.move(g['m'][0], g['m'][1]); await page.mouse.down()
        for k in range(1, 11): await page.mouse.move(g['m'][0] + 12 * k, g['m'][1] + 8 * k)
        await page.mouse.up(); await page.wait_for_timeout(300)
        it1 = await page.evaluate("(() => { const i = [...__inkwell.cur.items.values()].find(i => i.t === 'x'); return [i.x, i.y]; })()")
        check(abs(it1[0] - it0[0] - 120 / z) < 1 and abs(it1[1] - it0[1] - 80 / z) < 1, f'mouse drag on the hand moves the box ({it0[:2]} -> {it1})')
        ed = await page.evaluate("!!document.querySelector('.it-text[contenteditable=true]')")
        check(ed, 'the box stays open for typing after the move')
        await page.keyboard.type('!'); await page.wait_for_timeout(100)
        n = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'x').length")
        check(n == 1, 'moving made no new box')
        # finger drag
        g2 = await page.evaluate("(() => { const r = document.getElementById('tMove').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        cdp = await ctx.new_cdp_session(page)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': g2[0], 'y': g2[1]}]})
        for k in range(1, 11):
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': g2[0], 'y': g2[1] + 10 * k}]})
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); await page.wait_for_timeout(300)
        it2 = await page.evaluate("(() => { const i = [...__inkwell.cur.items.values()].find(i => i.t === 'x'); return [i.x, i.y]; })()")
        cam = await page.evaluate("[__inkwell.cam.ox, __inkwell.cam.oy]")
        check(abs(it2[1] - it1[1] - 100 / z) < 1.5 and abs(it2[0] - it1[0]) < 1, f'finger drag on the hand moves the box, not the page ({it1} -> {it2}, cam {cam})')
        # 1.58.1: the drag cancels touchmove (stops iPad Scribble from taking the Pencil) and keeps going when the
        # finger jumps far away from the hand in one step; the box stays open
        await page.evaluate("() => { window.__tmPrev = []; window.addEventListener('touchmove', e => window.__tmPrev.push(e.defaultPrevented)); }")
        g3 = await page.evaluate("(() => { const r = document.getElementById('tMove').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': g3[0], 'y': g3[1]}]})
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': g3[0] + 200, 'y': g3[1] - 60}]})
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': g3[0] + 240, 'y': g3[1] - 70}]})
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); await page.wait_for_timeout(300)
        it2b = await page.evaluate("(() => { const i = [...__inkwell.cur.items.values()].find(i => i.t === 'x'); return [i.x, i.y]; })()")
        prev = await page.evaluate("window.__tmPrev")
        ed2 = await page.evaluate("!!document.querySelector('.it-text[contenteditable=true]') && document.activeElement.classList.contains('it-text')")
        check(abs(it2b[0] - it2[0] - 240 / z) < 1.5 and abs(it2b[1] - it2[1] + 70 / z) < 1.5, f'a fast drag that leaves the hand still moves the box ({it2} -> {it2b})')
        check(prev and all(prev), f'touch moves on the hand are cancelled, so Scribble cannot take the Pencil ({prev})')
        check(ed2, 'box still open with the cursor in it after the touch drag')
        it2 = it2b
        # Pencil (pen pointer events, as Chromium sends them for a stylus without touch events)
        g4 = await page.evaluate("(() => { const r = document.getElementById('tMove').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        for typ, dx in (('mousePressed', 0), ('mouseMoved', -60), ('mouseMoved', -240), ('mouseReleased', -240)):
            await cdp.send('Input.dispatchMouseEvent', {'type': typ, 'x': g4[0] + dx, 'y': g4[1], 'button': 'left', 'buttons': 0 if typ == 'mouseReleased' else 1, 'clickCount': 1, 'pointerType': 'pen'})
        await page.wait_for_timeout(300)
        it2c = await page.evaluate("(() => { const i = [...__inkwell.cur.items.values()].find(i => i.t === 'x'); return [i.x, i.y]; })()")
        check(abs(it2c[0] - it2[0] + 240 / z) < 1.5, f'Pencil drag on the hand moves the box ({it2} -> {it2c})')
        nstroke = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 's').length")
        check(nstroke == 0, 'the Pencil drag drew nothing')
        it2 = it2c
        await page.keyboard.press('Escape'); await page.wait_for_timeout(400)
        html = await page.evaluate("[...__inkwell.cur.items.values()].find(i => i.t === 'x').html")
        check('Move me!' in html, f'text kept ({html})')
        check(await page.evaluate("document.getElementById('tMove').hidden"), 'the hand goes away when typing ends')
        # undo: the whole editing session (new box) is one step; check a move of an existing box undoes to its place
        await page.wait_for_timeout(600)
        box = await page.evaluate("(() => { const r = document.querySelector('.it-text').getBoundingClientRect(); return [r.left + 10, r.top + 8]; })()")
        await page.mouse.click(*box); await page.wait_for_timeout(300)
        g3 = await page.evaluate("(() => { const r = document.getElementById('tMove').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        await page.mouse.move(*g3); await page.mouse.down()
        for k in range(1, 6): await page.mouse.move(g3[0] - 10 * k, g3[1])
        await page.mouse.up(); await page.wait_for_timeout(200)
        await page.keyboard.press('Escape'); await page.wait_for_timeout(400)
        it3 = await page.evaluate("(() => { const i = [...__inkwell.cur.items.values()].find(i => i.t === 'x'); return [i.x, i.y]; })()")
        check(abs(it3[0] - it2[0] + 50 / z) < 1, 'an existing box moves too')
        await page.keyboard.press('Control+z'); await page.wait_for_timeout(300)
        it4 = await page.evaluate("(() => { const i = [...__inkwell.cur.items.values()].find(i => i.t === 'x'); return i ? [i.x, i.y] : null; })()")
        check(it4 and abs(it4[0] - it2[0]) < 0.5 and abs(it4[1] - it2[1]) < 0.5, f'Undo puts it back ({it4} vs {it2})')
        await page.keyboard.press('Control+y'); await page.wait_for_timeout(300)
        await page.evaluate("async () => { await __inkwell.flushSaves(); }"); await page.wait_for_timeout(300)
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        it5 = await page.evaluate("(() => { const i = [...__inkwell.cur.items.values()].find(i => i.t === 'x'); return i ? [i.x, i.y] : null; })()")
        check(it5 and abs(it5[0] - it3[0]) < 0.5 and abs(it5[1] - it3[1]) < 0.5, f'the moved place survives a reload ({it5} vs {it3})')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
