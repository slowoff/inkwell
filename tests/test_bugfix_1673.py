# 1.67.3 (bug check 2026-10-27): fixes found by reading the code, each checked here.
# 1. Pictures waiting to upload (meta pendingAssets) were read and written back in two steps: pictures saved at the same
#    time as each other or as an upload could drop out of the list and never upload. Now one transaction each.
# 2. One picture that keeps failing to upload no longer blocks all the others behind it.
# 3. Once a day, pictures on this device that a note uses but that are neither on the server nor waiting are queued again.
# 4. Free up space counted only the first scan of a Claude question with several scans (field "as") as used.
# 5. "Starting is taking too long" stayed over the app after a slow start.
# 6. With a window open (Settings …), Backspace deleted the selection behind it and letters switched the tool.
# 7. A Claude question that failed (no connection, server error) lost the typed text and the attached pictures.
import asyncio, os, json
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def ready(page):
    await page.goto(URL); await page.wait_for_timeout(3000)
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('!!(window.__inkwell && window.__inkwellBooted)', timeout=15000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await ready(page)

        # ---- 1. no picture drops out of the upload list
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          await W.IDB.put('meta', [], 'pendingAssets');
          const up = [];
          W.Files.on = async () => true; W.Files.full = null;
          W.Files.upload = (id) => new Promise(res => setTimeout(() => { up.push(id); res(); }, 4));
          const blob = () => new Blob([new Uint8Array(200)], {type: 'image/jpeg'});
          // an upload running while 40 pictures are saved, 10 at a time at the same moment
          const run = (async () => { for(let i = 0; i < 30; i++){ await W.Sync.pushAssets(); await new Promise(r => setTimeout(r, 3)); } })();
          const ids = [];
          for(let k = 0; k < 4; k++) ids.push(...await Promise.all(Array.from({length: 10}, () => W.saveAsset(blob()))));
          await run;
          for(let i = 0; i < 5; i++) await W.Sync.pushAssets();
          const left = (await W.IDB.get('meta', 'pendingAssets')) || [];
          return {saved: ids.length, uploaded: ids.filter(id => up.includes(id)).length, left: left.length};
        }""")
        check(r['uploaded'] == 40 and r['left'] == 0, f'40 pictures saved at the same time as uploads: all uploaded, none left ({r})')

        # ---- 2. a picture that keeps failing does not block the others
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          await W.IDB.put('meta', [], 'pendingAssets');
          const blob = () => new Blob([new Uint8Array(200)], {type: 'image/jpeg'});
          const bad = await W.saveAsset(blob()), good1 = await W.saveAsset(blob()), good2 = await W.saveAsset(blob());
          const up = [];
          W.Files.upload = async (id) => { if(id === bad) throw new Error('Google Drive upload failed (400)'); up.push(id); };
          let err = '';
          try { await W.Sync.pushAssets(); } catch(e){ err = e.message; }
          const left = (await W.IDB.get('meta', 'pendingAssets')) || [];
          return {up: up.length, both: up.includes(good1) && up.includes(good2), err, left, bad};
        }""")
        check(r['both'] and r['left'] == [r['bad']] and 'failed (400)' in r['err'], f'a failing picture is skipped, the others upload, the error is still reported ({r})')

        # ---- 3. daily repair of pictures that dropped out of the list
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          await W.IDB.put('meta', [], 'pendingAssets');
          const blob = new Blob([new Uint8Array(100)], {type: 'image/jpeg'});
          for(const id of ['a-lost1', 'a-onserver', 'a-unused']) await W.IDB.put('assets', {id, blob, type: 'image/jpeg'});
          await W.IDB.put('docs', {id: 'c_repairtest', kind: 'content', deleted: false, updated: Date.now(), dirty: 0,
            data: {bg: {type: 'blank'}, items: [{t: 'i', id: 'i1', x: 0, y: 0, w: 10, h: 10, a: 'a-lost1'}, {t: 'i', id: 'i2', x: 0, y: 20, w: 10, h: 10, a: 'a-onserver'}]}});
          const oldUser = W.Sync.user;
          W.Sync.user = {id: 'u-repair'}; await W.IDB.put('meta', 'u-repair', 'owner');
          const A = window.Acct || null;
          let calls = 0;
          W.Files.call = async (action) => { calls++; if(action === 'list') return {files: [{id: 'a-onserver', bytes: 100}]}; return {}; };
          try { localStorage.removeItem('inkwell.assetCheck'); } catch {}
          return {owner: A && A.owner};
        }""")
        # Acct is a top-level const (not on window): set its owner through an inline script
        await page.add_script_tag(content="Acct.owner = 'u-repair';")
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          await W.Sync.repairAssets();
          const p1 = (await W.IDB.get('meta', 'pendingAssets')) || [];
          await W.IDB.put('meta', [], 'pendingAssets');
          await W.Sync.repairAssets();   // same day: not again
          const p2 = (await W.IDB.get('meta', 'pendingAssets')) || [];
          return {p1, p2, note: JSON.parse(localStorage.getItem('inkwell.assetCheck') || 'null')};
        }""")
        check(r['p1'] == ['a-lost1'], f'a used picture on this device but not on the server is queued again; ones on the server or unused are not ({r["p1"]})')
        check(r['p2'] == [] and r['note'] and r['note'].get('found') == 1, f'checked once a day ({r})')
        await page.add_script_tag(content="Acct.owner = null;")
        await page.evaluate("async () => { __inkwell.Sync.user = null; await __inkwell.IDB.del('meta', 'owner'); await __inkwell.IDB.del('docs', 'c_repairtest'); }")

        # ---- 4. Free up space keeps every scan of a Claude question
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          await W.IDB.put('meta', [], 'pendingAssets');
          const blob = new Blob([new Uint8Array(100)], {type: 'image/jpeg'});
          for(const id of ['a-scan1', 'a-scan2', 'a-scan3', 'a-junk']) await W.IDB.put('assets', {id, blob, type: 'image/jpeg'});
          await W.IDB.put('docs', {id: 'chat-test', kind: 'chat', deleted: false, updated: Date.now(), dirty: 0,
            data: {title: 'x', at: Date.now(), msgs: [{role: 'user', content: [{type: 'image', a: 'a-scan1'}, {type: 'image', a: 'a-scan2'}, {type: 'image', a: 'a-scan3'}]}],
                   view: [{who: 'user', text: 'q', a: 'a-scan1', as: ['a-scan1', 'a-scan2', 'a-scan3']}]}});
          const refs = [...W.assetRefs({view: [{a: 'a-scan1', as: ['a-scan1', 'a-scan2']}]}, new Set())];
          const plan = await W.cleanScan();
          const ids = plan.local.map(x => x.id);
          // the same chat, saved by a version before 1.52 had msgs with a only: only "as" in view
          await W.IDB.put('docs', {id: 'chat-test', kind: 'chat', deleted: false, updated: Date.now(), dirty: 0,
            data: {title: 'x', at: Date.now(), msgs: [], view: [{who: 'user', text: 'q', a: 'a-scan1', as: ['a-scan1', 'a-scan2', 'a-scan3']}]}});
          const ids2 = (await W.cleanScan()).local.map(x => x.id);
          await W.IDB.del('docs', 'chat-test');
          return {refs, ids, ids2};
        }""")
        check(set(r['refs']) == {'a-scan1', 'a-scan2'}, f'assetRefs reads "as" ({r["refs"]})')
        check('a-junk' in r['ids2'] and not ({'a-scan2', 'a-scan3'} & set(r['ids2'])), f'Free up space keeps the 2nd and 3rd scan of a question, removes only unused pictures ({r["ids2"]})')

        # ---- 6. shortcuts are off while a window is open
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          if(!W.cur) await W.newPage();
          W.setTool('pen');
          const it = {t: 's', id: 's' + Date.now(), c: 'auto', w: 3, hl: 0, p: [100, 100, 0.5, 200, 120, 0.5, 300, 140, 0.5]};
          W.addItems([it]); W.selectIds([it.id]);
          document.activeElement && document.activeElement.blur && document.activeElement.blur();
          document.getElementById('settingsBtn').click();
          await new Promise(r => setTimeout(r, 300));
          const open = !document.getElementById('settingsDlg').hidden;
          const key = k => document.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true}));
          key('Backspace'); key('e');
          const kept = W.cur.items.has(it.id), tool1 = W.prefs.tool;
          document.querySelectorAll('.modal').forEach(m => m.hidden = true);
          W.selectIds([it.id]);
          key('Backspace');
          return {open, kept, tool1, gone: !W.cur.items.has(it.id)};
        }""")
        check(r['open'] and r['kept'] and r['tool1'] == 'pen', f'with Settings open, Backspace and E do nothing to the page ({r})')
        check(r['gone'], 'with no window open, Backspace still deletes the selection')
        r = await page.evaluate("""() => { try { document.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true})); return 'ok'; } catch(e){ return String(e); } }""")
        check(r == 'ok', 'a key event without a key does not throw')

        # ---- 7. a failed Claude question keeps its text and pictures
        async def ask_route(route):
            await route.fulfill(status=500, content_type='application/json', body=json.dumps({'error': 'server', 'message': 'boom'}))
        await ctx.route('**/functions/v1/ask', ask_route)   # registered last, so it is matched before the abort-all route
        r = await page.evaluate("""async () => {
          const W = __inkwell;
          W.Sync.sb = {auth: {getSession: async () => ({data: {session: {access_token: 'x'}}})}};
          W.Ask.open();
          const c = document.createElement('canvas'); c.width = c.height = 20; c.getContext('2d').fillRect(0, 0, 10, 10);
          W.Ask.pending = [{url: c.toDataURL('image/jpeg'), typed: '', box: null, photo: true}]; W.Ask.renderPending();
          document.getElementById('askIn').value = 'What is this?';
          await W.Ask.submit();
          return {text: document.getElementById('askIn').value, pend: (W.Ask.pending || []).length, err: (document.querySelector('#askLog .am.err') || {}).textContent || '', busy: W.Ask.busy};
        }""")
        check(r['text'] == 'What is this?' and r['pend'] == 1 and 'boom' in r['err'] and not r['busy'], f'after a failed question the text and the picture are back ({r})')
        r = await page.evaluate("""async () => {
          const W = __inkwell; W.Ask.reset();
          W.Sync.sb = {auth: {getSession: async () => ({data: {session: null}})}};
          document.getElementById('askIn').value = 'Hello';
          await W.Ask.submit();
          return document.getElementById('askIn').value;
        }""")
        check(r == 'Hello', f'not signed in: the text stays too ({r!r})')
        check(not errs, f'no page errors {errs[:3]}')
        await ctx.close()

        # ---- 5. a slow start: the "taking too long" box goes away once Inkwell has started
        ctx2 = await b.new_context(viewport={'width': 1180, 'height': 820}, service_workers='block')
        await ctx2.route('**/*.supabase.co/**', lambda r: r.abort())
        async def slow(route):
            await asyncio.sleep(9.5)
            await route.continue_()
        await ctx2.route('**/app/13-start.js', slow)
        pg = await ctx2.new_page(); errs2 = []
        pg.on('pageerror', lambda e: errs2.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_timeout(8800)
        box1 = await pg.evaluate("() => !!document.getElementById('inkwellStuck')")
        await pg.wait_for_function('window.__inkwellBooted === true', timeout=20000)
        await pg.wait_for_timeout(300)
        box2 = await pg.evaluate("() => !!document.getElementById('inkwellStuck')")
        check(box1 and not box2, f'"taking too long" shows during a slow start and goes away when started ({box1}, {box2})')
        check(not errs2, f'no page errors {errs2[:3]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
