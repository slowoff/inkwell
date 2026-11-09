# 1.93: Homework. Select tool → Homework makes a picture of the marked part with text, due date and reminder (doc kind
# 'hw'); the top bar's Homework window lists them; Settings → Homework reminders subscribes this device to web push;
# the service worker turns a push into a notification; ?hw=<id> opens that homework.
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
          when: document.getElementById('hwWhen').value, info: document.getElementById('hwRemInfo').textContent, sel: !!__inkwell.sel,
          tomorrow: __inkwell.HWK.ymd(new Date(Date.now() + 86400000)), r: __inkwell.HWK.remindAt()}))()""")
        check(d['open'] and d['img'] > 100 and abs(d['img'] / d['imgH'] - 336 / 166) < 0.1, f'dialog opens with a picture of the box ({d["img"]}x{d["imgH"]})')
        check(d['text'] == 'Skript S. 178, Aufgabe 3', f'text from the text box inside ({d["text"]!r})')
        check(d['due'] == d['tomorrow'], f'due tomorrow by default ({d["due"]})')
        check(d['when'] in ('eve', 'morn') and d['r'] and d['r'] > 0 and d['info'].startswith('Reminder '), f'a reminder still ahead is picked ({d["when"]}, {d["info"]})')
        check(not d['sel'], 'selection closed')

        # 2. a time in the past is refused
        await page.select_option('#hwWhen', 'pick')
        await page.fill('#hwPick', '2020-01-01T08:00')
        await page.wait_for_timeout(100)
        warn = await page.evaluate("document.getElementById('hwRemInfo').classList.contains('warn')")
        await page.click('#hwSave'); await page.wait_for_timeout(300)
        check(warn and await vis('hwDlg'), 'a reminder in the past shows a warning and is not saved')
        fut = await page.evaluate("(() => { const d = new Date(Date.now() + 3 * 86400000); d.setHours(17, 30, 0, 0); return __inkwell.HWK.ymd(d) + 'T17:30'; })()")
        await page.fill('#hwPick', fut)
        await page.click('#hwSave'); await page.wait_for_timeout(800)
        h = await page.evaluate("""(() => { const l = [...__inkwell.docs.values()].filter(d => d.kind === 'hw');
          return {n: l.length, d: l[0] && l[0].data, id: l[0] && l[0].id, count: document.getElementById('hwCount').textContent, cshown: !document.getElementById('hwCount').hidden,
            page: __inkwell.cur.id, closed: document.getElementById('hwDlg').hidden}; })()""")
        x = h['d'] or {}
        exp = await page.evaluate(f"new Date('{fut}').getTime()")
        check(h['n'] == 1 and h['closed'], 'one homework doc saved, dialog closed')
        check(x.get('text') == 'Skript S. 178, Aufgabe 3' and x.get('page') == h['page'] and len(x.get('b') or []) == 4 and x.get('remind') == exp and x.get('when') == 'pick',
              f'doc holds text, page, box, picked reminder ({x})')
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
        check(v['open'] and v['t'] == 'Skript S. 178, Aufgabe 3' and v['due'] == 'Due tomorrow' and v['info'].startswith('Reminder ') and v['img'] > 100, f'view window ({v})')
        await page.click('#hwvDone'); await page.wait_for_timeout(500)
        dn = await page.evaluate(f"(() => ({{done: __inkwell.docs.get('{hid}').data.done, badge: !document.getElementById('hwCount').hidden}}))()")
        check(dn['done'] is True and not dn['badge'], f'Done ticks it off and the badge goes ({dn})')
        check(await vis('hwListDlg'), 'the list is still open under the view window')
        dl = await page.evaluate("(() => ({head: [...document.querySelectorAll('#hwList .later-head')].map(e => e.textContent), done: document.querySelectorAll('#hwList .hw-row.done').length, empty: !!document.querySelector('#hwList .later-empty')}))()")
        check(dl['done'] == 1 and dl['empty'] and any('Done' in t for t in dl['head']), f'list: nothing to do, one under Done ({dl})')
        await page.click('#hwList .later-done'); await page.wait_for_timeout(400)
        check(await page.evaluate(f"!__inkwell.docs.get('{hid}').data.done"), 'tick in the list makes it open again')

        # 4. edit: new text, no reminder
        await page.click('#hwList .later-go'); await page.wait_for_timeout(400)
        await page.click('#hwvEdit'); await page.wait_for_timeout(500)
        e = await page.evaluate("(() => ({title: document.getElementById('hwDlgTitle').textContent, when: document.getElementById('hwWhen').value, pick: document.getElementById('hwPick').value, img: document.getElementById('hwImg').naturalWidth}))()")
        check(e['title'] == 'Edit homework' and e['when'] == 'pick' and e['pick'] == fut and e['img'] > 0, f'edit window filled in ({e})')
        await page.fill('#hwText', 'Skript S. 178, Aufgabe 1-3')
        await page.select_option('#hwWhen', 'none')
        await page.click('#hwSave'); await page.wait_for_timeout(500)
        x2 = await page.evaluate(f"__inkwell.docs.get('{hid}').data")
        check(x2['text'] == 'Skript S. 178, Aufgabe 1-3' and x2['remind'] is None and x2['a'] == x['a'], f'edit saved, same picture ({x2["text"]}, {x2["remind"]})')
        await page.keyboard.press('Escape'); await page.evaluate("['hwViewDlg','hwListDlg','hwDlg'].forEach(i => document.getElementById(i).hidden = true)")

        # 5. Box over empty space: Homework in the small menu, no text
        await drag(520, 300, 660, 420)
        check(await vis('tsHw'), 'empty box: Homework button next to Copy as picture')
        await page.click('#tsHw'); await page.wait_for_timeout(1000)
        check(await vis('hwDlg') and await page.evaluate("document.getElementById('hwText').value") == '', 'dialog opens with empty text')
        await page.select_option('#hwWhen', 'none')
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

        # 7. reload keeps them; ?hw=<id> opens that homework
        await page.evaluate("__inkwell.flushSaves()"); await page.wait_for_timeout(500)
        await page.goto(URL + '?hw=' + hid); await boot(page)
        await page.wait_for_timeout(1500)
        r = await page.evaluate(f"""(() => ({{n: [...__inkwell.docs.values()].filter(d => d.kind === 'hw' && !d.deleted).length, view: !document.getElementById('hwViewDlg').hidden,
          t: document.getElementById('hwvText').textContent, url: location.search}}))()""")
        check(r['n'] == 2 and r['view'] and r['t'] == 'Skript S. 178, Aufgabe 1-3' and r['url'] == '', f'after reload: both kept, ?hw opens the view, address cleaned ({r})')
        await page.evaluate("document.getElementById('hwViewDlg').hidden = true")

        # 8. reminders on this device (faked sign-in and server)
        await page.evaluate("""() => { const W = __inkwell; W.Sync.user = {id: 'u1', email: 'r@example.com'}; window.__calls = [];
          W.HWK.call = async (a, b) => { window.__calls.push([a, b]); if(a === 'key') return {pub: 'B' + 'A'.repeat(86)}; if(a === 'test') return {status: 201}; return {ok: true}; };
          W.HWK.msg = ''; W.HWK.renderPush(); }""")
        pb = await page.evaluate("(() => ({box: !document.getElementById('pushBox').hidden, btn: document.getElementById('pushBtn').textContent, test: !document.getElementById('pushTest').hidden}))()")
        check(pb['box'] and pb['btn'] == 'Turn on' and not pb['test'], f'Settings: Homework reminders, Turn on ({pb})')
        await page.evaluate("__inkwell.HWK.turnOn()"); await page.wait_for_timeout(800)
        c = await page.evaluate("(() => ({calls: window.__calls, opts: window.__subOpts, ls: localStorage.getItem('inkwell.push'), btn: document.getElementById('pushBtn').textContent, test: !document.getElementById('pushTest').hidden, on: __inkwell.HWK.pushOn()}))()")
        acts = [a for a, _ in c['calls']]
        sub = next((b_ for a, b_ in c['calls'] if a == 'sub'), {}) or {}
        check(acts[:3] == ['key', 'sub', 'test'], f'turning on asks for the key, sends the subscription, sends a test ({acts})')
        check(sub.get('sub', {}).get('endpoint') == 'https://web.push.apple.com/fake-endpoint-123' and len(sub.get('sub', {}).get('keys', {}).get('auth', '')) == 22 and sub.get('dev') == 'Computer', f'subscription sent ({sub})')
        check(c['opts'] == {'uv': True, 'key': 65}, f'subscribed with the 65-byte server key, visible only ({c["opts"]})')
        check(c['on'] and c['btn'] == 'Turn off' and c['test'], f'shows as on ({c["btn"]})')
        await page.evaluate("__inkwell.HWK.turnOff()"); await page.wait_for_timeout(600)
        c2 = await page.evaluate("(() => ({last: window.__calls[window.__calls.length - 1], on: __inkwell.HWK.pushOn(), un: window.__unsubbed, btn: document.getElementById('pushBtn').textContent}))()")
        check(c2['last'][0] == 'unsub' and not c2['on'] and c2['un'] == 1 and c2['btn'] == 'Turn on', f'turning off unsubscribes here and on the server ({c2})')

        # 9. the service worker turns a push into a notification, and a tap focuses the open window with the homework id.
        # sw.js runs here with fake self/registration/clients (headless Chromium cannot show notifications)
        sw = await page.evaluate("""async (hid) => {
          const src = await (await fetch('sw.js')).text(), H = {}, shown = [], posted = [], opened = []; let focused = 0;
          const self = {addEventListener: (t, f) => { H[t] = f; }, registration: {scope: location.origin + '/', showNotification: async (t, o) => { shown.push({t, o}); }},
            clients: {matchAll: async () => [{postMessage: m => posted.push(m), focus: async () => { focused++; }}], openWindow: async u => { opened.push(u); }, claim: async () => {}},
            skipWaiting(){}};
          new Function('self', 'caches', src)(self, {});
          let wait;
          H.push({data: {json: () => ({title: 'Homework · due Tue 10 Nov', body: 'Skript S. 178', id: hid, tag: 'hw-' + hid})}, waitUntil: p => { wait = p; }});
          await wait;
          let closed = 0;
          H.notificationclick({notification: {data: {hw: hid}, close: () => { closed++; }}, waitUntil: p => { wait = p; }});
          await wait;
          // no window open: a new one at ?hw=<id>
          self.clients.matchAll = async () => [];
          H.notificationclick({notification: {data: {hw: hid}, close: () => {}}, waitUntil: p => { wait = p; }});
          await wait;
          return {shown, posted, focused, closed, opened};
        }""", hid)
        n0 = sw['shown'][0] if sw['shown'] else {}
        check(len(sw['shown']) == 1 and n0.get('t') == 'Homework · due Tue 10 Nov' and n0['o']['body'] == 'Skript S. 178' and n0['o']['data'] == {'hw': hid} and n0['o']['tag'] == 'hw-' + hid,
              f'push becomes a notification ({sw["shown"]})')
        check(sw['closed'] == 1 and sw['focused'] == 1 and sw['posted'] == [{'hw': hid}], f'tapping it focuses Inkwell and names the homework ({sw["posted"]})')
        check(len(sw['opened']) == 1 and sw['opened'][0].endswith('/?hw=' + hid), f'with Inkwell closed it opens ?hw=<id> ({sw["opened"]})')
        # the message a tapped notification sends to an open window
        await page.evaluate(f"__inkwell.HWK.showSoon('{hid}')"); await page.wait_for_timeout(500)
        check(await vis('hwViewDlg'), 'tapped notification opens the homework')

        # 10. phone width: dialogs fit
        await page.set_viewport_size({'width': 390, 'height': 760}); await page.wait_for_timeout(400)
        fit = await page.evaluate("(() => { const r = document.querySelector('#hwViewDlg .dlg').getBoundingClientRect(); return [r.left, r.right, r.bottom]; })()")
        check(fit[0] >= 0 and fit[1] <= 390 and fit[2] <= 760, f'view window fits a phone ({fit})')

        check(not errs, f'no page errors ({errs})')
        await b.close()
    print('ALL OK' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
