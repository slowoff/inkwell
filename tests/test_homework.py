# 1.93: Homework. Select tool → Homework makes a picture of the marked part with text and due date (doc kind 'hw');
# the top bar's Homework window lists them. 1.93.1 (Rafael: "remove the notification thing from homework"): no Reminder
# choice, no Settings → Homework reminders, sw.js shows no notifications, an old push subscription on the device is
# dropped once, ?hw=<id> (old reminder links) opens the list.
import asyncio, os, json
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

async def boot(page):
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

# a fake browser push subscription (the real one needs Google's/Apple's push service)
FAKE_PUSH = """
(() => {
  const sub = {endpoint: 'https://web.push.apple.com/fake-endpoint-123',
    toJSON(){ return {endpoint: this.endpoint, keys: {p256dh: 'B' + 'A'.repeat(86), auth: 'C'.repeat(22)}}; },
    unsubscribe: async () => { window.__unsubbed = (window.__unsubbed || 0) + 1; window.__hasSub = false; return true; }};
  // headless Chromium reports 'denied' here even with the permission granted (requestPermission says 'granted')
  try { Object.defineProperty(Notification, 'permission', {get: () => 'granted'}); } catch {}
  if(window.PushManager){
    PushManager.prototype.subscribe = async function(o){ window.__subOpts = {uv: o.userVisibleOnly, key: o.applicationServerKey && o.applicationServerKey.length}; window.__hasSub = true; return sub; };
    PushManager.prototype.getSubscription = async function(){ return window.__hasSub ? sub : null; };
  }
})();
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820}, permissions=['notifications'])
        await ctx.add_init_script(FAKE_PUSH)
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await boot(page)
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage();
          const p = []; for(let i = 0; i < 30; i++) p.push(100 + i * 5, 120 + Math.sin(i / 3) * 10, 0.5);
          W.addItems([{t: 's', id: 'sA', c: '#c00', w: 3, p}, {t: 'x', id: 'xA', x: 100, y: 200, w: 260, fs: 1, html: '<p>Skript S. 178, Aufgabe 3</p>'}]);
          W.cam.z = 1; W.cam.ox = 20; W.cam.oy = 20; W.invalidate(); W.setTool('lasso'); }""")
        await page.wait_for_timeout(300)
        await page.click('#lassoMode [data-m="box"]')
        st = await page.evaluate("(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.left, b.top]; })()")
        def scr(x, y): return (st[0] + 20 + x, st[1] + 20 + y)
        async def drag(x0, y0, x1, y1):
            await page.mouse.move(*scr(x0, y0)); await page.mouse.down()
            for k in range(1, 13): await page.mouse.move(*scr(x0 + (x1 - x0) * k / 12, y0 + (y1 - y0) * k / 12))
            await page.mouse.up(); await page.wait_for_timeout(300)
        vis = lambda i: page.evaluate(f"!document.getElementById('{i}').hidden")

        # 1. the Homework button in the selection menu
        await drag(80, 90, 400, 240)
        check(await vis('selHw'), 'selection menu has Homework')
        await page.click('#selHw'); await page.wait_for_timeout(1200)
        d = await page.evaluate("""(() => ({open: !document.getElementById('hwDlg').hidden, img: document.getElementById('hwImg').naturalWidth,
          imgH: document.getElementById('hwImg').naturalHeight, text: document.getElementById('hwText').value, due: document.getElementById('hwDue').value,
          sel: !!__inkwell.sel, rem: !!document.querySelector('#hwWhen,#hwPick,#hwRemInfo'),
          tomorrow: __inkwell.HWK.ymd(new Date(Date.now() + 86400000))}))()""")
        check(d['open'] and d['img'] > 100 and abs(d['img'] / d['imgH'] - 336 / 166) < 0.1, f'dialog opens with a picture of the box ({d["img"]}x{d["imgH"]})')
        check(d['text'] == 'Skript S. 178, Aufgabe 3', f'text from the text box inside ({d["text"]!r})')
        check(d['due'] == d['tomorrow'], f'due tomorrow by default ({d["due"]})')
        check(not d['rem'], 'no Reminder choice in the window')
        check(not d['sel'], 'selection closed')

        # 2. save
        await page.click('#hwSave'); await page.wait_for_timeout(800)
        h = await page.evaluate("""(() => { const l = [...__inkwell.docs.values()].filter(d => d.kind === 'hw');
          return {n: l.length, d: l[0] && l[0].data, id: l[0] && l[0].id, count: document.getElementById('hwCount').textContent, cshown: !document.getElementById('hwCount').hidden,
            page: __inkwell.cur.id, closed: document.getElementById('hwDlg').hidden}; })()""")
        x = h['d'] or {}
        check(h['n'] == 1 and h['closed'], 'one homework doc saved, dialog closed')
        check(x.get('text') == 'Skript S. 178, Aufgabe 3' and x.get('page') == h['page'] and len(x.get('b') or []) == 4 and x.get('remind') is None and x.get('due') == d['tomorrow'],
              f'doc holds text, page, box, due date, no reminder ({x})')
        asset = await page.evaluate(f"__inkwell.IDB.get('assets', '{x.get('a')}').then(r => !!(r && r.blob && r.blob.size > 1000))")
        check(asset, 'picture saved as an asset')
        check(h['cshown'] and h['count'] == '1', f'badge on the Homework button ({h["count"]})')
        hid = h['id']

        # 3. the list and the view window
        await page.click('#hwBtn'); await page.wait_for_timeout(800)
        l = await page.evaluate("""(() => ({open: !document.getElementById('hwListDlg').hidden, rows: document.querySelectorAll('#hwList .hw-row').length,
          txt: document.querySelector('#hwList .hw-row b') && document.querySelector('#hwList .hw-row b').textContent,
          img: document.querySelector('#hwList .hw-pv') && (document.querySelector('#hwList .hw-pv').src || '').startsWith('blob:') ? 1 : 0,
          due: document.querySelector('#hwList .later-txt span').textContent}))()""")
        check(l['open'] and l['rows'] == 1 and l['txt'] == 'Skript S. 178, Aufgabe 3' and l['img'] > 0 and l['due'] == 'Due tomorrow', f'list shows the homework with picture and due date ({l})')
        await page.click('#hwList .later-go'); await page.wait_for_timeout(600)
        v = await page.evaluate("""(() => ({open: !document.getElementById('hwViewDlg').hidden, t: document.getElementById('hwvText').textContent, due: document.getElementById('hwvDue').textContent,
          info: document.getElementById('hwvInfo').textContent, img: document.getElementById('hwvImg').naturalWidth}))()""")
        check(v['open'] and v['t'] == 'Skript S. 178, Aufgabe 3' and v['due'] == 'Due tomorrow' and 'eminder' not in v['info'] and v['img'] > 100, f'view window ({v})')
        await page.click('#hwvDone'); await page.wait_for_timeout(500)
        dn = await page.evaluate(f"(() => ({{done: __inkwell.docs.get('{hid}').data.done, badge: !document.getElementById('hwCount').hidden}}))()")
        check(dn['done'] is True and not dn['badge'], f'Done ticks it off and the badge goes ({dn})')
        check(await vis('hwListDlg'), 'the list is still open under the view window')
        dl = await page.evaluate("(() => ({head: [...document.querySelectorAll('#hwList .later-head')].map(e => e.textContent), done: document.querySelectorAll('#hwList .hw-row.done').length, empty: !!document.querySelector('#hwList .later-empty')}))()")
        check(dl['done'] == 1 and dl['empty'] and any('Done' in t for t in dl['head']), f'list: nothing to do, one under Done ({dl})')
        await page.click('#hwList .later-done'); await page.wait_for_timeout(400)
        check(await page.evaluate(f"!__inkwell.docs.get('{hid}').data.done"), 'tick in the list makes it open again')

        # 4. edit: new text
        await page.click('#hwList .later-go'); await page.wait_for_timeout(400)
        await page.click('#hwvEdit'); await page.wait_for_timeout(500)
        e = await page.evaluate("(() => ({title: document.getElementById('hwDlgTitle').textContent, due: document.getElementById('hwDue').value, img: document.getElementById('hwImg').naturalWidth}))()")
        check(e['title'] == 'Edit homework' and e['due'] == d['tomorrow'] and e['img'] > 0, f'edit window filled in ({e})')
        await page.fill('#hwText', 'Skript S. 178, Aufgabe 1-3')
        await page.click('#hwSave'); await page.wait_for_timeout(500)
        x2 = await page.evaluate(f"__inkwell.docs.get('{hid}').data")
        check(x2['text'] == 'Skript S. 178, Aufgabe 1-3' and x2['remind'] is None and x2['a'] == x['a'], f'edit saved, same picture ({x2["text"]}, {x2["remind"]})')
        await page.keyboard.press('Escape'); await page.evaluate("['hwViewDlg','hwListDlg','hwDlg'].forEach(i => document.getElementById(i).hidden = true)")

        # 5. Box over empty space: Homework in the small menu, no text
        await drag(520, 300, 660, 420)
        check(await vis('tsHw'), 'empty box: Homework button next to Copy as picture')
        await page.click('#tsHw'); await page.wait_for_timeout(1000)
        check(await vis('hwDlg') and await page.evaluate("document.getElementById('hwText').value") == '', 'dialog opens with empty text')
        await page.fill('#hwText', 'Learn vocab')
        await page.click('#hwSave'); await page.wait_for_timeout(600)
        check(await page.evaluate("[...__inkwell.docs.values()].filter(d => d.kind === 'hw' && !d.deleted).length") == 2, 'second homework added')

        # 6. delete with undo
        id2 = await page.evaluate("[...__inkwell.docs.values()].find(d => d.kind === 'hw' && d.data && d.data.text === 'Learn vocab').id")
        await page.evaluate(f"__inkwell.HWK.view('{id2}')"); await page.wait_for_timeout(300)
        await page.click('#hwvDel'); await page.wait_for_timeout(400)
        gone = await page.evaluate(f"(() => {{ const d = __inkwell.docs.get('{id2}'); return !d || d.deleted; }})()")
        await page.click('.toast button'); await page.wait_for_timeout(500)
        back = await page.evaluate(f"(() => {{ const d = __inkwell.docs.get('{id2}'); return !!(d && !d.deleted && d.data && d.data.text === 'Learn vocab'); }})()")
        check(gone and back, f'delete removes it, Undo brings it back ({gone}, {back})')

        # 7. reload keeps them; an old reminder link ?hw=<id> opens the list
        await page.evaluate("__inkwell.flushSaves()"); await page.wait_for_timeout(500)
        await page.goto(URL + '?hw=' + hid); await boot(page)
        await page.wait_for_timeout(1500)
        r = await page.evaluate("""(() => ({n: [...__inkwell.docs.values()].filter(d => d.kind === 'hw' && !d.deleted).length, list: !document.getElementById('hwListDlg').hidden,
          url: location.search}))()""")
        check(r['n'] == 2 and r['list'] and r['url'] == '', f'after reload: both kept, ?hw opens the list, address cleaned ({r})')
        await page.evaluate("document.getElementById('hwListDlg').hidden = true")

        # 8. no reminders anywhere: Settings has no Homework reminders box; sw.js has no push / notificationclick
        check(await page.evaluate("!document.getElementById('pushBox') && !document.getElementById('pushBtn')"), 'Settings: no Homework reminders')
        swsrc = await page.evaluate("fetch('sw.js').then(r => r.text())")
        check("'push'" not in swsrc and 'notificationclick' not in swsrc and 'showNotification' not in swsrc, 'service worker shows no notifications')
        # 9. a device that had reminders on drops its subscription once (browser and server list) and forgets it
        await page.evaluate("""() => { localStorage.setItem('inkwell.push', JSON.stringify('https://web.push.apple.com/fake-endpoint-123')); localStorage.setItem('inkwell.pushKey', JSON.stringify('Bxx')); window.__hasSub = true; window.__unsubbed = 0;
          const W = __inkwell; W.Sync.sb = {auth: {getSession: async () => ({data: {session: {access_token: 'tok'}}})}}; }""")
        calls = []
        async def fn(route):
            if route.request.method == 'POST': calls.append(route.request.post_data)
            await route.fulfill(status=200, body='{"ok":true}', headers={'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*'})
        await ctx.route('**/functions/v1/push', fn)   # registered last, so it runs before the catch-all abort
        await page.evaluate("__inkwell.HWK.dropPush()"); await page.wait_for_timeout(600)
        dp = await page.evaluate("(() => ({un: window.__unsubbed, ls: localStorage.getItem('inkwell.push'), k: localStorage.getItem('inkwell.pushKey')}))()")
        check(dp['un'] == 1 and dp['ls'] in (None, 'null') and dp['k'] in (None, 'null'), f'old subscription dropped on the device ({dp})')
        check(len(calls) == 1 and '"unsub"' in (calls[0] or '') and 'fake-endpoint-123' in calls[0], f'and removed from the server list ({calls})')
        await page.evaluate("__inkwell.HWK.dropPush()"); await page.wait_for_timeout(300)
        check(len(calls) == 1, 'only once')
        await page.evaluate(f"__inkwell.HWK.view('{hid}')"); await page.wait_for_timeout(400)

        # 10. phone width: dialogs fit
        await page.set_viewport_size({'width': 390, 'height': 760}); await page.wait_for_timeout(400)
        fit = await page.evaluate("(() => { const r = document.querySelector('#hwViewDlg .dlg').getBoundingClientRect(); return [r.left, r.right, r.bottom]; })()")
        check(fit[0] >= 0 and fit[1] <= 390 and fit[2] <= 760, f'view window fits a phone ({fit})')

        check(not errs, f'no page errors ({errs})')
        await b.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
