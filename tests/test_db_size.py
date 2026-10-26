# 1.64: Settings → Your notes shows how full the notes server is (of 500 MB) via the database function db_size;
# from 80 % a reminder once a day. Without the function (not set up yet) nothing shows and nothing breaks.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

FAKE = """mode => {
  const W = __inkwell;
  W.Sync.user = {id: 'u1', email: 'a@gmail.com'};
  W.Sync.sb = Object.assign(W.Sync.sb || {}, {rpc: async name => {
    window.__rpcCalls = (window.__rpcCalls || 0) + 1;
    if(name !== 'db_size') return {data: null, error: {message: 'other'}};
    if(mode === 'missing') return {data: null, error: {code: 'PGRST202', message: 'Could not find the function public.db_size without parameters in the schema cache'}, status: 404};
    return {data: mode * 1048576, error: null, status: 200};
  }});
  W.DbSize.mb = null; W.DbSize.at = 0; W.DbSize.missing = false;
  try { localStorage.removeItem('inkwell.dbWarn'); } catch {}
}"""

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
        await page.wait_for_function('!!(window.__inkwell && window.__inkwell.DbSize)', timeout=15000)
        state = lambda: page.evaluate("""() => ({hidden: document.getElementById('dbRow').hidden, info: document.getElementById('dbInfo').textContent,
            w: document.getElementById('dbUsed').style.width, near: document.getElementById('dbBar').classList.contains('near'),
            full: document.getElementById('dbBar').classList.contains('full'), toast: !document.getElementById('toast').hidden ? document.getElementById('toastText').textContent : ''})""")

        # not set up on the server yet: no line, no reminder, no errors
        await page.evaluate(FAKE, 'missing')
        await page.evaluate("async () => { await __inkwell.DbSize.check(); document.getElementById('settingsBtn').click(); await new Promise(r => setTimeout(r, 400)); }")
        s = await state()
        check(s['hidden'] and 'server' not in s['toast'], f'without db_size on the server: nothing shown ({s})')
        calls = await page.evaluate("async () => { const n = window.__rpcCalls; await __inkwell.DbSize.check(); await __inkwell.DbSize.get(true); return window.__rpcCalls - n; }")
        check(calls == 0, f'and it is not asked again this session ({calls} more calls)')
        await page.evaluate("() => document.querySelectorAll('.modal').forEach(m => m.hidden = true)")

        # 29 MB: line in Settings, no reminder
        await page.evaluate(FAKE, 29)
        await page.evaluate("async () => { await __inkwell.DbSize.check(); document.getElementById('settingsBtn').click(); await new Promise(r => setTimeout(r, 400)); }")
        s = await state()
        check(not s['hidden'] and s['info'] == 'Notes server: 29 MB of 500 MB' and s['w'] == '5.8%' and not s['near'], f'29 MB: "Notes server: 29 MB of 500 MB" ({s})')
        check('server' not in s['toast'], 'no reminder under 80 %')
        await page.evaluate("() => document.querySelectorAll('.modal').forEach(m => m.hidden = true)")

        # 420 MB (84 %): nearly full, reminder once a day
        await page.evaluate(FAKE, 420)
        await page.evaluate("async () => { await __inkwell.DbSize.check(); }")
        t1 = (await state())['toast']
        await page.evaluate("async () => { document.getElementById('toast').hidden = true; __inkwell.DbSize.at = 0; await __inkwell.DbSize.check(); }")
        t2 = (await state())['toast']
        check('84 % full' in t1 and t2 == '', f'over 80 %: a reminder, only once a day ({t1!r} / {t2!r})')
        await page.evaluate("async () => { document.getElementById('settingsBtn').click(); await new Promise(r => setTimeout(r, 400)); }")
        s = await state()
        check(s['near'] and s['info'].endswith('nearly full'), f'Settings shows it nearly full ({s})')
        await page.evaluate("() => document.querySelectorAll('.modal').forEach(m => m.hidden = true)")

        # 485 MB (97 %): almost full
        await page.evaluate(FAKE, 485)
        await page.evaluate("async () => { await __inkwell.DbSize.check(); document.getElementById('settingsBtn').click(); await new Promise(r => setTimeout(r, 400)); }")
        s = await state()
        check(s['full'] and 'stop syncing' in s['info'], f'over 95 %: almost full ({s})')

        # asked at most once an hour
        calls = await page.evaluate("async () => { const n = window.__rpcCalls; for(let i = 0; i < 5; i++) await __inkwell.DbSize.check(); return window.__rpcCalls - n; }")
        check(calls == 0, f'not asked more than once an hour ({calls} extra calls)')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
