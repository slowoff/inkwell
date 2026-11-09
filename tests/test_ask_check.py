# 1.96: Ask Claude "Check" mode: says only whether his answers are right or wrong.
# The menu has it, a scan sent with no text asks "Check my answer.", the request carries mode 'check',
# the chat history labels it Check and gets a scanned-question title, and it survives reopening the chat.
import asyncio, json, os
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
        sent = []
        async def ask(route):
            sent.append(json.loads(route.request.post_data or '{}'))
            sse = 'event: content_block_delta\ndata: ' + json.dumps({'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'a) **Right**\nb) **Wrong** the unit is missing.\n\n1/2 right'}}) + '\n\n'
            await route.fulfill(status=200, headers={'Content-Type': 'text/event-stream', 'x-ask-model': 'claude-sonnet-5-5'}, body=sse)
        await ctx.route('**/functions/v1/ask', ask)
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
        await page.evaluate("""async () => { const W = __inkwell; await W.newPage(); W.Sync.sb = W.Sync.sb || {};
          W.Sync.sb.auth = {getSession: async () => ({data: {session: {access_token: 'tok'}}})}; W.Ask.open(); }""")
        opts = await page.evaluate("[...document.querySelectorAll('#askModeSel option')].map(o => o.value + ':' + o.textContent)")
        check(opts == ['normal:Normal', 'tutor:Tutor', 'solve:Solve', 'check:Check', 'practice:Practice'], f'menu has Check after Solve ({opts})')
        await page.evaluate("() => { const s = document.getElementById('askModeSel'); s.value = 'check'; s.dispatchEvent(new Event('change')); }"); await page.wait_for_timeout(200)
        st = await page.evaluate("[__inkwell.prefs.askMode, document.getElementById('askModeSel').value, document.getElementById('askModeSel').title]")
        check(st[0] == 'check' and st[1] == 'check' and 'right or wrong' in st[2], f'choosing it sticks ({st})')
        empty = await page.evaluate("document.getElementById('askLog').textContent")
        check('Check only tells you whether your answer is right or wrong' in empty, 'start text explains Check')

        await page.evaluate("""async () => { const W = __inkwell; W.addItems([{t: 'x', id: 'xq', x: 20, y: 40, w: 300, fs: 1, html: '<p>a) 2+2 = 4  b) 3 m * 2 = 6</p>'}]); await W.Ask.scan(10, 30, 340, 80); }""")
        await page.click('#askSend'); await page.wait_for_timeout(1500)
        body = sent[-1] if sent else {}
        text = ' '.join(c.get('text', '') for c in body.get('messages', [{}])[-1].get('content', []) if c.get('type') == 'text')
        check(body.get('mode') == 'check', f"request goes out in check mode ({body.get('mode')})")
        check('Check my answer.' in text, f'a scan with no text asks to check it ({text[:80]!r})')
        bot = await page.evaluate("(document.querySelector('.am.bot') || {}).textContent || ''")
        check('Right' in bot and 'Wrong' in bot, 'the verdict shows')

        await page.wait_for_timeout(800)
        h = await page.evaluate("""() => { const W = __inkwell; W.Ask.histOpen = true; W.Ask.renderHist && W.Ask.renderHist();
            const c = [...W.docs.values()].find(d => d.type === 'chat' || (d.data && d.data.view));
            return {mode: c && c.data.mode, title: c && c.data.title}; }""")
        check(h['mode'] == 'check', f'the chat is saved as a Check chat ({h})')
        check(h['title'] and h['title'].startswith('Scanned question'), f'and gets the scanned-question title, not "Check my answer." ({h})')
        # Tutor still works after
        await page.evaluate("() => { const s = document.getElementById('askModeSel'); s.value = 'tutor'; s.dispatchEvent(new Event('change')); }"); await page.wait_for_timeout(200)
        check(await page.evaluate("__inkwell.prefs.askMode") == 'tutor', 'switching back to Tutor works')
        check(not errs, f'no page errors {errs}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    if fails: raise SystemExit(1)

asyncio.run(main())
