# 1.70.2: on an 11" iPad in landscape (1180 px, notebook list closed) the pen tool bar was 50 px too wide, so the
# zoom % sat off screen and the bar had to be dragged sideways. barFit() tightens the bar step by step (t1..t3).
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
TOOLS = ['pen', 'hl', 'eraser', 'lasso', 'text', 'math', 'tape', 'space', 'mark']
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

STATE = """(() => { const b = document.getElementById('toolbar'), z = document.getElementById('zoomBtn').getBoundingClientRect(), r = b.getBoundingClientRect();
  const btns = [...b.querySelectorAll('button')].filter(e => e.offsetWidth).map(e => e.getBoundingClientRect().width);
  return {over: b.scrollWidth - b.clientWidth, cls: b.className, zoomIn: z.right <= r.right + 0.5 && z.width > 30, minBtn: Math.min(...btns)}; })()"""

async def page_at(b, w, h, touch):
    ctx = await b.new_context(viewport={'width': w, 'height': h}, has_touch=touch)
    await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
    pg = await ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(URL); await pg.wait_for_timeout(3000)
    if await pg.evaluate("document.querySelector('.side').getBoundingClientRect().width") > 10:
        await pg.click('#sideBtn'); await pg.wait_for_timeout(400)
    return ctx, pg, errs

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for w, h in [(1180, 820), (1194, 834)]:
            for touch in (True, False):
                ctx, pg, errs = await page_at(b, w, h, touch)
                tag = f"[{w}px {'touch' if touch else 'mouse'}]"
                for t in TOOLS:
                    await pg.evaluate(f"__inkwell.setTool('{t}')"); await pg.wait_for_timeout(120)
                    s = await pg.evaluate(STATE)
                    check(s['over'] <= 1 and s['zoomIn'], f"{tag} {t}: whole bar fits, zoom % visible ({s})")
                    if touch: check(s['minBtn'] >= 39.5, f"{tag} {t}: buttons stay at least 40 px ({s['minBtn']})")
                    if touch and t in ('pen', 'hl'): check('t2' not in s['cls'] and s['minBtn'] >= 43.5, f"{tag} {t}: only the first step needed, 44 px buttons ({s['cls']})")
                # the compact finger switch still works and shows its icon
                await pg.evaluate("__inkwell.setTool('pen')"); await pg.wait_for_timeout(120)
                fin = await pg.evaluate("(() => { const f = document.getElementById('fingerBtn'); return {ico: f.querySelector('.tg-ico').getBoundingClientRect().width, lbl: f.querySelector('.tg-lbl').offsetWidth, on: f.classList.contains('on')}; })()")
                if touch: check(fin['ico'] > 0 and fin['lbl'] == 0, f'{tag} finger switch shows the hand icon instead of the label ({fin})')
                await pg.click('#fingerBtn'); await pg.wait_for_timeout(150)
                check(await pg.evaluate("document.getElementById('fingerBtn').classList.contains('on')") != fin['on'], f'{tag} finger switch still toggles')
                await pg.click('#fingerBtn')
                # opening the notebook list narrows the bar: it tightens, then falls back to side scrolling
                await pg.click('#sideBtn'); await pg.wait_for_timeout(500)
                s = await pg.evaluate(STATE)
                check('t3' in s['cls'] and 'fade-r' in s['cls'], f'{tag} with the notebook list open it tightens fully and scrolls the rest ({s})')
                await pg.click('#sideBtn'); await pg.wait_for_timeout(500)
                s = await pg.evaluate(STATE)
                check(s['over'] <= 1 and 'fade-r' not in s['cls'] and 't2' not in s['cls'], f'{tag} closing it again goes back to the roomy layout ({s})')
                check(not errs, f'{tag} no page errors {errs}')
                await ctx.close()
        # plenty of room: nothing changes from the old look
        ctx, pg, errs = await page_at(b, 1366, 1024, True)
        for t in TOOLS:
            await pg.evaluate(f"__inkwell.setTool('{t}')"); await pg.wait_for_timeout(120)
            s = await pg.evaluate(STATE)
            check(s['over'] <= 1 and s['cls'].split() == ['bar2'], f"[1366px] {t}: fits with the full labels ({s['cls']})")
        check(await pg.evaluate("document.querySelector('#fingerBtn .tg-lbl').offsetWidth > 0"), '[1366px] "Finger draws" label shown')
        await ctx.close()
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
