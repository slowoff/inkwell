# 1.42.2: the top of the screen (status bar area + top bar) is one solid colour inside fixed/sticky
# boxes, so iPadOS 26 does not draw its "scroll edge" blur over the top bar of the Home Screen app.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

INFO = """() => {
  const q = s => document.querySelector(s), cs = e => getComputedStyle(e);
  const e = q('.edge-top'), b1 = q('.bar1'), b2 = q('.bar2'), st = q('#stage');
  const r = x => { const k = x.getBoundingClientRect(); return [k.left, k.top, k.width, k.height].map(v => Math.round(v)); };
  const hit = document.elementFromPoint(innerWidth / 2, 2);
  return { edge: e ? {pos: cs(e).position, bg: cs(e).backgroundColor, r: r(e), pe: cs(e).pointerEvents} : null,
           b1: {pos: cs(b1).position, bg: cs(b1).backgroundColor, r: r(b1)}, b2: r(b2), stage: r(st),
           hit: hit ? (hit.closest('.bar1') ? 'bar1' : hit.className || hit.tagName) : null,
           title: r(q('#title')) };
}"""

async def run(scheme, sat):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, color_scheme=scheme)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        if sat:  # pretend a status bar like the iPad's (safe area at the top)
            await page.add_style_tag(content=f':root{{--sat:{sat}px}}'); await page.wait_for_timeout(200)
        i = await page.evaluate(INFO)
        tag = f'[{scheme}, status bar {sat}px]'
        check(i['edge'] and i['edge']['pos'] == 'fixed' and i['edge']['pe'] == 'none', f'{tag} top strip is fixed and not touchable ({i["edge"]})')
        check(i['edge']['r'] == [0, 0, 1180, sat], f'{tag} strip covers exactly the status bar area across the whole width ({i["edge"]["r"]})')
        check(i['edge']['bg'] == i['b1']['bg'] and not i['b1']['bg'].startswith('rgba'), f'{tag} strip and top bar are the same solid colour ({i["edge"]["bg"]} / {i["b1"]["bg"]})')
        check(i['b1']['pos'] == 'sticky', f'{tag} top bar is sticky ({i["b1"]["pos"]})')
        check(i['b1']['r'][1] == sat, f'{tag} top bar starts right under the status bar ({i["b1"]["r"]})')
        check(i['b2'][1] == i['b1']['r'][1] + i['b1']['r'][3] and i['stage'][1] == i['b2'][1] + i['b2'][3], f'{tag} layout below unchanged (bar2 {i["b2"]}, stage {i["stage"]})')
        # the top bar still works: tap the title and type
        await page.click('#title'); await page.keyboard.type('Edge'); await page.wait_for_timeout(100)
        v = await page.evaluate("document.getElementById('title').value")
        check(v.endswith('Edge'), f'{tag} title in the top bar can still be tapped and typed in ({v!r})')
        # a popover opened from the top bar is drawn above the strip
        await page.click('#moreBtn'); await page.wait_for_timeout(200)
        z = await page.evaluate("(() => { const p = document.getElementById('morePop'); return p && !p.hidden ? +getComputedStyle(p).zIndex : null; })()")
        check(z is not None and z > 19, f'{tag} menus open above the strip (z {z})')
        check(not errs, f'{tag} no page errors ' + '; '.join(errs[:3]))
        await b.close()

async def main():
    await run('dark', 0); await run('dark', 24); await run('light', 24)
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
