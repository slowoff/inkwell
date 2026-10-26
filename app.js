/* Inkwell: starts the app (1.62.1).
   The app is in app/01-base.js … app/13-start.js. This file fetches them and runs them one right after the other in a
   single step: with 13 separate <script> tags the browser may run a timer, a resize or a sync callback between two
   files, and that code could call something from a file that has not run yet (it did in a test: "TS is not defined").
   Each file is run as its own script (file names show in errors and in the browser's developer tools). */
(async () => {
'use strict';
// (1.64.2) if starting fails, say so on screen with the exact error (before, the app just stayed empty)
const ERRS = window.__inkwellErrors = [];
const keep = (msg, where) => { if(ERRS.length < 20) ERRS.push(String(msg || 'unknown error').slice(0, 300) + (where ? ' (' + where + ')' : '')); };
addEventListener('error', e => keep(e.message || (e.error && e.error.message), e.filename ? String(e.filename).split('/').pop() + ':' + e.lineno : ''));
addEventListener('unhandledrejection', e => { const r = e.reason; keep('Promise: ' + ((r && (r.message || r.name)) || r)); });
function stuckBox(title){
  if(document.getElementById('inkwellStuck')) return;
  const m = document.createElement('div'); m.id = 'inkwellStuck';
  m.style.cssText = 'position:fixed;left:16px;right:16px;top:12%;max-width:640px;margin:0 auto;padding:16px;border-radius:12px;background:#222;color:#fff;font:15px/1.45 system-ui;z-index:2147483647;box-shadow:0 8px 30px rgba(0,0,0,.4);user-select:text;-webkit-user-select:text';
  const lines = [title, 'Step: ' + (window.__inkwellStep || 'loading files'), ...ERRS.map(x => '• ' + x), navigator.userAgent];
  const pre = document.createElement('pre'); pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font:12px/1.4 ui-monospace,monospace;margin:8px 0;max-height:50vh;overflow:auto';
  pre.textContent = lines.join('\n');
  const h = document.createElement('div'); h.textContent = 'Inkwell did not start properly. Please send a screenshot of this box.';
  h.style.fontWeight = '600';
  const bt = document.createElement('div'); bt.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  const mk = (t, f) => { const b = document.createElement('button'); b.textContent = t; b.style.cssText = 'font:15px system-ui;padding:8px 14px;border-radius:8px;border:0;background:#444;color:#fff'; b.onclick = f; bt.appendChild(b); };
  mk('Hide', () => m.remove()); mk('Reload', () => location.reload());
  m.append(h, pre, bt);
  (document.body || document.documentElement).appendChild(m);
}
setTimeout(() => { if(!window.__inkwellBooted) stuckBox(ERRS.length ? 'Starting failed.' : 'Starting is taking too long.'); }, 8000);
const FILES = [
  'app/01-base.js',
  'app/02-store.js',
  'app/03-sync.js',
  'app/04-render.js',
  'app/05-input.js',
  'app/06-writing.js',
  'app/06b-select.js',
  'app/06c-answer-lines.js',
  'app/06d-text.js',
  'app/07-binder.js',
  'app/08-import-export.js',
  'app/09-settings.js',
  'app/10-shapes.js',
  'app/11-claude.js',
  'app/12-tools.js',
  'app/13-start.js'
];
try {
  const texts = await Promise.all(FILES.map(f => fetch(f).then(r => { if(!r.ok) throw new Error(f + ' (' + r.status + ')'); return r.text(); })));
  for(let i = 0; i < FILES.length; i++){
    const n = ERRS.length;
    const s = document.createElement('script');
    s.textContent = texts[i] + '\n//# sourceURL=' + new URL(FILES[i], location.href).href;
    document.head.appendChild(s);   // an inline script runs right here, before the next line
    if(ERRS.length > n) ERRS[n] = FILES[i] + ': ' + ERRS[n];
  }
  if(ERRS.length) setTimeout(() => stuckBox('Starting failed.'), 1500);
} catch(e){
  console.error(e);
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;left:16px;right:16px;top:40%;padding:16px;border-radius:12px;background:#222;color:#fff;font:16px system-ui;text-align:center;z-index:99';
  m.textContent = 'Inkwell could not load (' + (e.message || e) + '). Check the connection and open it again.';
  document.body.appendChild(m);
}
})();
