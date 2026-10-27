# 1.68: Ask Claude history can be filtered to chats from this page, its section, its notebook, or all.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
SHOT = os.environ.get('SHOT_DIR', '')
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

SETUP = """async () => {
  const mk = (kind, data, id) => newDoc(kind, data, id);
  await mk('nb', {name: 'Filter A', color: 1, order: 50}, 'nb-fa');
  await mk('nb', {name: 'Filter B', color: 2, order: 51}, 'nb-fb');
  await mk('sec', {nb: 'nb-fa', name: 'Physics', color: 1, order: 0}, 'sec-f1');
  await mk('sec', {nb: 'nb-fa', name: 'Maths', color: 2, order: 1}, 'sec-f2');
  await mk('sec', {nb: 'nb-fb', name: 'Ideas', color: 3, order: 0}, 'sec-f3');
  for(const [id, sec, t] of [['pg-f1', 'sec-f1', 'Forces'], ['pg-f2', 'sec-f1', 'Energy'], ['pg-f3', 'sec-f2', 'Functions'], ['pg-f4', 'sec-f3', 'Random']]){
    await mk('page', {sec, title: t, order: 0, snippet: ''}, id);
    await writeDoc({id: 'c_' + id, kind: 'content', data: {bg: {type: 'blank'}, items: []}, deleted: false});
  }
  const chat = (id, at, pages) => mk('chat', {title: 'Chat ' + id, at, page: pages[0] || null, mode: 'tutor', msgs: [],
    view: pages.length ? pages.map(p => ({who: 'user', text: 'q', page: p})).concat([{who: 'bot', text: 'a'}]) : [{who: 'user', text: 'q'}, {who: 'bot', text: 'a'}]}, 'chat-' + id);
  await chat('c1', 6, ['pg-f1']); await chat('c2', 5, ['pg-f2']); await chat('c3', 4, ['pg-f3']);
  await chat('c4', 3, ['pg-f4']); await chat('c5', 2, ['pg-f4', 'pg-f1']); await chat('c6', 1, []);
}"""
STATE = """() => ({
  rows: [...document.querySelectorAll('#askLog .ah-row')].map(r => r.dataset.chat.replace('chat-', '')),
  btns: [...document.querySelectorAll('#askLog [data-af]')].map(b => [b.dataset.af, b.classList.contains('on'), b.disabled, b.querySelector('.ah-n').textContent]),
  empty: (document.querySelector('#askLog .ask-empty') || {}).textContent || ''
})"""
async def pick(page, k):
    await page.evaluate(f"() => document.querySelector('#askLog [data-af=\"{k}\"]').click()")
    await page.wait_for_timeout(120)
    return await page.evaluate(STATE)

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
        await page.wait_for_function('!!(window.__inkwell && window.__inkwellBooted)', timeout=15000)
        await page.evaluate(SETUP)
        await page.evaluate("async () => { await __inkwell.openPage('pg-f1'); __inkwell.Ask.open(); __inkwell.Ask.showHistory(); }")
        await page.wait_for_timeout(200)
        s = await page.evaluate(STATE)
        check([x[0] for x in s['btns']] == ['page', 'sec', 'nb', 'all'], f'filter buttons Page, Section, Notebook, All ({s["btns"]})')
        counts = {x[0]: x[3] for x in s['btns']}
        check(counts == {'page': '2', 'sec': '3', 'nb': '4', 'all': '6'}, f'counts: page 2, section 3, notebook 4, all 6 ({counts})')
        check(s['btns'][3][1] and len(s['rows']) == 6, f'All by default, newest first ({s["rows"]})')
        s = await pick(page, 'page')
        check(s['rows'] == ['c1', 'c5'], f'Page: chats asked from this page, also a chat that went across pages ({s["rows"]})')
        s = await pick(page, 'sec')
        check(s['rows'] == ['c1', 'c2', 'c5'], f'Section: chats from any page in Physics ({s["rows"]})')
        s = await pick(page, 'nb')
        check(s['rows'] == ['c1', 'c2', 'c3', 'c5'], f'Notebook: chats from any page in Filter A ({s["rows"]})')
        if SHOT: await page.locator('#askPanel').screenshot(path=os.path.join(SHOT, 'chat_filter.png'))
        # the filter follows the open page while the history is shown
        await page.evaluate("async () => { await __inkwell.openPage('pg-f4'); }"); await page.wait_for_timeout(200)
        s = await page.evaluate(STATE)
        check(s['rows'] == ['c4', 'c5'] and [x for x in s['btns'] if x[1]][0][0] == 'nb', f'opening another page updates the list (Notebook of Random: {s["rows"]})')
        # a page without chats: a clear empty message
        await page.evaluate("async () => { await __inkwell.openPage('pg-f2'); }"); await page.wait_for_timeout(150)
        s = await pick(page, 'page')
        check(s['rows'] == ['c2'], f'Page filter on Energy ({s["rows"]})')
        await page.evaluate("async () => { await __inkwell.openPage('pg-f3'); }"); await page.wait_for_timeout(150)
        s = await page.evaluate(STATE)
        check(s['rows'] == ['c3'], f'Functions page: its chat ({s["rows"]})')
        await page.evaluate("async () => { const W = __inkwell; await W.newPage(); }"); await page.wait_for_timeout(150)
        s = await page.evaluate(STATE)
        check(s['rows'] == [] and 'No chats from this page yet' in s['empty'], f'new page: "No chats from this page yet." ({s["empty"]!r})')
        # opening a chat from the filtered list still works
        await page.evaluate("async () => { await __inkwell.openPage('pg-f1'); }"); await page.wait_for_timeout(150)
        await page.evaluate("() => document.querySelector('#askLog .ah-row[data-chat=\"chat-c5\"] .ah-open').click()"); await page.wait_for_timeout(150)
        check(await page.evaluate("__inkwell.Ask.chatId") == 'chat-c5' and not await page.evaluate("__inkwell.Ask.histOpen"), 'tapping a chat in the filtered list opens it')
        # remembered after a restart
        await page.evaluate("() => __inkwell.flushSaves()")
        await page.reload(); await page.wait_for_function('!!(window.__inkwell && window.__inkwellBooted)', timeout=15000); await page.wait_for_timeout(500)
        await page.evaluate("async () => { await __inkwell.openPage('pg-f1'); __inkwell.Ask.open(); __inkwell.Ask.showHistory(); }"); await page.wait_for_timeout(200)
        s = await page.evaluate(STATE)
        check([x for x in s['btns'] if x[1]][0][0] == 'page' and s['rows'] == ['c1', 'c5'], f'the chosen filter is remembered ({s["btns"]})')
        # no page open: only All
        await page.evaluate("() => showEmpty()"); await page.evaluate("() => __inkwell.Ask.showHistory()"); await page.wait_for_timeout(100)
        s = await page.evaluate(STATE)
        check([x[2] for x in s['btns']] == [True, True, True, False] and len(s['rows']) == 6, f'no page open: only All, all chats ({s["btns"]})')
        # narrow screen: the buttons fit
        await page.set_viewport_size({'width': 390, 'height': 800}); await page.wait_for_timeout(300)
        await page.evaluate("async () => { await __inkwell.openPage('pg-f1'); __inkwell.Ask.open(); __inkwell.Ask.showHistory(); }"); await page.wait_for_timeout(200)
        fit = await page.evaluate("() => { const f = document.querySelector('#askLog .ah-filter'), log = document.getElementById('askLog'); return {f: f.scrollWidth <= f.clientWidth + 1, inside: f.getBoundingClientRect().right <= log.getBoundingClientRect().right + 1}; }")
        check(fit['f'] and fit['inside'], f'the filter fits the panel on a phone-size screen ({fit})')
        if SHOT: await page.locator('#askPanel').screenshot(path=os.path.join(SHOT, 'chat_filter_narrow.png'))
        check(not errs, f'no page errors {errs[:3]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
