# 1.66 (Rafael: "add a language choice and stuff to the spell check"): Inkwell's own spell checker (Hunspell in a
# worker, built-in word lists). Wrong words get a red wavy line (CSS highlight, the text is not changed); the word
# being typed is only marked once the cursor leaves it; tapping a wrong word shows fixes and "Add to dictionary";
# the language is picked in the Spelling menu and kept per text box; works offline once a language was used.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

MARKED = "() => { const h = window.CSS && CSS.highlights && CSS.highlights.get('inkspell'); return h ? [...h].map(r => r.toString()) : []; }"
BOX = "() => { const ed = document.querySelector('.it-text[contenteditable=true]'); return ed ? {html: ed.innerHTML, text: ed.textContent, native: ed.spellcheck, lang: ed.getAttribute('lang')} : null; }"

async def ready(page):
    await page.wait_for_function('!!window.__inkwellBooted', timeout=15000)
    await page.wait_for_timeout(300)

async def wait_marked(page, want, ms=8000):
    for _ in range(ms // 200):
        m = await page.evaluate(MARKED)
        if sorted(m) == sorted(want): return m
        await page.wait_for_timeout(200)
    return await page.evaluate(MARKED)

async def caret_in(page, word, at=2):
    await page.evaluate("""([w, at]) => { const ed = document.querySelector('.it-text[contenteditable=true]');
      const tw = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n;
      while((n = tw.nextNode())){ const i = n.data.indexOf(w); if(i >= 0){ const r = document.createRange(); r.setStart(n, i + at); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); return; } } }""", [word, at])
    await page.wait_for_timeout(700)

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
        await ready(page)
        await page.evaluate("async () => { await __inkwell.newPage(); __inkwell.setTool('text'); }"); await page.wait_for_timeout(300)
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        await page.mouse.click(st[0] + 200, st[1] + 200); await page.wait_for_timeout(300)

        # the Spelling button opens a menu: on/off and the language
        await page.click('#fmtBar [data-act="spell"]'); await page.wait_for_timeout(200)
        pop = await page.evaluate("() => ({shown: !document.getElementById('spellPop').hidden, langs: [...document.querySelectorAll('#spellLangs [data-lang]')].map(b => b.textContent), on: document.querySelector('#spellPop [data-spell=on]').classList.contains('on')})")
        check(pop['shown'] and pop['on'] and len(pop['langs']) == 6 and 'Deutsch (Schweiz)' in pop['langs'] and 'Português (Brasil)' in pop['langs'], f'Spelling menu: on, 6 languages ({pop})')
        await page.click('#spellLangs [data-lang="de-CH"]'); await page.wait_for_timeout(200)
        s = await page.evaluate(BOX)
        focus = await page.evaluate("() => document.activeElement && document.activeElement.classList.contains('it-text')")
        check(s and s['lang'] == 'de-CH' and focus, f'picking a language keeps the box open ({s and s["lang"]}, focus {focus})')
        await page.mouse.click(st[0] + 700, st[1] + 600); await page.wait_for_timeout(100)   # close the menu
        await page.mouse.click(st[0] + 200, st[1] + 200); await page.wait_for_timeout(300)

        await page.keyboard.type('Ich gehe in die Schulle, die Strasse ist grösser. Mathematikunterricht macht Spass ')
        m = await wait_marked(page, ['Schulle'])
        s = await page.evaluate(BOX)
        check(m == ['Schulle'], f'German (Switzerland): only the wrong word is marked, compounds and ss are fine ({m})')
        check('<' not in s['html'].replace('<br>', ''), f'the marks do not change the text ({s["html"][:80]})')
        check(s['native'] is False, 'the system spell check is off in the box (no double marks)')

        # the word being typed is not marked until the cursor leaves it
        await page.keyboard.type('Hasu')
        await page.wait_for_timeout(1200)
        m = await page.evaluate(MARKED)
        check('Hasu' not in m, f'the word being typed is not marked yet ({m})')
        await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('Home')
        m = await wait_marked(page, ['Schulle', 'Hasu'])
        check(sorted(m) == ['Hasu', 'Schulle'], f'when the cursor leaves it, it is marked ({m})')

        # tap a wrong word: fixes
        await caret_in(page, 'Schulle')
        bar = await page.evaluate("() => ({shown: !document.getElementById('spellBar').hidden, fixes: [...document.querySelectorAll('#spellBar [data-fix]')].map(b => b.dataset.fix), add: !!document.querySelector('#spellBar [data-add]')})")
        for _ in range(20):
            if bar['fixes']: break
            await page.wait_for_timeout(200)
            bar = await page.evaluate("() => ({shown: !document.getElementById('spellBar').hidden, fixes: [...document.querySelectorAll('#spellBar [data-fix]')].map(b => b.dataset.fix), add: !!document.querySelector('#spellBar [data-add]')})")
        check(bar['shown'] and 'Schule' in bar['fixes'] and bar['add'], f'tapping a wrong word shows fixes and Add to dictionary ({bar})')
        if 'Schule' in bar['fixes']:
            await page.click('#spellBar [data-fix="Schule"]'); await page.wait_for_timeout(300)
        s = await page.evaluate(BOX)
        m = await wait_marked(page, ['Hasu'])
        check('die Schule, die' in s['text'] and m == ['Hasu'], f'picking a fix replaces the word ({s["text"][:40]}, {m})')
        hidden = await page.evaluate("() => document.getElementById('spellBar').hidden")
        check(hidden, 'the fixes close after picking one')
        n = await page.evaluate("() => __inkwell.cur.items.size")
        await page.keyboard.press('Control+z'); await page.wait_for_timeout(300)
        s2 = await page.evaluate(BOX)
        check(s2 and 'Schulle' in s2['text'], f'undo brings the old word back ({s2 and s2["text"][:40]})')
        await page.keyboard.press('Control+Shift+z'); await page.keyboard.press('Control+y'); await page.wait_for_timeout(300)

        # add to dictionary
        await caret_in(page, 'Hasu')
        for _ in range(20):
            if await page.evaluate("() => !document.getElementById('spellBar').hidden"): break
            await page.wait_for_timeout(200)
        await page.click('#spellBar [data-add]'); await page.wait_for_timeout(300)
        words = await page.evaluate("() => __inkwell.prefs.spellWords")
        m = await page.evaluate(MARKED)
        check('Hasu' in (words or []) and 'Hasu' not in m, f'Add to dictionary: not marked any more ({words}, {m})')

        # second box in English (UK)
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        await page.mouse.click(st[0] + 200, st[1] + 420); await page.wait_for_timeout(300)
        s = await page.evaluate(BOX)
        check(s and s['lang'] == 'de-CH', f'a new box starts in the last picked language ({s and s["lang"]})')
        await page.click('#fmtBar [data-act="spell"]'); await page.wait_for_timeout(200)
        await page.click('#spellLangs [data-lang="en-GB"]'); await page.wait_for_timeout(200)
        await page.keyboard.press('Escape')
        await page.evaluate("() => document.getElementById('spellPop').hidden = true")
        ed = await page.evaluate("() => !!document.querySelector('.it-text[contenteditable=true]')")
        if not ed: await page.mouse.click(st[0] + 200, st[1] + 420); await page.wait_for_timeout(300)
        await page.keyboard.type('The colour and the color of teh house ')
        m = await wait_marked(page, ['color', 'teh'])
        check(sorted(m) == ['color', 'teh'], f'English (UK) box: color and teh are marked ({m})')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        langs = await page.evaluate("() => [...__inkwell.cur.items.values()].filter(i => i.t === 'x').map(i => i.lang).sort()")
        check(langs == ['de-CH', 'en-GB'], f'each box keeps its own language ({langs})')
        m = await page.evaluate(MARKED)
        check(m == [], f'no marks when no box is being typed in ({m})')

        # offline after a restart: the word lists come from the device
        await page.evaluate("() => __inkwell.flushSaves()")
        await ctx.set_offline(True)
        await page.reload(); await page.wait_for_timeout(1500); await ready(page)
        await page.evaluate("() => __inkwell.setTool('text')")
        boxes = await page.evaluate("() => [...document.querySelectorAll('.it-text')].map(e => { const r = e.getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2, e.textContent.slice(0, 3)]; })")
        de = [x for x in boxes if x[2] == 'Ich'][0]
        await page.mouse.click(de[0], de[1]); await page.wait_for_timeout(300)
        await page.keyboard.press('End'); await page.keyboard.type(' Fehlerr ')
        m = await wait_marked(page, ['Fehlerr'])
        check(m == ['Fehlerr'], f'offline after a restart: still checked, in the box\'s own language ({m})')
        await page.keyboard.press('Escape')
        en = [x for x in boxes if x[2] == 'The'][0]
        await page.mouse.click(en[0], en[1]); await page.wait_for_timeout(300)
        m = await wait_marked(page, ['color', 'teh'])
        check(sorted(m) == ['color', 'teh'], f'and the English box in English ({m})')
        await ctx.set_offline(False)

        # off
        await page.click('#fmtBar [data-act="spell"]'); await page.wait_for_timeout(200)
        await page.click('#spellPop [data-spell="off"]'); await page.wait_for_timeout(500)
        m = await page.evaluate(MARKED); s = await page.evaluate(BOX)
        pref = await page.evaluate("() => __inkwell.prefs.spell")
        check(m == [] and pref is False and s['native'] is False, f'Off: no marks, setting saved ({m}, {pref})')
        dis = await page.evaluate("() => [...document.querySelectorAll('#spellLangs [data-lang]')].every(b => b.disabled)")
        check(dis, 'languages are greyed while off')
        await page.click('#spellPop [data-spell="on"]'); await page.wait_for_timeout(300)
        m = await wait_marked(page, ['color', 'teh'])
        check(sorted(m) == ['color', 'teh'], f'On again: marks come back ({m})')

        # a word list that cannot be loaded: the system's check is used
        await page.evaluate("() => __inkwell.Spell.failed.add('en-GB')")
        await page.evaluate("() => __inkwell.Spell.set(document.querySelector('.it-text[contenteditable=true]'))")
        await page.wait_for_timeout(300)
        s = await page.evaluate(BOX); m = await page.evaluate(MARKED)
        check(s['native'] is True and m == [], f'no word list: the system spell check takes over ({s["native"]}, {m})')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
