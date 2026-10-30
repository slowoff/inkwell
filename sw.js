// Inkwell offline cache. Bump VERSION whenever app files change.
const VERSION = 'inkwell-1.73';   // releases: 1.0, then 1.1, 1.2, …
const SHELL = [
  './', './index.html', './app.css', './config.js', './manifest.webmanifest',
  './core/util.js', './core/ink.js', './core/merge.js', './core/text.js',
  // (1.62.1) app.js loads and runs these (the app itself)
  './app.js',
  './app/01-base.js',
  './app/02-store.js',
  './app/03-sync.js',
  './app/04-render.js',
  './app/05-input.js',
  './app/06-writing.js',
  './app/06b-select.js',
  './app/06c-answer-lines.js',
  './app/06d-text.js',
  './app/07-binder.js',
  './app/08-import-export.js',
  './app/09-settings.js',
  './app/10-shapes.js',
  './app/11-claude.js',
  './app/12-tools.js',
  './app/13-start.js',
  './lib/pdf.min.js', './lib/pdf.worker.min.js', './lib/supabase.js',
  './lib/katex/katex.min.js', './lib/katex/katex.min.css',
  './lib/pdf-lib.min.js', './lib/docx/html2canvas.min.js',
  // (1.61) also offline from the first start: Word import (docx-preview, JSZip; JSZip also makes backups) and the
  // formula fonts (before, formulas showed in a fallback font and Word import / backups failed when offline
  // until they had been used once online)
  './lib/docx/docx-preview.min.js', './lib/docx/jszip.min.js',
  // (1.66) spell check: the worker comes with each version; Hunspell and the word lists are in SPELL_CACHE (below)
  './lib/spell/worker.js',
  './lib/katex/fonts/KaTeX_AMS-Regular.woff2',
  './lib/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  './lib/katex/fonts/KaTeX_Caligraphic-Regular.woff2',
  './lib/katex/fonts/KaTeX_Fraktur-Bold.woff2',
  './lib/katex/fonts/KaTeX_Fraktur-Regular.woff2',
  './lib/katex/fonts/KaTeX_Main-Bold.woff2',
  './lib/katex/fonts/KaTeX_Main-BoldItalic.woff2',
  './lib/katex/fonts/KaTeX_Main-Italic.woff2',
  './lib/katex/fonts/KaTeX_Main-Regular.woff2',
  './lib/katex/fonts/KaTeX_Math-BoldItalic.woff2',
  './lib/katex/fonts/KaTeX_Math-Italic.woff2',
  './lib/katex/fonts/KaTeX_SansSerif-Bold.woff2',
  './lib/katex/fonts/KaTeX_SansSerif-Italic.woff2',
  './lib/katex/fonts/KaTeX_SansSerif-Regular.woff2',
  './lib/katex/fonts/KaTeX_Script-Regular.woff2',
  './lib/katex/fonts/KaTeX_Size1-Regular.woff2',
  './lib/katex/fonts/KaTeX_Size2-Regular.woff2',
  './lib/katex/fonts/KaTeX_Size3-Regular.woff2',
  './lib/katex/fonts/KaTeX_Size4-Regular.woff2',
  './lib/katex/fonts/KaTeX_Typewriter-Regular.woff2',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'
];

// (1.66) Hunspell (lib/spell/hunspell.js) and the word lists (lib/spell/dict/, 0.5-5 MB each) are downloaded when a
// language is first used and kept in this cache, which app updates do not empty. Raise the number if they change.
const SPELL_CACHE = 'inkwell-spell-1';
const isSpellFile = url => /\/lib\/spell\/(hunspell\.js|dict\/)/.test(url.pathname);

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache. GitHub Pages lets browsers keep files for 10 minutes,
  // so without it a new version could be stored with the previous version's files.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})))));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== SPELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  else if (e.data === 'version' && e.ports && e.ports[0]) e.ports[0].postMessage(VERSION);
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // sync traffic goes straight to the network
  if (url.pathname.endsWith('/config.js')) {
    // network first, so a changed config is picked up right away.
    // (1.64.3) but never wait long: on a connection that is up but not working (Wi-Fi with no internet) the request
    // just hung, and config.js is loaded before everything else, so Inkwell did not start at all (no notes, no
    // Settings). With a stored copy, the network gets 2 seconds. Only a real script is accepted and stored: a Wi-Fi
    // login page answering instead must not replace the stored copy.
    e.respondWith((async () => {
      const net = fetch(e.request).then(r => {
        if (!r.ok || !/javascript|ecmascript/i.test(r.headers.get('content-type') || '')) throw new Error('config.js: ' + r.status);
        const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy));
        return r;
      });
      const stored = await caches.match(e.request, {ignoreSearch: true});
      if (!stored) return net;
      return Promise.race([net.catch(() => stored), new Promise(res => setTimeout(() => res(stored), 2000))]);
    })());
    return;
  }
  if (isSpellFile(url)) {
    e.respondWith(caches.open(SPELL_CACHE).then(c => c.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }))));
    return;
  }
  e.respondWith(
    caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    }))
  );
});
