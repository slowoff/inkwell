# 1.55: the text formatting bar sits in the top tool bar (with the Text tool; greyed until a box is typed in)
# instead of floating over the box; Spelling toggle (prefs spell, default on) sets spellcheck on the box.
import asyncio, os
from playwright.async_api import async_playwright
PORT = os.environ.get('INKWELL_PORT', '8766')
URL = f'http://localhost:{PORT}/'
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)

STATE = """(() => { const f = document.getElementById('fmtBar'), r = f.getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect();
  const ed = document.querySelector('.it-text[contenteditable=true]');
  return {shown: !f.hidden && r.width > 0, inBar: !!f.closest('#toolbar'), idle: f.classList.contains('idle'), above: r.bottom <= st.top + 1,
          editing: !!ed, focus: !!ed && document.activeElement === ed, spell: ed ? ed.spellcheck : null,
          spellOn: document.querySelector('#fmtBar [data-act=spell]').classList.contains('on')}; })()"""

async def boot(page):
    await page.goto(URL); await page.wait_for_timeout(3000)
    await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        await ctx.route('**/*.supabase.co/**', lambda r: r.abort())
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await boot(page)
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(400)
        await page.evaluate("() => __inkwell.setTool('pen')"); await page.wait_for_timeout(100)
        s = await page.evaluate(STATE)
        check(not s['shown'], 'pen tool: no text buttons in the bar')
        await page.evaluate("() => __inkwell.setTool('text')"); await page.wait_for_timeout(100)
        s = await page.evaluate(STATE)
        check(s['shown'] and s['inBar'] and s['idle'] and s['above'], f'text tool: buttons in the top tool bar, greyed with no box open ({s})')
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top]; })()")
        await page.mouse.click(st[0] + 250, st[1] + 300); await page.wait_for_timeout(300)
        s = await page.evaluate(STATE)
        check(s['shown'] and not s['idle'] and s['editing'] and s['above'], f'typing in a box: buttons active, still in the bar above the page ({s})')
        check(s['spell'] is True and s['spellOn'], 'spell check on by default')
        await page.keyboard.type('Hello wrold')
        await page.evaluate("""() => { const t = document.querySelector('.it-text').firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 5); getSelection().removeAllRanges(); getSelection().addRange(r); }""")
        await page.click('#fmtBar [data-cmd="bold"]'); await page.wait_for_timeout(200)
        html = await page.evaluate("document.querySelector('.it-text').innerHTML")
        s = await page.evaluate(STATE)
        check('<b>Hello</b>' in html and s['editing'] and s['focus'], f'Bold from the tool bar works and the box stays open ({html})')
        await page.click('#fmtBar [data-act="tsize"]'); await page.wait_for_timeout(200)
        pr = await page.evaluate("(() => { const r = document.getElementById('tsizePop').getBoundingClientRect(); return !document.getElementById('tsizePop').hidden && r.top >= 0 && r.bottom <= innerHeight; })()")
        check(pr, 'size dropdown opens under the tool bar, on screen')
        await page.click('#tsizeList [data-px="24"]'); await page.wait_for_timeout(200)
        sz = await page.evaluate("(() => { const el = document.querySelector('.it-text'); const t = [...el.querySelectorAll('*')].map(n => n.firstChild).find(n => n && n.nodeType === 3 && n.data === 'Hello'); return [getComputedStyle(t.parentNode).fontSize, getComputedStyle(el.lastChild.nodeType === 3 ? el : el.lastChild).fontSize, el.innerHTML]; })()")
        check(sz[0] == '24px' and sz[1] == '17px', f'size from the tool bar applies to the selected word only ({sz})')

        # spell toggle
        await page.evaluate("() => { const el = document.querySelector('.it-text'); const t = [...el.childNodes].find(n => n.nodeType === 3 && n.data.includes('wrold')); const r = document.createRange(); r.setStart(t, 3); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); }")
        await page.click('#fmtBar [data-act="spell"]'); await page.wait_for_timeout(400)
        s = await page.evaluate(STATE)
        caret = await page.evaluate("(() => { const g = getSelection(); return g.isCollapsed && g.anchorNode.textContent + '|' + g.anchorOffset; })()")
        pref = await page.evaluate("__inkwell.prefs.spell")
        check(s['spell'] is False and not s['spellOn'] and pref is False, f'Spelling off: box and setting off ({s}, {pref})')
        check(s['editing'] and s['focus'] and caret == ' wrold|3', f'toggling keeps the box open and the cursor in place ({caret})')
        await page.keyboard.press('Escape'); await page.wait_for_timeout(300)
        s = await page.evaluate(STATE)
        check(s['shown'] and s['idle'], 'box closed: buttons stay in the bar, greyed')
        await page.evaluate("async () => { await __inkwell.flushSaves(); }"); await page.wait_for_timeout(500)
        await page.reload(); await page.wait_for_timeout(3000)
        await page.wait_for_function('window.__inkwell && window.__inkwell.cur', timeout=15000)
        await page.evaluate("() => __inkwell.setTool('text')"); await page.wait_for_timeout(100)
        await page.mouse.click(st[0] + 250, st[1] + 500); await page.wait_for_timeout(300)
        s = await page.evaluate(STATE)
        check(s['spell'] is False and not s['spellOn'], 'off is remembered after a reload')
        await page.click('#fmtBar [data-act="spell"]'); await page.wait_for_timeout(400)
        s = await page.evaluate(STATE)
        check(s['spell'] is True and s['spellOn'], 'turned on again')
        await page.evaluate("() => __inkwell.setTool('pen')"); await page.wait_for_timeout(300)
        s = await page.evaluate(STATE)
        check(not s['shown'] and not s['editing'], 'switching to the pen closes the box and hides the text buttons')
        # nothing floats over the page any more
        fl = await page.evaluate("!!document.querySelector('#stage #fmtBar')")
        check(not fl, 'no formatting bar inside the page area')
        # iPad portrait: the bar scrolls sideways, every button reachable
        await page.set_viewport_size({'width': 820, 'height': 1180}); await page.wait_for_timeout(300)
        await page.evaluate("() => __inkwell.setTool('text')"); await page.wait_for_timeout(200)
        reach = await page.evaluate("""(() => { const t = document.getElementById('toolbar'); const d = document.querySelector('#fmtBar [data-act=done]');
          t.scrollLeft = t.scrollWidth; const r = d.getBoundingClientRect(), tr = t.getBoundingClientRect(); return r.right <= tr.right + 1 && r.left >= tr.left - 1; })()""")
        check(reach, 'narrow screen: tool bar scrolls so the last text button is reachable')
        check(not errs, 'no page errors ' + '; '.join(errs[:3]))
        await b.close()
    print('PASS' if not fails else f'{len(fails)} FAILED')
    raise SystemExit(1 if fails else 0)

asyncio.run(main())
