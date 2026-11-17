# 2.7 (Rafael, iPad: "when I have something to paste I have to scroll down to reach Shapes"). Toolbar on the side at the
# iPad's height (about 757 px in the home-screen app): with the fresh Paste button showing, every tool's column fits,
# so Shapes and the zoom at the foot are in view without scrolling. Also at 820 px and in a technical notebook.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
M = """() => { const b = document.querySelector('.bar2'), s = document.getElementById('shapeRail').getBoundingClientRect(), f = document.getElementById('freshPaste');
  const foot = document.getElementById('sideBtn').getBoundingClientRect().top - 6;
  return {over: b.scrollHeight - b.clientHeight, shapesBottom: Math.round(s.bottom), foot: Math.round(foot), paste: !f.hidden && f.offsetHeight > 0}; }"""
TOOLS = ['pen', 'hl', 'eraser', 'lasso', 'text', 'math', 'tape', 'space', 'mark']
async def run(b, H, side):
    ctx = await b.new_context(viewport={'width': 1180, 'height': H}, has_touch=True)
    await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(URL)
    await pg.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000); await pg.wait_for_timeout(2500)
    await pg.wait_for_function('!!(window.__inkwell && window.__inkwellBooted && window.__inkwell.cur)', timeout=15000)
    await pg.evaluate(f"() => {{ const P = __inkwell.prefs; P.barPos = '{side}'; localStorage.setItem('inkwell.prefs', JSON.stringify(P)); }}")
    await pg.reload(); await pg.wait_for_timeout(2500)
    await pg.wait_for_function('!!(window.__inkwell && window.__inkwellBooted && window.__inkwell.cur)', timeout=15000)
    await pg.evaluate("localStorage.setItem('inkwell.fresh', JSON.stringify({at: Date.now(), used: 0})); document.dispatchEvent(new Event('visibilitychange'))")
    for t in TOOLS:
        await pg.evaluate(f"__inkwell.setTool('{t}')"); await pg.wait_for_timeout(200)
        m = await pg.evaluate(M)
        check(m['paste'] and m['over'] <= 0 and m['shapesBottom'] <= m['foot'], f'{side} {H} px, {t}: Paste shows, column fits, Shapes in view ({m})')
    # technical notebook pen: the extra Line type button
    await pg.evaluate("__inkwell.setTool('pen'); document.getElementById('techBtn').hidden = false"); await pg.wait_for_timeout(200)
    m = await pg.evaluate(M)
    check(m['over'] <= 0 and m['shapesBottom'] <= m['foot'], f'{side} {H} px, technical pen: fits ({m})')
    # text tool: ruler gives its place to an icon-only Paste
    await pg.evaluate("__inkwell.setTool('text')"); await pg.wait_for_timeout(200)
    r = await pg.evaluate("(() => { const p = document.getElementById('freshPaste').getBoundingClientRect(), f = document.getElementById('fingerBtn').getBoundingClientRect(); return {ruler: document.getElementById('rulerBtn').offsetWidth, pw: Math.round(p.width), sameRow: Math.abs(p.top - f.top) < 2}; })()")
    check(r['ruler'] == 0 and r['pw'] == 44 and r['sameRow'], f'{side}: text tool, Paste sits beside Finger where the ruler was ({r})')
    await pg.evaluate("__inkwell.setTool('pen')"); await pg.wait_for_timeout(200)
    check(await pg.evaluate("document.getElementById('rulerBtn').offsetWidth") == 44, f'{side}: ruler back for the pen')
    check(not errs, f'no page errors {errs}')
    await ctx.close()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        await run(b, 757, 'left'); await run(b, 757, 'right'); await run(b, 820, 'left')
        await b.close()
    if fails: print('FAILED:', len(fails)); raise SystemExit(1)
    print('ALL OK')
asyncio.run(main())
