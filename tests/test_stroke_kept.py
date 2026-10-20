# 1.48.1: strokes written while a change for the open page arrives from sync are never lost
# (before: the merge took a snapshot of the page, saved a backup version, then put the snapshot back,
# dropping every stroke finished during that save).
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

RACE = """async (n) => {
  const W = __inkwell, c = W.cur, pid = c.id, cid = 'c_' + pid;
  const mk = (id, x) => ({t: 's', id, c: '#000', w: 2, hl: 0, p: [x, 10, .5, x + 5, 20, .5, x + 10, 10, .5]});
  // a page with some writing (big, so the backup copy takes a moment like on the iPad), already synced
  const many = []; for(let i = 0; i < 400; i++) many.push(mk('old' + i, i));
  W.addItems(many); await W.flushSaves();
  const ser = it => ({...it, p: it.p});
  const base = (await W.IDB.get('docs', cid)).data;
  await W.baseSet(cid, base, 't1');
  // another device added one stroke
  const remote = JSON.parse(JSON.stringify(base)); remote.items.push((await (async () => { W.addItems([mk('tmp', 999)]); await W.flushSaves(); const d = (await W.IDB.get('docs', cid)).data; const s = d.items.find(i => i.id === 'tmp'); W.removeItems(['tmp']); return {...s, id: 'other'}; })()));
  await W.flushSaves();
  // a local stroke not saved yet (so the merge path runs), then the remote change arrives while more strokes are written
  W.addItems([mk('mine0', 2000)]);
  const p = W.mergeCurrent({id: cid, kind: 'content', data: remote, deleted: false, updated_at: Date.now() - 5000, server_ts: 't2'}, {d: base, ts: 't1'});
  const added = ['mine0'];
  let done = false; p.then(() => { done = true; });
  for(let k = 1; k <= n && !done; k++){ await new Promise(r => setTimeout(r, 0)); W.addItems([mk('mine' + k, 2000 + k)]); added.push('mine' + k); }
  await p; await W.flushSaves();
  const onScreen = new Set(W.cur.items.keys());
  const saved = new Set((await W.IDB.get('docs', cid)).data.items.map(i => i.id));
  return {added: added.length, lostScreen: added.filter(id => !onScreen.has(id)), lostSaved: added.filter(id => !saved.has(id)), other: onScreen.has('other'), old: [...onScreen].filter(i => i.startsWith('old')).length};
}"""

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
        # the first start installs the offline copy and reloads once; let that happen before writing
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        tot = {'added': 0, 'lostScreen': [], 'lostSaved': [], 'other': True, 'old': 400}
        for run in range(8):   # timing differs per run; repeat so a race shows up
            await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
            r = await page.evaluate(RACE, 2000)
            tot['added'] += r['added']; tot['lostScreen'] += r['lostScreen']; tot['lostSaved'] += r['lostSaved']
            tot['other'] = tot['other'] and r['other']; tot['old'] = min(tot['old'], r['old'])
        r = tot
        print('   ', {k: (len(v) if isinstance(v, list) else v) for k, v in r.items()})
        check(r['added'] > 1, f'strokes were written while the change was merged ({r["added"]})')
        check(not r['lostScreen'], f'no stroke vanished from the page ({len(r["lostScreen"])} lost)')
        check(not r['lostSaved'], f'every stroke was saved ({len(r["lostSaved"])} lost)')
        check(r['other'], "the other device's stroke arrived")
        check(r['old'] == 400, f'older writing kept ({r["old"]})')

        # Pencil cases (CDP pen events)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('pen'); }"); await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        cdp = await ctx.new_cdp_session(page)
        async def pen(t, x, y, f=0.5):
            await cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': st[0] + x, 'y': st[1] + y, 'button': 'left', 'buttons': 1 if t != 'mouseReleased' else 0, 'clickCount': 1, 'pointerType': 'pen', 'force': f})
        n = lambda: page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 's').length")
        wheel = lambda: page.evaluate("!document.getElementById('wheel').hidden")
        import math
        # a small "o" (7 px across): half of it, then the Pencil rests 700 ms on the paper, then the rest
        # (the time is in the pause, so the check does not depend on how fast the test machine is)
        await pen('mousePressed', 300, 300)
        for k in range(1, 36):
            a = 2 * math.pi * k / 35
            await pen('mouseMoved', 300 + 3.5 - 3.5 * math.cos(a), 300 + 3.5 * math.sin(a))
            if k == 18: await page.wait_for_timeout(700)
        await pen('mouseReleased', 300, 300); await page.wait_for_timeout(300)
        check(await n() == 1 and not await wheel(), 'a small letter written slowly stays (no Pencil menu)')
        # holding the Pencil still with a little tremor still opens the Pencil menu
        await pen('mousePressed', 500, 400)
        for k in range(30):
            await pen('mouseMoved', 500 + (0.6 if k % 2 else -0.6), 400 + (0.5 if k % 3 else -0.4))
        await page.wait_for_timeout(700)
        ok = await wheel()
        await pen('mouseReleased', 500, 400); await page.wait_for_timeout(200)
        check(ok and await n() == 1, f'holding the Pencil still still opens the Pencil menu ({ok})')
        await page.evaluate("() => __inkwell.closeWheel()"); await page.wait_for_timeout(300)
        # a Pencil stroke that iPadOS cancels keeps what was drawn
        await page.evaluate('''() => { const s = document.getElementById('stage'), r = s.getBoundingClientRect();
          const ev = (t, x, y) => s.dispatchEvent(new PointerEvent(t, {pointerId: 77, pointerType: 'pen', isPrimary: true, pressure: .5, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, buttons: t === 'pointercancel' ? 0 : 1}));
          ev('pointerdown', 200, 500); ev('pointermove', 215, 505); ev('pointercancel', 215, 505); }''')
        await page.wait_for_timeout(200)
        check(await n() == 2, 'a cancelled Pencil stroke is kept')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
