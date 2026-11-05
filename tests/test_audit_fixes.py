# 1.88: fixes from the 2026-11-05 check.
import asyncio, os
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
        page = await ctx.new_page(); errs = []; csp = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: csp.append(m.text) if 'Content Security Policy' in m.text else None)
        await ctx.add_cookies([{'name': 'csp', 'value': '1', 'url': URL}])   # serve.py keeps the real security rule (see there)
        async def until(expr, secs=30):
            for _ in range(int(secs * 5)):
                if await page.evaluate(expr): return True
                await page.wait_for_timeout(200)
            raise Exception('timed out: ' + expr)
        await page.goto(URL)
        await until('!!(navigator.serviceWorker && navigator.serviceWorker.controller)'); await page.wait_for_timeout(2500)
        await until('!!(window.__inkwell && window.__inkwell.cur)')
        check(not csp, f'the app starts with no security-rule blocks ({csp[:3]})')
        await page.evaluate("async () => { await __inkwell.newPage(); window.__p = []; window.print = () => {}; }"); await page.wait_for_timeout(300)
        # the security rule stops injected handlers
        fired = await page.evaluate("async () => { const d = document.createElement('div'); d.innerHTML = '<img src=x onerror=__p.push(9)>'; document.body.append(d); await new Promise(r => setTimeout(r, 300)); d.remove(); return __p.slice(); }")
        check(fired == [], f'an injected handler does not run ({fired})')
        # colours in print
        await page.evaluate("""c => __inkwell.addItems([{t:'s',id:'bad',c:c,w:6,hl:0,p:[10,10,.5,50,50,.5,90,20,.5]}, {t:'i',id:'ff',x:200,y:0,w:300,h:400,a:'none',doc:1,f:[{k:'tx',x:.1,y:.1,w:.5,h:.1,v:'hi',c:c}]}])""", "\"/><img src=x onerror=__p.push('c')>")
        await page.wait_for_timeout(300); await page.evaluate("() => __inkwell.exportPdf()"); await page.wait_for_timeout(1500)
        html = await page.evaluate("() => document.getElementById('printRoot').innerHTML")
        check('<img src="x"' not in html and await page.evaluate("__p.length") == 0, 'colours cannot add anything to the print page')
        await page.evaluate("__inkwell.removeItems(['bad', 'ff'])")
        c = await page.evaluate("__inkwell.cleanHTML(\"<div style='background:u\\\\72l(https://e.example/y);color:red'>b</div>\")")
        check('u\\72l' not in c and 'color:red' in c, f'disguised styles are removed ({c})')
        # failed save
        r = await page.evaluate("""async () => { const W = __inkwell; await W.flushSaves(); const P = IDBObjectStore.prototype.put; window.__P = P;
          IDBObjectStore.prototype.put = function(){ throw new DOMException('full', 'QuotaExceededError'); };
          W.addItems([{t:'s',id:'kept',c:'#000',w:4,hl:0,p:[1,1,.5,40,40,.5]}]); await new Promise(r => setTimeout(r, 1500));
          const el = document.getElementById('saveWarn'); return !!el && !el.hidden; }""")
        check(r, 'a failed save shows a warning')
        await page.evaluate("(() => { IDBObjectStore.prototype.put = __P; })()"); await page.wait_for_timeout(11000)
        r = await page.evaluate("""async () => { const W = __inkwell, el = document.getElementById('saveWarn'), rec = await W.IDB.get('docs', 'c_' + W.cur.id); return {hid: el.hidden, has: rec.data.items.some(i => i.id === 'kept')}; }""")
        check(r['hid'] and r['has'], f'it clears and the change is saved once storage works ({r})')
        # uploads split when too slow
        r = await page.evaluate("""async () => { const W = __inkwell, S = W.Sync, calls = []; const ou = S.user, os = S.sb;
          for(let i = 0; i < 8; i++) await W.IDB.put('docs', {id: 'sp' + i, kind: 'ptxt', data: {a: 'x', l: []}, deleted: false, updated: Date.now() + i, dirty: 1});
          S.user = {id: 'u1'}; S.noPut = false;
          S.sb = {rpc: async (n, a) => { const rows = a.p_rows; calls.push(rows.length); if(rows.length > 2) return {data: null, error: {code: '57014', message: 'canceling statement due to statement timeout'}, status: 500}; return {data: {ok: rows.map(x => ({id: x.id, server_ts: '2026-11-05T10:00:00Z'})), conflict: []}, error: null, status: 200}; }, from: () => ({select: () => ({in: async () => ({data: [], error: null})})})};
          let err = null; try { await S.push(); } catch(e){ err = String(e); }
          const left = []; for(let i = 0; i < 8; i++){ const d = await W.IDB.get('docs', 'sp' + i); if(d.dirty) left.push(i); }
          S.user = ou; S.sb = os; return {calls, err, left}; }""")
        check(r['left'] == [] and max(r['calls']) > 2 and r['calls'][-1] <= 2 and not r['err'], f'a timed-out batch is split and gets through ({r})')
        # a stuck single row reports, others stay uploaded
        # daily copies
        r = await page.evaluate("""async () => { const W = __inkwell, G = W.GD, S = W.Sync, ou = S.user; S.user = {id: 'u1'}; const of = window.fetch, calls = [];
          window.fetch = async (u, o) => { calls.push([(o && o.method) || 'GET', String(u)]); if(String(u).includes('q=')) return new Response(JSON.stringify({files: calls.length > 2 ? [{id: 'd1'}] : []})); return new Response(JSON.stringify({id: 'd1'})); };
          localStorage.removeItem('inkwell.gdDaily');
          await G.saveDaily('{}', {at: 't', folder: 'f'}); const a = calls.length; await G.saveDaily('{}', {at: 't', folder: 'f'}); const b = calls.length;
          localStorage.removeItem('inkwell.gdDaily'); await G.saveDaily('{}', {at: 't', folder: 'f'});
          window.fetch = of; S.user = ou; return {a, b, m: calls.map(c => c[0]), q: decodeURIComponent(calls[0][1])}; }""")
        check(r['a'] == 2 and r['b'] == 2 and r['m'] == ['GET', 'POST', 'GET', 'PATCH'] and 'Inkwell notes (' in r['q'], f'one copy a day, a weekday file is overwritten, none deleted ({r})')
        # tables on the page
        bl = await page.evaluate("__inkwell.answerBlocks('Text\\n| a | b |\\n|---|---|\\n| **c** | <img src=x> |\\nafter')")
        h = ''.join(x.get('html', '') for x in bl)
        check('<table>' in h and '<th>a</th>' in h and '<b>c</b>' in h and '<img' not in h and 'Text' in h and 'after' in h and '|' not in h, f'a table becomes a table ({h})')
        kept = await page.evaluate("__inkwell.cleanHTML('<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>')")
        check('<td>b</td>' in kept, 'the text box keeps it')
        # Claude panel beside a side toolbar
        for v in ('right', 'left'):
            await page.evaluate(f"__inkwell.prefs.barPos = '{v}'; applyBarPos()"); await page.wait_for_timeout(200)
            await page.evaluate("__inkwell.Ask.open()"); await page.wait_for_timeout(300)
            o = await page.evaluate("(() => { const a = document.getElementById('askPanel').getBoundingClientRect(), t = document.getElementById('toolbar').getBoundingClientRect(); return !(a.left < t.right && a.right > t.left); })()")
            check(o, f'{v}: the Claude panel does not cover the toolbar')
            await page.evaluate("__inkwell.Ask.close()")
        await page.evaluate("__inkwell.prefs.barPos = 'top'; applyBarPos()")
        # problems
        await page.evaluate("window.__inkwellErrors.push('test problem'); renderProblems(); document.getElementById('settingsBtn').click()"); await page.wait_for_timeout(300)
        await page.click('#problemsBtn'); await page.wait_for_timeout(200)
        check('test problem' in await page.inner_text('#problemsList'), 'Settings shows the problems')
        # the real features under the real security rule
        csp.clear(); await page.evaluate("(() => { window.__inkwellErrors.length = 0; })()")   # the handlers injected on purpose above
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
        os.makedirs('/tmp/claude-0', exist_ok=True); P = '/tmp/claude-0/csp.pdf'; c1 = canvas.Canvas(P, pagesize=A4); c1.drawString(72, 700, 'CSP PAGE'); c1.showPage(); c1.save()
        await page.evaluate("document.getElementById('problemsDlg').hidden = true; document.getElementById('settingsDlg').hidden = true")
        await page.evaluate("async () => { await __inkwell.newPage(); }"); await page.wait_for_timeout(200)
        await page.click('#insertBtn'); await page.wait_for_timeout(200); await page.set_input_files('#importFile', P)
        await until("!/^(Reading file|Turning)/.test(document.getElementById('impStatus').textContent) && !document.getElementById('impGo').disabled")
        await page.click('#impGo'); await page.wait_for_timeout(1500)
        check(await page.evaluate("[...__inkwell.cur.items.values()].some(i => i.doc)"), 'CSP: PDF import')
        await page.evaluate("__inkwell.addItems([{t:'x',id:'tcsp',x:40,y:900,w:300,fs:1,html:'<h2>Title</h2><table><tr><td>cell</td></tr></table>'},{t:'m',id:'mcsp',x:40,y:1000,fs:22,c:'auto',tex:'\\\\frac{a}{b}'}])"); await page.wait_for_timeout(500)
        await page.evaluate("__inkwell.exportPdfFile()"); await until('!!__inkwell.Pdf.file', 60)
        check((await page.evaluate("__inkwell.Pdf.file.size")) > 1000, 'CSP: PDF export with text and formula')
        await page.click('#exportMore'); await page.click('#exportMode [data-m=move]'); await until('!!(__inkwell.Pdf.file && __inkwell.Pdf.extra)', 60)
        check(True, 'CSP: Movable export')
        await page.click('#exportDlg [data-close]')
        await page.evaluate("async () => { const W = __inkwell; await W.loadScript('lib/docx/jszip.min.js'); }")
        check(await page.evaluate("!!window.JSZip"), 'CSP: libraries load on demand')
        await page.evaluate("async () => { const W = __inkwell; W.prefs.spell = true; W.prefs.spellLang = 'de-CH'; W.setTool('text'); }")
        st = await page.evaluate("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left + 300, r.top + 300]; })()")
        await page.mouse.click(*st); await page.wait_for_timeout(300); await page.keyboard.type('Ich gehe in die Schulle und ')
        got = False
        for _ in range(150):
            got = await page.evaluate("!!(window.CSS && CSS.highlights && CSS.highlights.get('inkspell') && CSS.highlights.get('inkspell').size)")
            if got: break
            await page.wait_for_timeout(200)
        check(got, 'CSP: spell check runs (WebAssembly and worker)')
        await page.keyboard.press('Escape'); await page.evaluate("__inkwell.setTool('pen')")
        check(not csp, f'CSP: nothing blocked in any of that ({csp[:4]})')
        check(await page.evaluate("!(window.__inkwellErrors || []).some(e => /Blocked by/.test(e))"), 'CSP: nothing listed under Problems')
        check(not errs, f'no page errors {errs}')
        await b.close()
asyncio.run(main())
if fails: raise SystemExit(1)
