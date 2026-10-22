# 1.59.1: the same page open on two devices. Before, the open page stayed "dirty" in memory after the first edit,
# so every change from the other device was merged AND uploaded straight back; the two devices kept bouncing the
# page, and when two uploads crossed, the older copy overwrote the server and the newest strokes were deleted.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SETUP = """async () => {
  const W = __inkwell;
  await W.newPage(); await new Promise(r => setTimeout(r, 300));
  const cid = 'c_' + W.cur.id;
  const mk = (id, x) => ({t: 's', id, c: '#000', w: 2, hl: 0, p: [x, 10, .5, x + 5, 20, .5, x + 10, 10, .5]});
  // a tiny fake server: one docs table, server_ts counter
  const rows = new Map(); let n = 0;
  const q = () => {
    const o = {_in: null,
      select(){ return o; }, in(col, ids){ o._in = ids; return o; },
      gt(){ return o; }, order(){ return o; }, limit(){ return Promise.resolve({data: [], error: null}); },
      upsert(list){ o._up = list; return o; },
      then(res, rej){
        let data;
        if(o._up){ data = o._up.map(r => { const ts = 'ts' + (++n); rows.set(r.id, {...JSON.parse(JSON.stringify(r)), server_ts: ts}); return {id: r.id, server_ts: ts}; }); }
        else data = (o._in || []).map(id => rows.get(id)).filter(Boolean);
        return Promise.resolve({data, error: null}).then(res, rej);
      }};
    return o;
  };
  W.Sync.sb = {from: () => q()};
  W.Sync.user = {id: 'u1'};
  window.__fake = {rows, mk, cid, uploads: () => n};
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
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate(SETUP)

        # 1) after an upload the open page counts as synced (in memory too)
        r = await page.evaluate("""async () => {
          const W = __inkwell, F = __fake;
          W.addItems([F.mk('a', 0)]); await W.flushSaves();
          const before = W.cur.crec.dirty;
          await W.Sync.push();
          const rec = await W.IDB.get('docs', F.cid);
          return {before, mem: W.cur.crec.dirty, idb: rec.dirty, server: F.rows.has(F.cid)};
        }""")
        check(r['before'] == 1 and r['server'], 'page uploaded')
        check(r['mem'] == 0 and r['idb'] == 0, f'open page synced after upload (memory {r["mem"]}, stored {r["idb"]})')

        # 2) idle device gets the other device's stroke: shown, stored as synced, nothing sent back
        r = await page.evaluate("""async () => {
          const W = __inkwell, F = __fake;
          const row = JSON.parse(JSON.stringify(F.rows.get(F.cid)));
          row.data.items.push({...row.data.items[0], id: 'other'}); row.updated_at = Date.now(); row.server_ts = 'remote1';
          const ups = F.uploads();
          await W.applyRemote(row);
          await new Promise(r => setTimeout(r, 900)); await W.flushSaves();
          const rec = await W.IDB.get('docs', F.cid);
          await W.Sync.push();
          return {shown: W.cur.items.has('other'), dirty: rec.dirty, sent: F.uploads() - ups};
        }""")
        check(r['shown'], "other device's stroke shown")
        check(r['dirty'] == 0 and r['sent'] == 0, f'idle device does not send the page back (dirty {r["dirty"]}, uploads {r["sent"]})')

        # 3) crossing uploads: the server ends up with an older copy that lacks a stroke just written here
        r = await page.evaluate("""async () => {
          const W = __inkwell, F = __fake;
          W.addItems([F.mk('new1', 100)]); W.addItems([F.mk('new2', 200)]); await W.flushSaves();
          await W.Sync.push();                          // base now holds new1/new2
          const base = await W.baseGet(F.cid);
          const older = JSON.parse(JSON.stringify(F.rows.get(F.cid)));
          older.data.items = older.data.items.filter(i => i.id !== 'new1' && i.id !== 'new2');
          older.server_ts = 'stale'; older.updated_at = Date.now();
          await W.applyRemote(older);
          await W.flushSaves();
          const saved = (await W.IDB.get('docs', F.cid)).data.items.map(i => i.id);
          return {screen: ['new1', 'new2'].filter(id => W.cur.items.has(id)), saved: ['new1', 'new2'].filter(id => saved.includes(id)), hadBase: !!base};
        }""")
        check(r['hadBase'], 'base stored')
        check(len(r['screen']) == 2, f'new strokes stay on the page after an older copy arrives ({r["screen"]})')
        check(len(r['saved']) == 2, f'new strokes stay saved ({r["saved"]})')

        # 4) erasing on the other device still works for strokes that are not new here
        r = await page.evaluate("""async () => {
          const W = __inkwell, F = __fake;
          W.freshItems.delete('a');                    // 'a' was written long ago
          await W.flushSaves(); await W.Sync.push();
          const row = JSON.parse(JSON.stringify(F.rows.get(F.cid)));
          row.data.items = row.data.items.filter(i => i.id !== 'a'); row.server_ts = 'erase1'; row.updated_at = Date.now();
          W.addItems([F.mk('busy', 300)]);             // something unsaved here, so the merge path runs
          await W.applyRemote(row); await W.flushSaves();
          return {a: W.cur.items.has('a'), busy: W.cur.items.has('busy')};
        }""")
        check(not r['a'], 'a stroke erased on the other device is removed here')
        check(r['busy'], 'stroke written meanwhile kept')

        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
