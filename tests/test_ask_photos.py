# 1.67 (Rafael: "make me able to upload pics to claude"). Ask Claude has a photo button: pictures from the camera,
# Photos or Files (also pasted or dropped) are attached like scans (up to 4 per question), made smaller (longest side
# 1568 px, JPEG) and sent to Claude with the question; they are kept in the chat history.
import asyncio, os, json, base64, io
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

def make(path, size, fmt, mode='RGB'):
    from PIL import Image, ImageDraw
    im = Image.new(mode, size, (240, 240, 235) if mode == 'RGB' else (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rectangle([size[0] // 4, size[1] // 4, size[0] // 2, size[1] // 2], fill=(20, 30, 200) if mode == 'RGB' else (20, 30, 200, 255))
    im.save(path, fmt)

async def main():
    tmp = os.environ.get('TMPDIR', '/tmp')
    big = os.path.join(tmp, 'inkwell_ask_big.jpg'); make(big, (4032, 3024), 'JPEG')
    png = os.path.join(tmp, 'inkwell_ask_clear.png'); make(png, (600, 400), 'PNG', 'RGBA')
    txt = os.path.join(tmp, 'inkwell_ask_note.txt'); open(txt, 'w').write('not a picture')
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        sent = []
        async def ask(route):
            sent.append(json.loads(route.request.post_data or '{}'))
            sse = 'event: content_block_delta\ndata: ' + json.dumps({'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'I see a blue square.'}}) + '\n\n'
            await route.fulfill(status=200, headers={'Content-Type': 'text/event-stream', 'x-ask-model': 'claude-sonnet-5-5'}, body=sse)
        await ctx.route('**/functions/v1/ask', ask)
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage(); W.Sync.sb = W.Sync.sb || {};
          W.Sync.sb.auth = {getSession: async () => ({data: {session: {access_token: 'tok'}}})}; W.Ask.open(); }""")
        ui = "(() => ({btn: !!document.getElementById('askPhoto') && document.getElementById('askPhoto').offsetWidth > 0, thumbs: [...document.querySelectorAll('#askThumbs img')].map(i => i.src.slice(0, 22)), n: document.getElementById('askAttN').textContent, ph: document.getElementById('askIn').placeholder}))()"
        u = await page.evaluate(ui)
        check(u['btn'], 'Ask Claude has a photo button')

        # a big phone photo and a transparent PNG, picked together
        await page.set_input_files('#askPhotoFile', [big, png]); await page.wait_for_timeout(1500)
        u = await page.evaluate(ui)
        check(len(u['thumbs']) == 2 and all(t == 'data:image/jpeg;base64' for t in u['thumbs']) and u['n'] == '2 pictures attached', f'two pictures attached ({u})')
        check(u['ph'] == 'Ask about them, or just Send', f'placeholder ({u["ph"]})')
        dims = await page.evaluate("Promise.all(__inkwell.Ask.pending.map(x => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = x.url; })))")
        check(dims[0] == [1568, 1176] and dims[1] == [600, 400], f'made smaller only when big ({dims})')
        size = await page.evaluate("__inkwell.Ask.pending[0].url.length")
        check(size < 700000, f'the big photo is small enough to send fast ({size // 1024} KB as text)')
        corner = await page.evaluate("""new Promise(r => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height;
          const g = c.getContext('2d'); g.drawImage(i, 0, 0); r([...g.getImageData(5, 5, 1, 1).data].slice(0, 3)); }; i.src = __inkwell.Ask.pending[1].url; })""")
        check(all(v > 240 for v in corner), f'transparent parts become white, not black ({corner})')

        # not a picture: ignored
        await page.set_input_files('#askPhotoFile', [txt]); await page.wait_for_timeout(500)
        u = await page.evaluate(ui)
        check(len(u['thumbs']) == 2, 'a file that is not a picture is not added')

        # mixed with a scan of the page, then send
        await page.evaluate("""async () => { const W = __inkwell; W.addItems([{t: 'x', id: 'xq', x: 20, y: 40, w: 300, fs: 1, html: '<p>Question</p>'}]); await W.Ask.scan(10, 30, 340, 80); }""")
        u = await page.evaluate(ui)
        check(len(u['thumbs']) == 3 and u['n'] == '3 pictures attached', f'a scan can be added too ({u["n"]})')
        await page.fill('#askIn', 'What is in these?')
        await page.click('#askSend'); await page.wait_for_timeout(1500)
        msg = sent[-1]['messages'][-1] if sent else {}
        imgs = [c for c in msg.get('content', []) if c.get('type') == 'image']
        text = ' '.join(c.get('text', '') for c in msg.get('content', []) if c.get('type') == 'text')
        check(len(imgs) == 3 and all(c['source']['media_type'] == 'image/jpeg' for c in imgs), f'Claude gets the three pictures ({len(imgs)})')
        check('What is in these?' in text and 'photos or image files' in text, f'and is told which are photos ({text[:160]!r})')
        bub = await page.evaluate("[document.querySelectorAll('.am.user img').length, document.getElementById('askAtt').hidden, (document.querySelector('.am.bot') || {}).textContent || '']")
        check(bub[0] == 3 and bub[1] and 'blue square' in bub[2], f'the pictures show in the chat and the answer comes ({bub})')

        # a photo on its own, after a reload from the history (kept as assets)
        await page.set_input_files('#askPhotoFile', [png]); await page.wait_for_timeout(800)
        await page.click('#askSend'); await page.wait_for_timeout(1500)
        msg = sent[-1]['messages'][-1]
        text = ' '.join(c.get('text', '') for c in msg['content'] if c.get('type') == 'text')
        n_imgs = sum(1 for m in sent[-1]['messages'] for c in m['content'] if c.get('type') == 'image')
        check('Help me with this question.' in text and 'A picture I uploaded' in text, f'only a photo: a default question goes with it ({text[:90]!r})')
        check(n_imgs == 4, f'earlier pictures of the chat are sent again with the follow-up ({n_imgs})')
        await page.evaluate("() => __inkwell.flushSaves()"); await page.wait_for_timeout(500)
        saved = await page.evaluate("() => { const c = [...__inkwell.docs.values()].filter(d => d.kind === 'chat'); return c.length ? c[0].data.view.filter(v => v.who === 'user').map(v => (v.as || (v.a ? [v.a] : [])).length) : []; }")
        check(saved == [3, 1], f'the pictures are kept in the chat history ({saved})')

        # more than 4: the rest is left out with a note
        await page.set_input_files('#askPhotoFile', [png, png, png, png, big]); await page.wait_for_timeout(2500)
        u = await page.evaluate(ui)
        toast = await page.evaluate("document.getElementById('toastText').textContent")
        check(len(u['thumbs']) == 4 and 'Up to 4 pictures' in toast, f'at most 4 per question ({len(u["thumbs"])}, {toast!r})')
        await page.click('#askAttX'); await page.wait_for_timeout(200)

        # paste a picture into the question box (PC)
        await page.evaluate("""async () => { const r = await fetch(__inkwell.Ask.view.length ? document.querySelector('.am.user img').src : ''); const blob = await r.blob();
          const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.jpg', {type: 'image/jpeg'}));
          const items0 = __inkwell.cur.items.size; window.__items0 = items0;
          document.getElementById('askIn').dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); }""")
        await page.wait_for_timeout(800)
        u = await page.evaluate(ui)
        same = await page.evaluate("__inkwell.cur.items.size === window.__items0")
        check(len(u['thumbs']) == 1 and same, f'pasting a picture in the question box attaches it (not onto the page) ({len(u["thumbs"])}, {same})')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
