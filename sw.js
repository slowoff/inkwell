// Inkwell offline cache. Bump VERSION whenever app files change.
const VERSION = 'inkwell-1.59.2';   // releases: 1.0, then 1.1, 1.2, …
const SHELL = [
  './', './index.html', './app.css', './app.js', './config.js', './manifest.webmanifest',
  './lib/pdf.min.js', './lib/pdf.worker.min.js', './lib/supabase.js',
  './lib/katex/katex.min.js', './lib/katex/katex.min.css',
  './lib/pdf-lib.min.js', './lib/docx/html2canvas.min.js',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache. GitHub Pages lets browsers keep files for 10 minutes,
  // so without it a new version could be stored with the previous version's files.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})))));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
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
    // network first, so a changed config is picked up right away
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    }))
  );
});
