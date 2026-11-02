# 1.73.5: iPadOS hands over Pencil points it already delivered (getCoalescedEvents repeats recent points exactly).
# The fixture is a real stroke saved from Rafael's iPad on 2026-11-02: it holds the repeats, which draw straight pieces.
# Fed through the app with the repeats still in the event batches, the saved stroke must have none of them.
import asyncio, os, math
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
REAL = "3tr,2zff,7,-3,0,7,-3,0,7,-4,0,7,-4,1,7,b,-1,7,-3,0,7,-4,0,7,-4,1,7,-4,1,7,-4,3,7,-5,2,7,-6,4,7,f,-9,7,-4,3,7,-5,2,7,-6,4,7,-8,5,7,-9,7,7,-9,6,7,-b,a,7,b,-a,7,-b,a,7,-c,a,7,-e,c,7,-e,e,7,-i,g,7,i,-g,7,-i,g,7,-f,g,7,-i,j,7,-i,m,7,-i,m,7,i,-m,7,-i,m,7,-i,n,7,-h,o,7,-f,l,7,-e,m,7,e,-m,7,-e,m,7,-d,l,7,-c,k,7,-9,k,7,-6,h,7,6,-h,7,-6,h,7,-3,e,7,-1,c,7,1,a,7,5,9,7,-5,-v,7,-1,c,7,1,a,7,5,9,7,7,9,7,8,7,7,a,6,7,c,5,7,-c,-5,7,c,5,7,c,5,7,f,4,7,f,2,7,h,3,7,-h,-3,7,h,3,7,f,0,7,h,0,7,h,-1,7,i,-3,7,-i,3,7,i,-3,7"
def decode(p):
    a = p.split(','); X = Y = 0; out = []
    for i in range(0, len(a), 3):
        X += int(a[i], 36); Y += int(a[i+1], 36); out.append((X, Y))
    return out
def clean(pts):
    # the path without the repeats: a point seen before in the last 32 is skipped
    out = []
    for q in pts:
        if q not in out[-32:]: out.append(q)
    return out
FEED = """async ([pts, batch]) => {
  const st = document.getElementById('stage'), r = st.getBoundingClientRect();
  const mk = (t, q) => new PointerEvent(t, {pointerId: 9, pointerType: 'pen', isPrimary: true, pressure: 0.226, button: t === 'pointermove' ? -1 : 0, buttons: t === 'pointerup' ? 0 : 1, clientX: r.left + q[0], clientY: r.top + q[1], bubbles: true, cancelable: true});
  st.dispatchEvent(mk('pointerdown', pts[0]));
  for(let i = 1; i < pts.length; i += batch){
    const part = pts.slice(i, i + batch), e = mk('pointermove', part[part.length - 1]);
    e.getCoalescedEvents = () => part.map(q => mk('pointermove', q));
    st.dispatchEvent(e);
    await new Promise(f => setTimeout(f, 4));
  }
  st.dispatchEvent(mk('pointerup', pts[pts.length - 1]));
  await new Promise(f => setTimeout(f, 100));
  const s = [...__inkwell.cur.items.values()].filter(i => i.t === 's').pop(), z = __inkwell.cam.z, o = [];
  for(let i = 0; i < s.p.length; i += 3) o.push([s.p[i] * z, s.p[i+1] * z]);
  return o;
}"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.prefs.snapHold = 0; __inkwell.prefs.wheel = 'off'; __inkwell.setTool('pen'); }")
        await page.wait_for_timeout(300)
        raw = decode(REAL)
        x0 = min(q[0] for q in raw); y0 = min(q[1] for q in raw)
        pts = [[(q[0] - x0) / 2 + 150, (q[1] - y0) / 2 + 100] for q in raw]   # quarter px -> screen px at a bigger size
        want = clean([tuple(q) for q in pts])
        check(len(want) < len(pts) - 15, f'the saved stroke really holds repeats ({len(pts)} points, {len(want)} real)')
        for batch in (1, 3, 5):
            o = await page.evaluate(FEED, [pts, batch])
            check(len(o) == len(want), f'batches of {batch}: repeats dropped ({len(o)}, want {len(want)})')
            back = 0
            for i in range(1, len(o) - 1):
                ax, ay = o[i][0] - o[i-1][0], o[i][1] - o[i-1][1]; bx, by = o[i+1][0] - o[i][0], o[i+1][1] - o[i][1]
                if ax * bx + ay * by < 0: back += 1
            check(back == 0, f'batches of {batch}: the line never turns back ({back})')
            s0 = (o[-1][0] - o[0][0], o[-1][1] - o[0][1]); s1 = (want[-1][0] - want[0][0], want[-1][1] - want[0][1])
            check(math.hypot(s0[0] - s1[0], s0[1] - s1[1]) < 1, 'ends where the Pencil ended')
        # real writing that crosses itself: passing the same area later is not a repeat
        loop = [[300 + 80 * math.cos(i / 8 * 2 * math.pi + 0.01 * i), 400 + 80 * math.sin(i / 8 * 2 * math.pi + 0.01 * i)] for i in range(60)]
        o = await page.evaluate(FEED, [loop, 3])
        check(len(o) == len(loop), f'circling over the same spot keeps every point ({len(o)}/{len(loop)})')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('FAILED' if fails else 'all ok'); raise SystemExit(1 if fails else 0)
asyncio.run(main())
