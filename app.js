/* Inkwell: starts the app (1.62.1).
   The app is in app/01-base.js … app/13-start.js. This file fetches them and runs them one right after the other in a
   single step: with 13 separate <script> tags the browser may run a timer, a resize or a sync callback between two
   files, and that code could call something from a file that has not run yet (it did in a test: "TS is not defined").
   Each file is run as its own script (file names show in errors and in the browser's developer tools). */
(async () => {
'use strict';
const FILES = [
  'app/01-base.js',
  'app/02-store.js',
  'app/03-sync.js',
  'app/04-render.js',
  'app/05-input.js',
  'app/06-writing.js',
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
    const s = document.createElement('script');
    s.textContent = texts[i] + '\n//# sourceURL=' + new URL(FILES[i], location.href).href;
    document.head.appendChild(s);   // an inline script runs right here, before the next line
  }
} catch(e){
  console.error(e);
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;left:16px;right:16px;top:40%;padding:16px;border-radius:12px;background:#222;color:#fff;font:16px system-ui;text-align:center;z-index:99';
  m.textContent = 'Inkwell could not load (' + (e.message || e) + '). Check the connection and open it again.';
  document.body.appendChild(m);
}
})();
