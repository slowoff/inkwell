# 1.58.4: graph numbers centred under their tick on the x axis and level with their tick left of the y axis,
# not touching the axis line.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

MEASURE = """() => { const W = __inkwell, its = [...W.cur.items.values()], st = document.getElementById('stage').getBoundingClientRect();
  const xa = its.find(i => i.ga && i.ga.k === 'x'), ya = its.find(i => i.ga && i.ga.k === 'y'), A = xa.ga, B = ya.ga;
  const sx = wx => st.left + wx * W.cam.z + W.cam.ox, sy = wy => st.top + wy * W.cam.z + W.cam.oy;
  const p = xa.p, q = ya.p, ay = sy(p[1]), ax = sx(q[0]);
  const X = v => sx(p[0] + (p[p.length - 3] - p[0]) * A.f * (v - A.v0) / (A.v1 - A.v0));
  const Y = v => sy(q[1] + (q[q.length - 2] - q[1]) * B.f * (v - B.v0) / (B.v1 - B.v0));
  const out = [];
  for(const it of its){
    if(it.t !== 'm' || !/^-?[\\d.]+$/.test(it.tex)) continue;
    const el = document.querySelector(`[data-id="${it.id}"] .katex-html`); if(!el) continue;
    const r = el.getBoundingClientRect(), v = parseFloat(it.tex);
    const below = r.top > ay; // x-axis numbers are below the axis; y-axis ones are level with their tick
    out.push({v, tex: it.tex, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, l: r.left, r: r.right, t: r.top, b: r.bottom, X: X(v), Y: Y(v), ax, ay});
  }
  return out; }"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        for typ in ('q4', 'q1'):
            await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
            await page.click('#shapeBtn'); await page.click('#graphOpen'); await page.wait_for_selector('#graphDlg', state='visible')
            await page.click(f'#gType [data-v="{typ}"]'); await page.check('#gNums'); await page.check('#gGrid')
            await page.fill('#gX0', '-10' if typ == 'q4' else '0'); await page.fill('#gX1', '10'); await page.fill('#gXs', '1')
            await page.fill('#gY0', '-10' if typ == 'q4' else '0'); await page.fill('#gY1', '10'); await page.fill('#gYs', '1')
            await page.click('#gInsert'); await page.wait_for_timeout(800)
            m = await page.evaluate(MEASURE)
            # x-axis numbers all share one row below the axis; the rest belong to the y axis
            from collections import Counter
            row = Counter(round(n['t']) for n in m if n['t'] > n['ay']).most_common(1)[0][0]
            xs = [n for n in m if abs(n['t'] - row) < 1.5 and n['v'] != 0]
            ys = [n for n in m if n['v'] != 0 and n not in xs]
            check(len(xs) >= 5 and len(ys) >= 5, f'{typ}: numbers on both axes ({len(xs)} x, {len(ys)} y)')
            wx = max(abs(n['cx'] - n['X']) for n in xs)
            check(wx < 1.5, f'{typ}: x numbers centred under their tick (worst {wx:.2f} px)')
            wy = max(abs(n['cy'] - n['Y']) for n in ys)
            check(wy < 2, f'{typ}: y numbers level with their tick (worst {wy:.2f} px)')
            gap = min(n['ax'] - n['r'] for n in ys)
            check(gap >= 4, f'{typ}: y numbers clear of the axis line (closest {gap:.1f} px)')
            top = min(n['t'] - n['ay'] for n in xs)
            check(top >= 5, f'{typ}: x numbers below the ticks, not on the axis ({top:.1f} px)')
            # neighbours don't overlap
            srt = sorted(xs, key=lambda n: n['cx'])
            ov = [ (a['tex'], b2['tex']) for a, b2 in zip(srt, srt[1:]) if a['r'] > b2['l'] - 1]
            check(not ov, f'{typ}: x numbers do not touch each other ({ov})')
            # no two numbers touch anywhere (also around the origin)
            gl = [(n['l'], n['t'], n['r'], n['b'], n['tex']) for n in m]
            hit = [(a[4], c[4]) for i, a in enumerate(gl) for c in gl[i+1:] if a[0] < c[2] and a[2] > c[0] and a[1] < c[3] and a[3] > c[1]]
            check(not hit, f'{typ}: no numbers overlap, also near the origin ({hit})')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
