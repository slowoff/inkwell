# 1.44: Settings → "Read handwriting & scans" has a third choice, "Docs only": imported pages (scans, photos,
# Word pages) are read for search, handwriting is not. Old saved values (true / false / missing) keep working.
import asyncio, os, json
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

STATE = '''() => { const I = window.__inkwell;
  return {pref: I.prefs.hwSearch, hw: I.HW.on(), pt: I.PT.on(),
    chosen: [...document.querySelectorAll('#setHw button.on')].map(b => b.dataset.v),
    hint: document.getElementById('setHwHint').textContent,
    stored: JSON.parse(localStorage.getItem('inkwell.prefs') || '{}').hwSearch}; }'''

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        btns = await page.evaluate("[...document.querySelectorAll('#setHw button')].map(b => b.dataset.v + ':' + b.textContent)")
        check(btns == ['on:On', 'docs:Docs only', 'off:Off'], f'three choices: {btns}')
        # guest: nothing is read in any mode
        s = await page.evaluate(STATE)
        check(not s['hw'] and not s['pt'], 'guest: nothing is read')
        # pretend to be signed in (no real sync: the workers are stopped so nothing is sent)
        await page.evaluate('''() => { const I = window.__inkwell; I.Sync.user = {id: 'u1'}; I.Sync.sb = I.Sync.sb || {};
          for(const o of [I.HW, I.PT]){ o.work = async () => {}; o.scanAll = async () => {}; } }''')
        s = await page.evaluate(STATE)
        check(s['hw'] and s['pt'], 'default (On): handwriting and imported pages are read')
        await page.evaluate("document.getElementById('settingsBtn').click()")
        await page.wait_for_selector('#setHw', state='visible')
        s = await page.evaluate(STATE)
        check(s['chosen'] == ['on'], f'On marked by default: {s["chosen"]}')
        await page.click('#setHw [data-v=docs]'); await page.wait_for_timeout(300)
        s = await page.evaluate(STATE)
        check(s['pref'] == 'docs' and s['stored'] == 'docs', f'Docs only saved: {s["pref"]} / {s["stored"]}')
        check(not s['hw'] and s['pt'], f'Docs only: handwriting off ({s["hw"]}), imported pages on ({s["pt"]})')
        check(s['chosen'] == ['docs'], f'Docs only marked: {s["chosen"]}')
        check('Only imported pages' in s['hint'] and 'Handwriting is not read' in s['hint'], f'hint: {s["hint"][:90]!r}')
        h = await page.evaluate("[...document.querySelectorAll('#setHw button')].map(b => b.getBoundingClientRect().height)")
        check(all(x == h[0] for x in h), 'buttons one row high (label does not wrap)')
        await page.click('#setHw [data-v=off]'); await page.wait_for_timeout(300)
        s = await page.evaluate(STATE)
        check(s['pref'] is False and not s['hw'] and not s['pt'], 'Off: nothing read')
        await page.click('#setHw [data-v=on]'); await page.wait_for_timeout(300)
        s = await page.evaluate(STATE)
        check(s['pref'] is True and s['hw'] and s['pt'], 'On again: both read')
        # Docs only survives a reload; old saved values still mean what they meant
        for val, want_hw, want_pt, mark in [('"docs"', False, True, 'docs'), ('false', False, False, 'off'), ('true', True, True, 'on'), (None, True, True, 'on')]:
            await page.evaluate(f'''() => {{ const p = JSON.parse(localStorage.getItem('inkwell.prefs') || '{{}}');
              {'delete p.hwSearch' if val is None else 'p.hwSearch = ' + val}; localStorage.setItem('inkwell.prefs', JSON.stringify(p)); }}''')
            await page.reload(); await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000); await page.wait_for_timeout(2500)
            await page.evaluate("() => { const I = window.__inkwell; I.Sync.user = {id: 'u1'}; I.Sync.sb = I.Sync.sb || {}; for(const o of [I.HW, I.PT]){ o.work = async () => {}; o.scanAll = async () => {}; } }")
            await page.evaluate("document.getElementById('settingsBtn').click()"); await page.wait_for_selector('#setHw', state='visible')
            s = await page.evaluate(STATE)
            check(s['hw'] == want_hw and s['pt'] == want_pt and s['chosen'] == [mark], f'saved {val}: handwriting {s["hw"]}, imported {s["pt"]}, marked {s["chosen"]}')
        check(not errs, f'no page errors {errs[:3]}')
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED'); raise SystemExit(1 if fails else 0)

asyncio.run(main())
