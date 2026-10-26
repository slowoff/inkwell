# 1.63.1: page history keeps the newest 10 versions of a page (was 30); older ones are purged when a new one is saved.
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
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        await page.wait_for_function('!!(window.__inkwell && window.__inkwell.cur)', timeout=15000)
        r = await page.evaluate("""async () => {
          const W = __inkwell; await W.newPage(); const pid = W.cur.id;
          const counts = [];
          for(let k = 0; k < 14; k++){
            const items = [{t: 's', id: 's' + k, c: '#000', w: 2, hl: 0, p: (k * 7) + ',0,10,1,1,10'}];
            await W.saveVersion(pid, {bg: {type: 'blank'}, items}, 'edit');
            counts.push((await W.versionsOf(pid)).length);
          }
          const vs = await W.versionsOf(pid);
          const all = (await W.IDB.all('docs')).filter(d => d.kind === 'ver' && d.id.startsWith('v_' + pid + '_'));
          return {counts, kept: vs.map(v => v.data.items[0].id), purged: all.filter(d => d.deleted && !d.data).length};
        }""")
        print(' versions after each save:', r['counts'])
        check(max(r['counts']) == 10 and r['counts'][-1] == 10, f'at most 10 versions per page ({r["counts"]})')
        check(r['kept'] == ['s%d' % k for k in range(13, 3, -1)], f'the newest 10 are kept, newest first ({r["kept"]})')
        check(r['purged'] == 4, f'older versions are purged (data removed) ({r["purged"]})')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
