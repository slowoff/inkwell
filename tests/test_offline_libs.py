# 1.61: after the first start, Word import (docx-preview + JSZip), backups (JSZip) and the formula fonts work
# offline, also if they were never used while online.
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
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(URL); await page.wait_for_timeout(3000)
        await page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        await page.wait_for_timeout(2500)
        # nothing of these was loaded while online
        r = await page.evaluate("() => ({zip: !!window.JSZip, docx: !!(window.docx && window.docx.renderAsync)})")
        check(not r['zip'] and not r['docx'], f'Word libraries not loaded yet while online ({r})')
        cached = await page.evaluate("""async () => { const keys = await caches.keys(); const c = await caches.open(keys.find(k => k.startsWith('inkwell-')));
          const want = ['lib/docx/jszip.min.js', 'lib/docx/docx-preview.min.js', 'lib/katex/fonts/KaTeX_Main-Regular.woff2', 'lib/katex/fonts/KaTeX_Math-Italic.woff2', 'lib/katex/fonts/KaTeX_Size2-Regular.woff2'];
          const out = {}; for(const w of want) out[w] = !!(await c.match(new URL(w, location.href).href)); return out; }""")
        check(all(cached.values()), f'stored for offline use at install ({cached})')

        await ctx.set_offline(True)
        await page.reload(); await page.wait_for_timeout(2500)
        await page.wait_for_function('window.__inkwell', timeout=15000)
        r = await page.evaluate("""async () => {
          const load = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed ' + src)); document.head.appendChild(s); });
          const out = {};
          try { await load('lib/docx/jszip.min.js'); out.zip = !!window.JSZip; } catch(e){ out.zip = String(e); }
          try { await load('lib/docx/docx-preview.min.js'); out.docx = !!(window.docx && window.docx.renderAsync); } catch(e){ out.docx = String(e); }
          // a backup-style zip works offline
          try { const z = new JSZip(); z.file('notes.json', '{}'); const blob = await z.generateAsync({type: 'blob'}); out.zipOk = blob.size > 0; } catch(e){ out.zipOk = String(e); }
          // formula font
          const el = document.createElement('div'); el.style.cssText = 'position:fixed;left:0;top:0';
          el.innerHTML = katex.renderToString('x^2 + \\\\frac{a}{b}'); document.body.appendChild(el);
          await document.fonts.ready; await new Promise(r => setTimeout(r, 300));
          out.font = document.fonts.check('20px KaTeX_Main') && document.fonts.check('20px KaTeX_Math');
          out.loaded = [...document.fonts].filter(f => /KaTeX/.test(f.family) && f.status === 'loaded').map(f => f.family);
          el.remove();
          return out; }""")
        check(r['zip'] is True, f'JSZip loads offline ({r["zip"]})')
        check(r['docx'] is True, f'Word reader loads offline ({r["docx"]})')
        check(r['zipOk'] is True, f'a backup zip can be made offline ({r["zipOk"]})')
        check(r['font'] and 'KaTeX_Main' in r['loaded'] and 'KaTeX_Math' in r['loaded'], f'formula fonts load offline ({r["loaded"]})')
        await ctx.set_offline(False)
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()

asyncio.run(main())
print('ALL OK' if not fails else f'{len(fails)} FAILED')
raise SystemExit(1 if fails else 0)
