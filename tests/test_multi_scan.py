# 1.52: several scans in a row.
# Paper scan: "Choose photos" takes several photos (check each with Add & next, or Add all); after "Add & scan next"
# with the camera, the window shows "Take next photo" (iPad Safari only opens the camera right after a tap).
# Ask Claude: up to 4 scanned parts go out together in one question (+ Scan more, x on each thumbnail).
import asyncio, os, io, json
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

def sheet_photo(path, shade):
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (900, 1200), (60, 55, 50)); d = ImageDraw.Draw(im)
    d.polygon([(120, 110), (790, 140), (770, 1090), (100, 1060)], fill=(245, 244, 240))
    for i in range(8): d.line([(180, 220 + i * 90), (700, 230 + i * 90)], fill=(shade, shade, shade), width=6)
    im.save(path, 'JPEG', quality=90)

async def boot(page):
    await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
    await page.wait_for_timeout(2500)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

async def main():
    tmp = os.environ.get('TMPDIR', '/tmp')
    photos = []
    for i, sh in enumerate([20, 70, 120, 40]):
        pth = os.path.join(tmp, f'inkwell_scan_{i}.jpg'); sheet_photo(pth, sh); photos.append(pth)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await boot(page)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(300)
        pics = "[...__inkwell.cur.items.values()].filter(i => i.t === 'i' && i.doc).length"
        async def open_scan():
            await page.evaluate("document.getElementById('scanBtn').click()"); await page.wait_for_timeout(200)
        async def ui():
            return await page.evaluate("""(() => ({pick: !document.getElementById('scanPick').hidden, setup: !document.getElementById('scanSetup').hidden,
              open: !document.getElementById('scanDlg').hidden, next: document.getElementById('scanNext').textContent, go: document.getElementById('scanGo').textContent,
              all: document.getElementById('scanAll').hidden ? '' : document.getElementById('scanAll').textContent, msg: document.getElementById('scanPickMsg').textContent,
              take: document.getElementById('scanTake').textContent.trim(), done: !document.getElementById('scanDone').hidden, status: document.getElementById('scanStatus').textContent}))()""")

        # 1. Choose photos: 3 at once, check the first, Add & next, then Add all for the rest
        await open_scan()
        u = await ui()
        check(u['pick'] and u['take'] == 'Take photo' and not u['done'], f'window opens on the start view ({u["take"]})')
        await page.set_input_files('#scanFiles', photos[:3]); await page.wait_for_timeout(1200)
        u = await ui()
        check(u['setup'] and u['next'] == 'Add & next (1 of 3)' and u['all'] == 'Add all 3 as they are' and 'Photo 1 of 3' in u['status'], f'3 photos chosen: first one to check ({u})')
        await page.click('#scanNext'); await page.wait_for_timeout(2500)
        u = await ui(); n = await page.evaluate(pics)
        check(n == 1 and u['setup'] and u['next'] == 'Add & next (2 of 3)' and 'Photo 2 of 3' in u['status'], f'first added, second shown ({n} on page, {u["next"]})')
        await page.click('#scanAll'); await page.wait_for_timeout(5000)
        u = await ui(); n = await page.evaluate(pics)
        check(n == 3 and not u['open'], f'Add all puts the rest on the page and closes ({n} on page)')
        ys = await page.evaluate("[...__inkwell.cur.items.values()].filter(i => i.t === 'i' && i.doc).map(i => [i.y, i.h])")
        check(all(ys[i + 1][0] >= ys[i][0] + ys[i][1] for i in range(len(ys) - 1)), f'scans stacked one under another ({[round(y) for y, h in ys]})')

        # 2. camera: Add & scan next shows "Take next photo"; Done closes
        await open_scan()
        await page.set_input_files('#scanFile', photos[3]); await page.wait_for_timeout(1200)
        u = await ui()
        check(u['setup'] and u['next'] == 'Add & scan next' and u['go'] == 'Add to page' and u['all'] == '', f'one camera photo: normal buttons ({u["next"]} / {u["go"]})')
        await page.click('#scanNext'); await page.wait_for_timeout(2500)
        u = await ui(); n = await page.evaluate(pics)
        check(n == 4 and u['pick'] and u['take'] == 'Take next photo' and u['done'] and u['msg'].startswith('1 scan added'), f'after Add & scan next: Take next photo + Done ({u["msg"]})')
        await page.set_input_files('#scanFile', photos[0]); await page.wait_for_timeout(1200)
        await page.click('#scanNext'); await page.wait_for_timeout(2500)
        u = await ui()
        check(u['msg'].startswith('2 scans added'), f'counter goes up ({u["msg"]})')
        await page.click('#scanDone'); await page.wait_for_timeout(200)
        u = await ui(); n = await page.evaluate(pics)
        check(not u['open'] and n == 5, f'Done closes, 5 scans on the page ({n})')

        # 3. Retake inside a batch replaces only the current photo
        await open_scan()
        await page.set_input_files('#scanFiles', photos[:2]); await page.wait_for_timeout(1200)
        async with page.expect_file_chooser() as fc:
            await page.click('#scanRetake')
        await (await fc.value).set_files(photos[3]); await page.wait_for_timeout(1200)
        u = await ui()
        check(u['setup'] and u['next'] == 'Add & next (1 of 2)', f'retake keeps the place in the batch ({u["next"]})')
        await page.click('#scanGo'); await page.wait_for_timeout(2500)
        u = await ui(); n = await page.evaluate(pics)
        check(not u['open'] and n == 6, f'Add & finish adds the current one and closes ({n})')

        # 4. Ask Claude: three scanned parts in one question
        sent = []
        async def ask(route):
            body = json.loads(route.request.post_data or '{}'); sent.append(body)
            sse = 'event: content_block_delta\ndata: ' + json.dumps({'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'Got 3 scans.'}}) + '\n\n'
            await route.fulfill(status=200, headers={'Content-Type': 'text/event-stream', 'x-ask-model': 'claude-haiku-5-5'}, body=sse)
        await ctx.route('**/functions/v1/ask', ask)   # registered last, so it is tried first
        await page.evaluate("""() => { const W = __inkwell; W.Sync.sb = W.Sync.sb || {}; W.Sync.sb.auth = {getSession: async () => ({data: {session: {access_token: 'tok'}}})};
          W.addItems([{t: 'x', id: 'xq1', x: 20, y: 40, w: 300, fs: 1, html: '<p>Question one</p>'}, {t: 'x', id: 'xq2', x: 20, y: 200, w: 300, fs: 1, html: '<p>Question two</p>'},
                      {t: 'x', id: 'xq3', x: 20, y: 360, w: 300, fs: 1, html: '<p>Question three</p>'}]); W.Ask.open(); }""")
        await page.wait_for_timeout(300)
        await page.evaluate("async () => { const A = __inkwell.Ask; await A.scan(10, 30, 340, 80); await A.scan(10, 190, 340, 240); await A.scan(10, 350, 340, 400); }")
        await page.wait_for_timeout(200)
        a = await page.evaluate("(() => ({thumbs: document.querySelectorAll('#askThumbs img').length, n: document.getElementById('askAttN').textContent, more: !document.getElementById('askAttMore').hidden, ph: document.getElementById('askIn').placeholder}))()")
        check(a['thumbs'] == 3 and a['n'] == '3 scans attached' and a['more'] and 'scans' in a['ph'], f'3 scans attached with + Scan more ({a})')
        await page.evaluate("document.querySelectorAll('.ask-thumb-x')[1].click()"); await page.wait_for_timeout(100)
        a = await page.evaluate("(() => ({thumbs: document.querySelectorAll('#askThumbs img').length, n: document.getElementById('askAttN').textContent}))()")
        check(a['thumbs'] == 2 and a['n'] == '2 scans attached', f'x removes one scan ({a})')
        await page.evaluate("async () => { await __inkwell.Ask.scan(10, 190, 340, 240); }")
        await page.click('#askAttMore'); await page.wait_for_timeout(200)
        pk = await page.evaluate("document.getElementById('stage').classList.contains('picking')")
        check(pk, '+ Scan more starts drawing another box')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(100)
        await page.evaluate("document.getElementById('askSend').click()"); await page.wait_for_timeout(1500)
        check(len(sent) == 1, f'one request sent ({len(sent)})')
        if sent:
            last = sent[0]['messages'][-1]['content']
            imgs = [c for c in last if c.get('type') == 'image']; txt = ' '.join(c.get('text', '') for c in last if c.get('type') == 'text')
            check(len(imgs) == 3, f'the question carries 3 pictures ({len(imgs)})')
            check('3 scanned parts' in txt and 'Scan 1:' in txt and 'Question one' in txt and 'Question two' in txt, f'text says how many and has the typed text of each ({txt[:160]!r})')
        v = await page.evaluate("(() => { const u = __inkwell.Ask.view.find(v => v.who === 'user'); return {as: u && u.as ? u.as.length : 0, a: !!(u && u.a), att: !document.getElementById('askAtt').hidden, bub: document.querySelectorAll('.am.user img').length}; })()")
        check(v['as'] == 3 and v['a'] and not v['att'] and v['bub'] == 3, f'chat shows the 3 scans, stored as a + as ({v})')

        # 5. limit of 4
        await page.evaluate("async () => { const A = __inkwell.Ask; for(let i = 0; i < 5; i++) await A.scan(10, 30, 340, 80); }")
        a = await page.evaluate("(() => ({thumbs: document.querySelectorAll('#askThumbs img').length, more: !document.getElementById('askAttMore').hidden}))()")
        check(a['thumbs'] == 4 and not a['more'], f'at most 4 scans, + Scan more hidden at 4 ({a})')

        # 6. old chats (one scan in a) still show
        await page.evaluate("""async () => { const A = __inkwell.Ask; A.view = [{who: 'user', text: 'old', a: A.view.find(v => v.who === 'user').a}, {who: 'bot', text: 'ok'}]; A.showChat && A.showChat(); }""")
        await page.wait_for_timeout(300)
        if os.environ.get('SNAP_SHOT'): await page.screenshot(path=os.environ['SNAP_SHOT'])
        check(not errs, f'no page errors ({errs[:2]})')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
