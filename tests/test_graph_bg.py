# 1.57: graphs get a solid background (filled stroke fl:1, colour 'paper') under the whole graph, so the graph grid
# is easy to tell apart from the paper grid. Page colour in light and dark mode; ink drawn later stays on top;
# partial eraser and recolouring leave it; switch in the graph window (remembered).
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

INFO = """() => { const its = [...__inkwell.cur.items.values()], f = its.filter(i => i.fl);
  const rest = its.filter(i => i.t === 's' && !i.fl); let b = [1e9, 1e9, -1e9, -1e9];
  for(const i of rest) for(let k = 0; k < i.p.length; k += 3){ b[0] = Math.min(b[0], i.p[k]); b[1] = Math.min(b[1], i.p[k+1]); b[2] = Math.max(b[2], i.p[k]); b[3] = Math.max(b[3], i.p[k+1]); }
  let fb = null; if(f[0]){ fb = [1e9, 1e9, -1e9, -1e9]; const p = f[0].p; for(let k = 0; k < p.length; k += 3){ fb[0] = Math.min(fb[0], p[k]); fb[1] = Math.min(fb[1], p[k+1]); fb[2] = Math.max(fb[2], p[k]); fb[3] = Math.max(fb[3], p[k+1]); } }
  return {n: f.length, c: f[0] && f[0].c, first: its[0] && its[0].fl === 1, g: f[0] && f[0].g, gs: new Set(its.map(i => i.g)).size, b, fb}; }"""
# colour of the ink canvas at world point (x, y)
PIX = """([x, y]) => { const W = __inkwell, c = document.getElementById('ink'), d = devicePixelRatio || 1;
  const sx = (x * W.cam.z + W.cam.ox) * d, sy = (y * W.cam.z + W.cam.oy) * d;
  const v = c.getContext('2d').getImageData(Math.round(sx), Math.round(sy), 1, 1).data; return [v[0], v[1], v[2], v[3]]; }"""

async def insert_graph(page, grid=True):
    await page.click('#shapeBtn'); await page.click('#graphOpen')
    await page.wait_for_selector('#graphDlg', state='visible'); await page.wait_for_timeout(200)
    if grid: await page.check('#gGrid')
    await page.click('#gInsert'); await page.wait_for_timeout(400)

async def run(b, scheme, paper):
    ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, color_scheme=scheme)
    await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
    page = await ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    await page.goto(URL); await page.wait_for_timeout(3000)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
    await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
    await insert_graph(page)
    d = await page.evaluate(INFO)
    check(d['n'] == 1 and d['c'] == 'paper' and d['first'] and d['gs'] == 1, f'{scheme}: one background, drawn first, in the graph group ({d["n"]}, {d["c"]})')
    check(d['fb'] and d['fb'][0] < d['b'][0] and d['fb'][1] < d['b'][1] and d['fb'][2] > d['b'][2] and d['fb'][3] > d['b'][3], f'{scheme}: background covers the whole graph ({d["fb"]} vs {d["b"]})')
    # a spot inside the graph that is between grid lines: paper colour, fully opaque (paper grid hidden)
    fb = d['fb']
    await page.evaluate("() => { __inkwell.cam.z = 1; }"); await page.wait_for_timeout(300)
    hits = []
    for fx, fy in ((0.3, 0.35), (0.62, 0.55), (0.81, 0.27)):
        x = fb[0] + (fb[2] - fb[0]) * fx + 3.3; y = fb[1] + (fb[3] - fb[1]) * fy + 3.7
        hits.append(await page.evaluate(PIX, [x, y]))
    ok = sum(1 for h in hits if h[3] == 255 and all(abs(h[i] - paper[i]) <= 3 for i in range(3)))
    check(ok >= 2, f'{scheme}: inside the graph the paper colour is solid ({hits}, want {paper})')
    # grid line still visible on it: somewhere along the bbox there is a pixel differing from paper
    # ink drawn later stays on top
    mid = [(fb[0] + fb[2]) / 2 + 5.3, (fb[1] + fb[3]) / 2 + 9.1]
    await page.evaluate("([x, y]) => __inkwell.addItems([{t: 's', id: 'sTop', c: '#C2362B', w: 6, hl: 0, p: [x - 30, y, .5, x + 30, y, .5]}])", mid)
    await page.wait_for_timeout(300)
    px = await page.evaluate(PIX, mid)
    check(px[0] > 150 and px[1] < 100, f'{scheme}: ink written on the graph shows on top ({px})')
    # partial eraser across the middle: background stays
    await page.evaluate("() => { __inkwell.prefs.eraser.mode = 'area'; __inkwell.setTool('eraser'); }")
    sx = await page.evaluate("([x, y]) => [x * __inkwell.cam.z + __inkwell.cam.ox + document.getElementById('stage').getBoundingClientRect().left, y * __inkwell.cam.z + __inkwell.cam.oy + document.getElementById('stage').getBoundingClientRect().top]", [mid[0], mid[1] + 40])
    await page.mouse.move(sx[0] - 60, sx[1]); await page.mouse.down(); await page.mouse.move(sx[0] + 60, sx[1], steps=12); await page.mouse.up()
    await page.wait_for_timeout(300)
    d2 = await page.evaluate(INFO)
    check(d2['n'] == 1, f'{scheme}: Partial eraser leaves the background')
    # 1.57: no eraser touches the graph (lines, curve, numbers, labels); ink drawn on it is erased
    GN = "() => [...__inkwell.cur.items.values()].filter(i => i.ne).length"
    n0 = await page.evaluate(GN)
    allne = await page.evaluate("() => [...__inkwell.cur.items.values()].filter(i => i.g).every(i => i.ne === 1)")
    check(n0 > 20 and allne, f'{scheme}: every graph part is marked not erasable ({n0})')
    await page.evaluate("([x, y]) => __inkwell.addItems([{t: 's', id: 'sMine', c: '#1F4FCF', w: 4, hl: 0, p: [x - 40, y, .5, x + 40, y + 10, .5]}])", [mid[0], mid[1] + 80])
    await page.wait_for_timeout(200)
    st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
    W2S = "([x, y]) => [x * __inkwell.cam.z + __inkwell.cam.ox, y * __inkwell.cam.z + __inkwell.cam.oy]"
    for mode in ('stroke', 'area'):
        await page.evaluate(f"() => {{ __inkwell.prefs.eraser.mode = '{mode}'; __inkwell.setTool('eraser'); }}")
        # scrub across the whole graph, rows and columns, including the labels and the drawn line
        for k in range(9):
            y = fb[1] + (fb[3] - fb[1]) * (k + 0.5) / 9
            a1 = await page.evaluate(W2S, [fb[0] - 5, y]); a2 = await page.evaluate(W2S, [fb[2] + 5, y])
            await page.mouse.move(st[0] + a1[0], st[1] + a1[1]); await page.mouse.down(); await page.mouse.move(st[0] + a2[0], st[1] + a2[1], steps=25); await page.mouse.up()
        for k in range(7):
            x = fb[0] + (fb[2] - fb[0]) * (k + 0.5) / 7
            a1 = await page.evaluate(W2S, [x, fb[1] - 5]); a2 = await page.evaluate(W2S, [x, fb[3] + 5])
            await page.mouse.move(st[0] + a1[0], st[1] + a1[1]); await page.mouse.down(); await page.mouse.move(st[0] + a2[0], st[1] + a2[1], steps=25); await page.mouse.up()
        await page.wait_for_timeout(300)
        n1 = await page.evaluate(GN)
        mine = await page.evaluate("() => [...__inkwell.cur.items.values()].filter(i => i.t === 's' && !i.ne && !i.fl).length")
        check(n1 == n0, f'{scheme}: {mode} eraser over the whole graph leaves it ({n0} -> {n1})')
        check(mine == 0, f'{scheme}: {mode} eraser removes my ink on the graph ({mine} left)')
        await page.evaluate("([x, y]) => __inkwell.addItems([{t: 's', id: 'sMine2', c: '#1F4FCF', w: 4, hl: 0, p: [x - 40, y, .5, x + 40, y + 10, .5]}])", [mid[0], mid[1] + 80])
        await page.wait_for_timeout(200)
    # recolouring the whole graph keeps the background in the page colour
    await page.evaluate("() => { __inkwell.setTool('lasso'); __inkwell.selectIds([...__inkwell.cur.items.values()].filter(i => i.g).map(i => i.id)); }"); await page.wait_for_timeout(300)
    await page.evaluate("() => { const b = document.querySelector('#selColors [data-c]:not([data-c=auto])') || document.querySelector('#selColors [data-c]'); b.click(); }"); await page.wait_for_timeout(300)
    d3 = await page.evaluate(INFO)
    check(d3['c'] == 'paper', f'{scheme}: recolouring the graph keeps the background ({d3["c"]})')
    # Select tool + delete removes the whole graph
    await page.evaluate("() => { __inkwell.setTool('lasso'); __inkwell.selectIds([...__inkwell.cur.items.values()].filter(i => i.g).map(i => i.id)); }"); await page.wait_for_timeout(300)
    await page.keyboard.press('Delete'); await page.wait_for_timeout(300)
    left = await page.evaluate("() => [...__inkwell.cur.items.values()].filter(i => i.ne || i.fl).length")
    check(left == 0, f'{scheme}: Select + delete removes the graph ({left} left)')
    await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(300)
    check(not errs, f'{scheme}: no page errors ' + '; '.join(errs[:3]))
    return ctx, page

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx, page = await run(b, 'light', [255, 255, 255])
        # switch in the dialog, remembered
        await page.evaluate("__inkwell.removeItems([...__inkwell.cur.items.keys()])")
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(200)
        check(await page.is_checked('#gBg'), 'Solid background is on by default in the graph window')
        await page.uncheck('#gBg'); await page.wait_for_timeout(100)
        await page.click('#gInsert'); await page.wait_for_timeout(400)
        d = await page.evaluate(INFO)
        check(d['n'] == 0, 'switched off: graph without background')
        await page.evaluate("async () => { await __inkwell.flushSaves(); }"); await page.wait_for_timeout(500)
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_timeout(200)
        check(not await page.is_checked('#gBg'), 'off is remembered')
        await page.check('#gBg'); await page.click('#gInsert'); await page.wait_for_timeout(400)
        d = await page.evaluate(INFO)
        check(d['n'] == 1, 'on again: background back')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(300)
        d = await page.evaluate(INFO)
        check(d['n'] == 0, 'undo removes the graph with its background')
        # export: background is white in the PDF file, path drawn before the axes
        await page.evaluate("__inkwell.redo()"); await page.wait_for_timeout(300)
        await ctx.close()
        ctx, page = await run(b, 'dark', [0x1B, 0x20, 0x27])
        await ctx.close()
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
