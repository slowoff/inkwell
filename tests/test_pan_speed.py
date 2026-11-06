# 1.88.1: moving around a page must not draw the ink again on every frame (that was the lag on pages with a lot of
# writing). Pan = the layers slide; only strips that come into view are drawn, and the result must be exactly what a
# full redraw gives. Also: pinch stretches and redraws when it stops; a stroke only redraws its own part; outlines are
# built only for strokes that get drawn; the empty blending layer stays out of the way.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

GEN = r"""
(n) => { const W = __inkwell; let seed = 7; const R = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const items = []; for(let i = 0; i < n; i++){ const x0 = 40 + (i % 50) * 20, y0 = 40 + Math.floor(i / 50) * 40, p = [];
    for(let k = 0; k < 24; k++){ const t = k / 24 * 6.28; p.push(x0 + 8 * Math.sin(t * 2 + i) + t, y0 + 12 * Math.cos(t + i), .5); }
    const hl = i % 53 === 0; items.push({t: 's', id: 's' + i, c: hl ? '#ffd400' : (i % 7 ? 'auto' : '#c02020'), w: hl ? 18 : 2.4, hl: hl ? 1 : undefined, p}); }
  W.addItems(items); W.cam.z = 1; W.cam.ox = 40; W.cam.oy = 20; W.invalidate(); }
"""
PAN = r"""
async ([dx, dy, steps]) => { const s = document.getElementById('stage'), r = s.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const ev = (t, a, b) => s.dispatchEvent(new PointerEvent(t, {pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: a, clientY: b, bubbles: true, cancelable: true}));
  ev('pointerdown', x, y); ev('pointermove', x, y + 8); await new Promise(requestAnimationFrame);
  for(let i = 1; i <= steps; i++){ ev('pointermove', x + dx * i / steps, y + 8 + dy * i / steps); await new Promise(requestAnimationFrame); }
  window.__panEnd = () => ev('pointerup', x + dx, y + 8 + dy); }
"""
# canvas pixels after a full redraw vs now; returns how many differ by more than a little
DIFF = r"""
() => { const W = __inkwell, out = {}; for(const id of ['ink', 'hlm']){ const c = document.getElementById(id); out[id] = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; }
  W.cam.ox = W.inkAt.ox; W.cam.oy = W.inkAt.oy;   // same anchor as the layers were drawn with, so the pixels can be compared
  W.drawInk(); let bad = 0, inked = 0, n = 0;
  for(const id of ['ink', 'hlm']){ const c = document.getElementById(id), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, o = out[id]; n += d.length / 4;
    for(let i = 0; i < d.length; i += 4){ if(d[i + 3]) inked++; // a clip edge changes the edge softness of a few pixels a little, and colours of nearly clear pixels round differently: not visible
      if(Math.abs(d[i + 3] - o[i + 3]) > 32 || (d[i + 3] > 64 && (Math.abs(d[i] - o[i]) > 24 || Math.abs(d[i + 1] - o[i + 1]) > 24 || Math.abs(d[i + 2] - o[i + 2]) > 24))) bad++; } }
  return {bad, inked, n}; }
"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        hid = await page.evaluate("getComputedStyle(document.getElementById('hlm')).display")
        check(hid == 'none', f'empty highlight layer is left out ({hid})')
        await page.evaluate(GEN, 6000); await page.wait_for_timeout(600)
        st = await page.evaluate("({p: __inkwell.geoPaths, n: __inkwell.geo.size, d: getComputedStyle(document.getElementById('hlm')).display})")
        check(st['p'] < st['n'] / 2, f"outlines only for strokes that were drawn ({st['p']} of {st['n']})")
        check(st['d'] != 'none', 'highlight layer shows when a highlight is in view')
        # slide: no drawing at all
        s0 = await page.evaluate("({...__inkwell.inkAt})")
        await page.evaluate(PAN, [30, -60, 8])
        s1 = await page.evaluate("({...__inkwell.inkAt})")
        check(s1['full'] == s0['full'] and s1['moves'] == s0['moves'] and s1['slides'] > s0['slides'], f"small pan only slides the layers ({s0['full']}→{s1['full']} full, {s1['moves']} shifts)")
        vis = await page.evaluate("__inkwell.cam.oy - __inkwell.inkAt.oy")
        check(abs(vis + 52) < 2, f'layer followed the finger ({vis})')   # the first 8 px of a touch only start the pan
        await page.evaluate("window.__panEnd()")
        await page.wait_for_timeout(300)
        q = await page.evaluate("[__inkwell.cam.ox - __inkwell.inkAt.ox, __inkwell.cam.oy - __inkwell.inkAt.oy, document.getElementById('ink').style.transform]")
        check(abs(q[0] * 1 - round(q[0])) < 1e-6 and abs(q[1] * 1 - round(q[1])) < 1e-6, f'camera settled on a whole pixel of the layers {q}')
        s2 = await page.evaluate("({...__inkwell.inkAt})")
        check(s2['full'] == s1['full'], 'nothing drawn again when the pan stops')
        idle = await page.evaluate("""async () => { const W = __inkwell, a = W.inkAt.slides, f = window.frame; let n = 0; window.frame = function(){ n++; return f.apply(this, arguments); };
          await new Promise(r => setTimeout(r, 700)); window.frame = f; return {frames: n, slides: W.inkAt.slides - a}; }""")
        check(idle['frames'] == 0 and idle['slides'] == 0, f'the page goes quiet after a pan: no frames keep running ({idle})')
        # long pan: shifts + strips must equal a full redraw, pixel for pixel (both ways, diagonal)
        for dx, dy in [(-90, -700), (140, 900), (-300, 500)]:
            s3 = await page.evaluate("({...__inkwell.inkAt})")
            await page.evaluate(PAN, [dx, dy, 14])
            s4 = await page.evaluate("({...__inkwell.inkAt})")
            check(s4['moves'] > s3['moves'], f'long pan {dx},{dy} moved the picture and drew the strips ({s4["moves"] - s3["moves"]} shifts, {s4["full"] - s3["full"]} full)')
            d = await page.evaluate(DIFF)
            check(d['inked'] > 1000 and d['bad'] < d['n'] * 2e-5, f'long pan {dx},{dy}: same pixels as a full redraw ({d})')
            await page.evaluate("window.__panEnd()"); await page.wait_for_timeout(250)
        # ink lands in the right place on screen after all that: a new stroke at a world spot appears under its spot
        s5 = await page.evaluate("({...__inkwell.inkAt})")
        await page.evaluate("""() => { const W = __inkwell, c = W.cam, p = []; const x = (300 - c.ox) / c.z, y = (300 - c.oy) / c.z;
          for(let i = 0; i <= 30; i++) p.push(x + i * 6, y, .7); W.addItems([{t: 's', id: 'mark1', c: '#0000ff', w: 14, p}]); }""")
        await page.wait_for_timeout(200)
        s6 = await page.evaluate("({...__inkwell.inkAt})")
        check(s6['full'] == s5['full'] and s6['parts'] > s5['parts'], f"a new stroke only redraws its own part ({s6['parts'] - s5['parts']} part, {s6['full'] - s5['full']} full)")
        d = await page.evaluate(DIFF)
        check(d['bad'] < d['n'] * 2e-5, f'part redraw equals a full redraw ({d})')
        r = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        from PIL import Image; import io
        im = Image.open(io.BytesIO(await page.screenshot(clip={'x': r[0] + 330, 'y': r[1] + 290, 'width': 100, 'height': 20}))).convert('RGB')
        px = [im.getpixel((x, y)) for y in range(im.height) for x in range(im.width)]
        check(sum(1 for a, g, bl in px if bl > 180 and a < 90 and g < 90) / len(px) > 0.2, 'stroke shows on screen where it was placed')
        await page.evaluate("__inkwell.undo()"); await page.wait_for_timeout(200)
        d = await page.evaluate(DIFF); check(d['bad'] < d['n'] * 2e-5, f'undo of the stroke clears exactly that ({d})')
        # pinch: stretched while it goes on, exact afterwards; text boxes set when it stops
        await page.evaluate("""() => { __inkwell.addItems([{t: 'x', id: 'tb1', x: 200, y: 200, w: 200, fs: 1, html: '<p>Hello</p>'}]); }""")
        s7 = await page.evaluate("({...__inkwell.inkAt})")
        res = await page.evaluate("""async () => { const W = __inkwell, s = document.getElementById('stage'), r = s.getBoundingClientRect();
          const a = (t, id, x, y, prim) => s.dispatchEvent(new PointerEvent(t, {pointerId: id, pointerType: 'touch', isPrimary: prim, clientX: x, clientY: y, bubbles: true, cancelable: true}));
          const cx = r.left + 500, cy = r.top + 400; a('pointerdown', 11, cx - 100, cy, true); a('pointerdown', 12, cx + 100, cy, false);
          let mid = null; for(let i = 1; i <= 6; i++){ a('pointermove', 11, cx - 100 - i * 6, cy, true); a('pointermove', 12, cx + 100 + i * 6, cy, false); await new Promise(requestAnimationFrame);
            if(i === 6) mid = {xf: document.getElementById('ink').style.transform, front: W.frontZ, z: W.cam.z, tb: document.querySelector('[data-id=tb1]').getBoundingClientRect().left - r.left}; }
          a('pointerup', 11, cx, cy, true); a('pointerup', 12, cx, cy, false); return mid; }""")
        check('scale' in res['xf'] and res['front'] != res['z'], f'pinch stretches the layers ({res})')
        exp = await page.evaluate("__inkwell.cam.ox + 200 * __inkwell.cam.z")
        check(abs(res['tb'] - exp) < 1.5, f'text box follows the pinch ({res["tb"]} vs {exp})')
        await page.wait_for_timeout(500)
        s8 = await page.evaluate("({...__inkwell.inkAt, xf0: document.getElementById('ink').style.transform, front: __inkwell.frontZ, z: __inkwell.cam.z})")
        check('scale' not in s8['xf0'] and s8['front'] == s8['z'] and s8['full'] > s7['full'], f"exact again after the pinch ({s8['xf0']})")
        d = await page.evaluate(DIFF); check(d['bad'] < d['n'] * 2e-5, f'after pinch same pixels as full redraw ({d})')
        tb = await page.evaluate("document.querySelector('[data-id=tb1]').getBoundingClientRect().left - document.getElementById('stage').getBoundingClientRect().left")
        exp = await page.evaluate("__inkwell.cam.ox + 200 * __inkwell.cam.z")
        check(abs(tb - exp) < 1, f'text box in place after the pinch ({tb} vs {exp})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)
asyncio.run(main())
