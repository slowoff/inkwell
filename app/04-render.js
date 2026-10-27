/* Inkwell app, part 4 of 13: Stage, camera, drawing the page, edits and undo.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
/* =====================================================================
   Ink geometry
   ===================================================================== */

const geo = new Map();
// imported pages/pictures (always shown light, also in dark mode)
function paperRects(){
  const r = [];
  if(cur) for(const it of cur.items.values()) if(it.t === 'i') r.push([it.x, it.y, it.x + it.w, it.y + it.h]);
  return r;
}
function onPaperAt(rects, x, y){ return rects.some(r => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]); }
function refreshPaper(){
  if(!cur) return;
  const rects = paperRects();
  for(const it of cur.items.values()){
    if(it.t !== 'x' && it.t !== 'm') continue;
    const el = elMap.get(it.id); if(!el) continue;
    const b = itemBox(it);
    el.classList.toggle('on-paper', onPaperAt(rects, (b[0] + b[2]) / 2, Math.min(b[1] + 14, (b[1] + b[3]) / 2)));
  }
}
function geoOf(it){
  let g = geo.get(it.id);
  if(g && g.it === it) return g;
  g = {it, path: strokePath(it, false), b: strokeBox(it)};
  geo.set(it.id, g);
  return g;
}

/* Colours: 'auto' ink is black on light paper and white on dark paper */
let tokens = {};
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => prefs.theme === 'dark' || (prefs.theme !== 'light' && darkMQ.matches);
function setThemeAttr(){
  const r = document.documentElement;
  if(prefs.theme === 'light' || prefs.theme === 'dark') r.dataset.theme = prefs.theme; else delete r.dataset.theme;
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m, i) => {
    if(prefs.theme === 'auto'){ m.media = i ? '(prefers-color-scheme: dark)' : '(prefers-color-scheme: light)'; m.content = i ? '#15191E' : '#F4F6F8'; }
    else { m.media = ''; m.content = prefs.theme === 'dark' ? '#15191E' : '#F4F6F8'; }
  });
}
setThemeAttr();
function readTokens(){
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  tokens = {fg: g('--fg'), rule: g('--rule'), ruleStrong: g('--rule-strong'), accent: g('--accent'), tape: g('--tape'), muted: g('--muted'), paper: g('--paper')};
}
function lum(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if(!m) return 0.5;
  const n = parseInt(m[1], 16);
  return 0.2126 * (n >> 16) / 255 + 0.7152 * (n >> 8 & 255) / 255 + 0.0722 * (n & 255) / 255;
}
// onPaper: drawn over an imported page/picture, which always stays light, so use light-mode ink there
function inkColor(c, print, onPaper){
  if(onPaper) print = true;
  const dark = !print && isDark();
  if(!c || c === 'auto') return print ? '#18212B' : tokens.fg;
  if(c === 'paper') return print ? '#FFFFFF' : (tokens.paper || '#FFFFFF');   // (1.57) the page colour: white, or dark in dark mode
  const l = lum(c);
  if(dark && l < 0.07) return tokens.fg;
  if(!dark && l > 0.93) return '#18212B';
  return c;
}

/* =====================================================================
   Stage, camera, rendering
   ===================================================================== */
const stage = $('stage'), bgCv = $('bg'), inkCv = $('ink'), liveCv = $('live');
const worldBack = $('worldBack'), worldFront = $('worldFront');
const bgCtx = bgCv.getContext('2d'), inkCtx = inkCv.getContext('2d'), liveCtx = liveCv.getContext('2d');
// (1.62) highlighter layer under the ink: blended with "multiply" (CSS), so dark text and lines of imported pages
// stay as dark as they are and only the light paper takes the colour, like a real highlighter. On white the colour is
// exactly as before (40 % on white). Highlights over a filled shape (graph background) or, in dark mode, on the dark
// page background stay on the ink layer as before (multiply would hide them there).
const hlmCv = $('hlm'), hlmCtx = hlmCv.getContext('2d');
let hlmUsed = false;
let W = 0, H = 0, dpr = 1, SR = {left: 0, top: 0};
const cam = {ox: 40, oy: 24, z: 1};
let cur = null;           // open page: {id, crec, bg, items: Map, undo, redo}
const elMap = new Map();  // item id -> DOM element (text, formula, image, tape)
const tHandle = document.createElement('div');
tHandle.id = 'tHandle'; tHandle.className = 't-handle'; tHandle.hidden = true; tHandle.title = 'Drag to change width';
stage.appendChild(tHandle);
// (1.45) move grip: a hand left of the text box being typed in; drag it to move the box
const tMove = document.createElement('div');
tMove.id = 'tMove'; tMove.className = 't-move'; tMove.hidden = true; tMove.title = 'Drag to move the text box';
tMove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5"/><path d="M14 11.5V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.2L4.6 15.6a1.6 1.6 0 0 1 2.4-2.1L8 14.6"/></svg>';
stage.appendChild(tMove);

const toWorld = (sx, sy) => [(sx - cam.ox) / cam.z, (sy - cam.oy) / cam.z];
const viewRect = () => [-cam.ox / cam.z, -cam.oy / cam.z, (W - cam.ox) / cam.z, (H - cam.oy) / cam.z];
const pt = e => [e.clientX - SR.left, e.clientY - SR.top];

// (1.58.11) iPadOS 26 bug: a Home Screen app gets a viewport that is short by about the status bar height, which left
// an empty strip at the bottom. When the app runs from the Home Screen across the whole screen, it is stretched to
// the real screen height (only for a small gap, so split view, Stage Manager and the keyboard are left alone).
function fitScreen(){
  const app = document.querySelector('.app'); if(!app) return;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let hgt = '';
  if(standalone && screen.width && screen.height){
    const land = innerWidth > innerHeight;
    const sw = land ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    const sh = land ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
    const gap = sh - innerHeight;
    if(Math.abs(innerWidth - sw) <= 2 && gap > 2 && gap <= 64) hgt = sh + 'px';
  }
  if(app.style.height !== hgt) app.style.height = hgt;
}
function resize(){
  fitScreen();
  const r = stage.getBoundingClientRect();
  SR = r; W = r.width; H = r.height;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  for(const c of [bgCv, hlmCv, inkCv, liveCv]){
    c.width = Math.max(1, Math.round(W * dpr)); c.height = Math.max(1, Math.round(H * dpr));
    c.style.width = W + 'px'; c.style.height = H + 'px';
  }
  if(W > 0 && H > 0 && !rulerVisible()) centerRuler(false);
  renderRuler();
  invalidate();
}
new ResizeObserver(resize).observe(stage);
addEventListener('resize', fitScreen);
addEventListener('scroll', () => { SR = stage.getBoundingClientRect(); }, true);

let rafId = 0, need = {bg: 0, ink: 0, over: 0}, frontZ = 1;
let backZ = 1, backTimer = 0;
// place an element of the back layer (imported page, picture) at the settled zoom backZ
function backXf(el, it){
  const z = backZ;
  el.style.left = it.x * z + 'px'; el.style.top = it.y * z + 'px';
  el.style.width = it.w * z + 'px'; el.style.height = it.h * z + 'px';
  // fill-in fields keep world units inside: their layer is the page's world size, scaled to fit
  if(el._pf){ el._pf.style.width = it.w + 'px'; el._pf.style.height = it.h + 'px'; el._pf.style.transform = z === 1 ? '' : `scale(${z})`; }
}
function settleBack(){
  backTimer = 0;
  if(backZ === cam.z) return;
  backZ = cam.z;
  if(cur) for(const el of worldBack.children){ const it = el.dataset.id && cur.items.get(el.dataset.id); if(it && it.t === 'i') backXf(el, it); }
  worldBack.style.transform = `translate(${cam.ox}px,${cam.oy}px)`;
}
function invalidate(bg = 1, ink = 1, over = 1){
  need.bg |= bg; need.ink |= ink; need.over |= over;
  if(!rafId) rafId = requestAnimationFrame(frame);
}
function frame(){
  rafId = 0;
  if(prefs.leftEdge && cur) clampLeft();
  // (1.58.3) Imported pages and pictures are laid out at the zoom they were last settled at (backZ) and only
  // stretched by the small difference while a zoom is going on; ~0.15 s after the zoom stops they are laid out at the
  // new size. Before, the whole layer of pages was stretched by the zoom: iPad Safari keeps such a layer sharp only
  // up to a memory limit, so around 300 % on a long script it suddenly dropped to a coarse copy.
  worldBack.style.transform = `translate(${cam.ox}px,${cam.oy}px) scale(${cam.z / backZ})`;
  if(cam.z !== backZ){ clearTimeout(backTimer); backTimer = setTimeout(settleBack, 150); }
  // Typed text, formulas and tape are scaled one by one instead of as one big layer: iPad Safari
  // rasterises a big scaled layer at 1x and then stretches it, so text went blurry when zoomed in.
  worldFront.style.transform = `translate(${cam.ox}px,${cam.oy}px)`;
  if(cam.z !== frontZ){ frontZ = cam.z; for(const el of worldFront.children) frontXf(el); }
  $('zoomBtn').textContent = Math.round(cam.z * 100) + '%';
  if(need.bg) drawBg();
  if(need.ink) drawInk();
  if(need.over){ positionOverlays(); imgSoon(); renderSlider(); }
  need = {bg: 0, ink: 0, over: 0};
  if(act || WA.linger()) drawLive();   // the reference line follows the page while it is still showing
}
function drawBg(){
  bgCtx.setTransform(1, 0, 0, 1, 0, 0);
  bgCtx.clearRect(0, 0, bgCv.width, bgCv.height);
  if(!cur) return;
  const bg = cur.bg;
  if(bg.type === 'blank') return;
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let kx = 1, ky = 1;
  while(bg.sx * kx * cam.z < 7) kx *= 2;
  while(bg.sy * ky * cam.z < 7) ky *= 2;
  const stepX = bg.sx * kx, stepY = bg.sy * ky;
  const v = viewRect();
  const x0 = Math.floor(v[0] / stepX) * stepX, y0 = Math.floor(v[1] / stepY) * stepY;
  if(bg.type === 'dots'){
    bgCtx.fillStyle = tokens.ruleStrong;
    const r = clamp(cam.z * 1.1, 0.8, 1.8);
    for(let y = y0; y <= v[3]; y += stepY){
      const Y = y * cam.z + cam.oy;
      for(let x = x0; x <= v[2]; x += stepX) bgCtx.fillRect(x * cam.z + cam.ox - r, Y - r, 2 * r, 2 * r);
    }
    return;
  }
  bgCtx.strokeStyle = tokens.rule; bgCtx.lineWidth = 1;
  bgCtx.beginPath();
  for(let y = y0; y <= v[3]; y += stepY){ const Y = Math.round(y * cam.z + cam.oy) + 0.5; bgCtx.moveTo(0, Y); bgCtx.lineTo(W, Y); }
  if(bg.type === 'grid') for(let x = x0; x <= v[2]; x += stepX){ const X = Math.round(x * cam.z + cam.ox) + 0.5; bgCtx.moveTo(X, 0); bgCtx.lineTo(X, H); }
  bgCtx.stroke();
}
// (1.62) does this highlight blend into the page (multiply)? fills = boxes of filled shapes on the page
const hlMultiply = (paper, b, fills) => (paper || !isDark()) && !fills.some(f => f[0] < b[2] && f[2] > b[0] && f[1] < b[3] && f[3] > b[1]);
function drawInk(){
  inkCtx.setTransform(1, 0, 0, 1, 0, 0);
  inkCtx.clearRect(0, 0, inkCv.width, inkCv.height);
  if(hlmUsed){ hlmCtx.setTransform(1, 0, 0, 1, 0, 0); hlmCtx.clearRect(0, 0, hlmCv.width, hlmCv.height); hlmUsed = false; }
  if(!cur) return;
  inkCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
  hlmCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
  const v = viewRect(), pages = paperRects(), fills = [];
  for(const pass of [2, 1, 0]){
    for(const it of cur.items.values()){
      if(it.t !== 's' || inkPass(it) !== pass) continue;
      const g = geoOf(it);
      if(pass === 2) fills.push(g.b);
      if(g.b[2] < v[0] || g.b[0] > v[2] || g.b[3] < v[1] || g.b[1] > v[3]) continue;
      const paper = onPaperAt(pages, (g.b[0] + g.b[2]) / 2, (g.b[1] + g.b[3]) / 2);
      const ctx = pass === 1 && hlMultiply(paper, g.b, fills) ? hlmCtx : inkCtx;
      if(ctx === hlmCtx) hlmUsed = true;
      ctx.globalAlpha = (pass === 1 ? (isDark() && !paper ? 0.34 : 0.4) : 1) * opOf(it);
      ctx.fillStyle = inkColor(it.c, false, paper);
      ctx.fill(g.path);
    }
  }
  inkCtx.globalAlpha = 1; hlmCtx.globalAlpha = 1;
  // one small bookmark at the top right of every marked spot
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  inkCtx.fillStyle = MARK_C;
  for(const g of clusterMarks([...cur.items.values()])){
    const b = g.b;
    if(b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3]) continue;
    const x = b[2] * cam.z + cam.ox - 4, y = b[1] * cam.z + cam.oy - 8;
    inkCtx.beginPath(); inkCtx.moveTo(x, y); inkCtx.lineTo(x + 10, y); inkCtx.lineTo(x + 10, y + 14); inkCtx.lineTo(x + 5, y + 10.5); inkCtx.lineTo(x, y + 14); inkCtx.closePath(); inkCtx.fill();
  }
}

/* Imported pages/photos: only the ones on or near the screen hold a decoded picture.
   A long imported book (100+ pages) would otherwise need several GB and crash the iPad. */
const MAX_IMGS = 8;
let imgTimer = 0;
function imgSoon(){ if(!imgTimer) imgTimer = setTimeout(() => { imgTimer = 0; updateImages(); }, 120); }
function updateImages(){
  if(!cur) return;
  const v = viewRect(), mw = (v[2] - v[0]) * 0.25, mh = (v[3] - v[1]) * 0.75, cx = (v[0] + v[2]) / 2, cy = (v[1] + v[3]) / 2;
  const cand = [];
  for(const it of cur.items.values()){
    if(it.t !== 'i') continue;
    const el = elMap.get(it.id); if(!el) continue;
    const near = !(it.x + it.w < v[0] - mw || it.x > v[2] + mw || it.y + it.h < v[1] - mh || it.y > v[3] + mh);
    cand.push([near ? Math.hypot(Math.max(it.x - cx, 0, cx - it.x - it.w), Math.max(it.y - cy, 0, cy - it.y - it.h)) : Infinity, el]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  cand.forEach(([d, el], i) => {
    el._want = d < Infinity && i < MAX_IMGS;
    if(el._want) loadImg(el);
    else if(el._loaded || el._img) unloadImg(el, d < Infinity);
  });
}
// (1.67.4) a picture that could not be found (not on this device, not on the server yet) is asked for again only after
// IMG_RETRY: before, every scroll or zoom near it asked the server again (several requests a second while panning)
const IMG_RETRY = 60000;
addEventListener('online', () => { for(const el of worldBack.children) el._failAt = 0; imgSoon(); });
function loadImg(el){
  if(el._loaded || el._loading) return;
  if(el._failAt && Date.now() - el._failAt < IMG_RETRY) return;
  const a = el._a; el._loading = true;
  if(el._msg){ el._msg.hidden = false; el._msg.textContent = 'Loading'; }
  assetURL(a).then(u => {
    el._loading = false;
    if(el._a !== a || !el._want || !el.isConnected) return;
    if(!u){ el._failAt = Date.now(); el._msg.textContent = 'Not downloaded yet'; return; }
    el._failAt = 0;
    const img = new Image(); img.decoding = 'async'; img.src = u; img.draggable = false; img.alt = '';
    img.style.cssText = 'width:100%;height:100%;display:block;border-radius:2px';
    el.insertBefore(img, el.firstChild); el._img = img; el._loaded = true;
    if(el._msg) el._msg.hidden = true;
    el.classList.remove('missing');
    if(!lineReady.has(a)) setTimeout(() => { if(el._loaded) pageLines(a); }, 400);
  }, () => { el._loading = false; });
}
function unloadImg(el, visible){
  if(el._img){ el._img.removeAttribute('src'); el._img.remove(); el._img = null; }
  el._loaded = false; el.classList.add('missing');
  if(el._msg){ el._msg.hidden = false; el._msg.textContent = visible ? 'Zoom in to show this page' : 'Loading'; }
}

/* DOM items: text boxes, formulas, imported pages/photos, tape */
// Text box HTML (since 1.26 an allowlist): known formatting tags stay, unknown tags are unwrapped (their text stays),
// anything that can run code, load something or embed another document is removed with its contents.
const CLEAN_KEEP = new Set('A B STRONG I EM U S STRIKE DEL INS SUB SUP BR P DIV SPAN H1 H2 H3 H4 H5 H6 UL OL LI FONT MARK SMALL BIG TT TABLE THEAD TBODY TFOOT TR TD TH CAPTION COLGROUP COL BLOCKQUOTE PRE CODE HR Q CITE ABBR KBD SAMP VAR DFN CENTER WBR'.split(' '));
const CLEAN_DROP = new Set('SCRIPT STYLE IFRAME FRAME FRAMESET OBJECT EMBED APPLET LINK META BASE IMG PICTURE SOURCE VIDEO AUDIO TRACK CANVAS SVG MATH FORM INPUT BUTTON SELECT OPTION OPTGROUP TEXTAREA TEMPLATE NOSCRIPT NOEMBED NOFRAMES PORTAL TITLE HEAD XMP PLAINTEXT DIALOG SLOT'.split(' '));
const CLEAN_ATTR = new Set(['class', 'style', 'colspan', 'rowspan', 'color', 'face', 'size', 'align', 'valign', 'dir', 'title', 'start', 'type']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';
function cleanStyle(n){
  const keep = (n.getAttribute('style') || '').split(';').filter(d => d.trim() && !/url\s*\(|expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding|^\s*position\s*:/i.test(d));
  if(keep.length) n.setAttribute('style', keep.join(';')); else n.removeAttribute('style');
}
function cleanNode(parent){
  for(const n of [...parent.childNodes]){
    if(n.nodeType === 8){ n.remove(); continue; }
    if(n.nodeType !== 1) continue;
    const tag = n.tagName.toUpperCase();
    if(n.namespaceURI !== HTML_NS || CLEAN_DROP.has(tag)){ n.remove(); continue; }
    cleanNode(n);
    if(!CLEAN_KEEP.has(tag) || (tag === 'A' && !n.classList.contains('pl'))){ n.replaceWith(...n.childNodes); continue; }
    for(const a of [...n.attributes]){
      const k = a.name.toLowerCase();
      if(k.startsWith('data-') ? !/^data-[a-z0-9-]+$/.test(k) : !CLEAN_ATTR.has(k)) n.removeAttribute(a.name);
    }
    if(n.hasAttribute('style')) cleanStyle(n);
  }
}
function cleanHTML(html){
  const t = document.createElement('template');   // template content is inert: nothing loads or runs while cleaning
  t.innerHTML = html || '';
  cleanNode(t.content);
  return t.innerHTML;
}
function htmlText(html){
  const t = document.createElement('template'); t.innerHTML = html || '';
  t.content.querySelectorAll('li,p,h1,h2,h3,h4,h5,h6,div,br,tr,td,th').forEach(n => n.after(' '));
  return t.content.textContent.replace(/\s+/g, ' ').trim();
}
function prepTextEl(el){
  el.querySelectorAll('a.pl').forEach(a => { a.setAttribute('contenteditable', 'false'); a.classList.toggle('broken', !getDoc(a.dataset.page)); });
}
// place an element of the front layer: its left/top are world units, the camera zoom is applied here
// (1.59.3) back to transform: scale(z). 1.59.2 used CSS zoom, but iPad Safari applied it to positions and spacing
// and not to the letters, so text and formulas fell apart and moved when zooming.
function frontXf(el){
  const z = cam.z, x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
  el.style.zoom = '';
  el.style.transform = z === 1 ? '' : `translate(${(z - 1) * x}px,${(z - 1) * y}px) scale(${z})`;
}
function itemEl(it){
  let el = elMap.get(it.id);
  const layer = it.t === 'i' ? worldBack : worldFront;
  if(!el){
    el = document.createElement('div');
    el.dataset.id = it.id;
    el.className = 'it';
    layer.appendChild(el);
    elMap.set(it.id, el);
  }
  el.style.left = it.x + 'px';
  el.style.top = it.y + 'px';
  el.style.opacity = opOf(it) < 1 ? String(opOf(it)) : '';
  if(layer === worldFront) frontXf(el);
  if(it.t === 'i'){
    el.classList.add('it-img');
    el.classList.toggle('doc', !!it.doc);
    backXf(el, it);
    if(el._a !== it.a){
      // the picture itself is only loaded while it is near the screen (see updateImages)
      if(el._img){ el._img.remove(); el._img = null; }
      el._a = it.a; el._loaded = false; el.classList.add('missing');
      for(const n of [...el.childNodes]) if(n !== el._pf) n.remove();
      const msg = document.createElement('span'); msg.textContent = 'Loading'; el.insertBefore(msg, el.firstChild); el._msg = msg;
      imgSoon();
    }
    if(it.f && it.f.length) syncFields(el, it);
    else if(el._pf){ el._pf.remove(); el._pf = null; }
  } else if(it.t === 'x'){
    el.classList.add('it-text');
    el.style.width = it.w + 'px';
    el.style.fontSize = (17 * (it.fs || 1)) + 'px';
    el.style.lineHeight = it.lh ? it.lh + 'px' : '';   // lh: text placed on a worksheet's answer lines
    el.classList.toggle('lh', !!it.lh);
    el.classList.toggle('cell', !!it.ch);
    if(!(editing && editing.id === it.id) && el._html !== it.html){
      el.innerHTML = cleanHTML(it.html);
      el._html = it.html;
      prepTextEl(el);
    }
  } else if(it.t === 'm'){
    el.classList.add('it-math');
    el.style.fontSize = (it.fs || 24) + 'px';
    el.style.color = it.c && it.c !== 'auto' ? inkColor(it.c) : '';
    if(el._tex !== it.tex){
      el._tex = it.tex;
      try { katex.render(it.tex || '\\square', el, {throwOnError: true, displayMode: true}); el.classList.remove('err'); }
      catch(e){ el.textContent = it.tex; el.classList.add('err'); }
    }
  } else if(it.t === 'tp'){
    el.classList.add('it-tape');
    el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
  }
  return el;
}
function dropEl(id){ const el = elMap.get(id); if(el){ el.remove(); elMap.delete(id); } }

/* ---------- Fillable PDF form fields (on imported PDF pages) ----------
   Stored on the image item as it.f = [{k, n, x, y, w, h, v, ...}]; x/y/w/h are fractions of the page.
   k: 'tx' text, 'cb' checkbox, 'rb' radio (ev = its value), 'ch' dropdown, 'ls' list (o = [[value, label]]).
   Fields can be clicked and typed into with a mouse (PC); on the iPad they only show their values. */
// (1.56) optional look of a filled-in text field, whole field: b bold, it italic, u underline, c colour (older versions ignore them)
function fieldCss(f){
  return (f.b ? 'font-weight:700;' : '') + (f.it ? 'font-style:italic;' : '') + (f.u ? 'text-decoration:underline;' : '');
}
function fieldFont(f, it){
  if(f.s) return f.s * it.w;
  if(f.k === 'tx' && !f.ml || f.k === 'ch') return Math.min(f.h * it.h * 0.62, it.w * 0.0235);
  return it.w * 0.0202;
}
function makeField(f, i){
  let c;
  if(f.k === 'tx'){
    c = document.createElement(f.ml ? 'textarea' : 'input');
    if(!f.ml) c.type = 'text';
    if(f.mx) c.maxLength = f.mx;
    if(f.al) c.style.textAlign = f.al === 1 ? 'center' : 'right';
    c.spellcheck = prefs.spell !== false; c.autocomplete = 'off';
  } else if(f.k === 'cb' || f.k === 'rb'){
    c = document.createElement('input'); c.type = 'checkbox';
  } else {
    c = document.createElement('select');
    if(f.k === 'ls'){ c.size = Math.max(2, (f.o || []).length); if(f.ms) c.multiple = true; }
    else { const o = document.createElement('option'); o.value = ''; o.textContent = ''; c.appendChild(o); }
    for(const [v, l] of f.o || []){ const o = document.createElement('option'); o.value = v; o.textContent = l; c.appendChild(o); }
  }
  c.className = 'pf pf-' + f.k;
  c.dataset.i = i;
  if(f.ro) c.disabled = true;
  c.tabIndex = 0;
  Object.assign(c.style, {left: f.x * 100 + '%', top: f.y * 100 + '%', width: f.w * 100 + '%', height: f.h * 100 + '%'});
  return c;
}
function setFieldValue(c, f){
  if(f.k === 'tx'){ const v = f.v || ''; if(c.value !== v) c.value = v; }
  else if(f.k === 'cb') c.checked = !!f.v;
  else if(f.k === 'rb') c.checked = !!f.v && f.v === f.ev;
  else if(c.multiple){ const vs = Array.isArray(f.v) ? f.v : f.v ? [f.v] : []; for(const o of c.options) o.selected = vs.includes(o.value); }
  else { const v = Array.isArray(f.v) ? (f.v[0] || '') : (f.v || ''); c.value = v; if(c.value !== v) c.selectedIndex = -1; }
}
function syncFields(el, it){
  let L = el._pf;
  if(!L || L._n !== it.f.length){
    if(L) L.remove();
    L = el._pf = document.createElement('div');
    L.className = 'pf-layer'; L._n = it.f.length;
    it.f.forEach((f, i) => L.appendChild(makeField(f, i)));
    el.appendChild(L);
    backXf(el, it);
  }
  const ch = L.children;
  for(let i = 0; i < ch.length; i++){
    const c = ch[i], f = it.f[i];
    c.style.fontSize = fieldFont(f, it) + 'px';
    if(f.k === 'tx') Object.assign(c.style, {fontWeight: f.b ? '700' : '', fontStyle: f.it ? 'italic' : '', textDecoration: f.u ? 'underline' : '', color: f.c || ''});
    if(c !== document.activeElement) setFieldValue(c, f);
  }
}
function fieldValueOf(c, f){
  if(f.k === 'tx') return c.value;
  if(f.k === 'cb') return c.checked;
  if(f.k === 'rb') return c.checked ? f.ev : '';
  if(c.multiple) return [...c.selectedOptions].map(o => o.value);
  return c.value;
}
function fieldText(it){
  let t = '';
  for(const f of it.f || []){
    if(f.k === 'tx' && f.v) t += ' ' + f.v;
    else if((f.k === 'ch' || f.k === 'ls') && f.v && f.v.length){
      const vs = Array.isArray(f.v) ? f.v : [f.v];
      t += ' ' + vs.map(v => { const o = (f.o || []).find(o => o[0] === v); return o ? o[1] : v; }).join(' ');
    }
  }
  return t;
}
let pfFocus = null;  // (1.56) {id, i, c}: the PDF text field being typed in; the formatting bar then styles that field
let pfEdit = null;   // {id, before}: the item as it was when the field got focus (one undo step per field edit)
function pfTarget(e){
  const c = e.target && e.target.closest && e.target.closest('.pf');
  if(!c || !cur) return null;
  const host = c.closest('.it'); const it = host && cur.items.get(host.dataset.id);
  return it && it.f ? {c, it, i: +c.dataset.i} : null;
}
function pfUpdate(e){
  const t = pfTarget(e); if(!t) return;
  const f = t.it.f[t.i]; if(!f) return;
  let v = fieldValueOf(t.c, f);
  let list;
  if(f.k === 'rb'){
    if(!t.c.checked && f.v === f.ev) v = '';            // clicking the chosen radio again clears the group
    list = t.it.f.map(g => g.k === 'rb' && g.n === f.n ? Object.assign({}, g, {v}) : g);
  } else {
    if(JSON.stringify(v) === JSON.stringify(f.v)) return;
    list = t.it.f.slice(); list[t.i] = Object.assign({}, f, {v});
  }
  const nit = Object.assign({}, t.it, {f: list});
  if(!pfEdit || pfEdit.id !== nit.id) pfEdit = {id: nit.id, before: t.it};
  setItems([[nit.id, nit]]);
  if(f.k === 'rb'){ const L = elMap.get(nit.id); L && L._pf && [...L._pf.children].forEach((c, i) => setFieldValue(c, list[i])); }
}
function pfCommit(){
  if(!pfEdit || !cur) return;
  const now = cur.items.get(pfEdit.id);
  if(now && now !== pfEdit.before){ commit([[pfEdit.id, pfEdit.before]], [[pfEdit.id, now]]); pfEdit.before = now; }
}
worldBack.addEventListener('focusin', e => {
  const t = pfTarget(e); if(!t) return;
  pfEdit = {id: t.it.id, before: t.it};
  const f0 = t.it.f[t.i];
  pfFocus = f0 && f0.k === 'tx' && !f0.ro ? {id: t.it.id, i: t.i, c: t.c} : null;
  if(typeof renderFmt === 'function') renderFmt();
  // keep the field on screen (Tab can jump to a field outside the view)
  const r = t.c.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  let dx = 0, dy = 0;
  if(r.right > sr.right - 20) dx = sr.right - 20 - r.right;
  if(r.left + dx < sr.left + 20) dx = sr.left + 20 - r.left;
  if(r.bottom > sr.bottom - 20) dy = sr.bottom - 20 - r.bottom;
  if(r.top + dy < sr.top + 20) dy = sr.top + 20 - r.top;
  if(dx || dy){ cam.ox += dx; cam.oy += dy; invalidate(); saveCamSoon(); }
});
worldBack.addEventListener('input', pfUpdate);
worldBack.addEventListener('change', e => { pfUpdate(e); if(pfTarget(e)) pfCommit(); });
worldBack.addEventListener('focusout', e => {
  const t = pfTarget(e); if(!t) return;
  pfCommit(); pfEdit = null;
  const it = cur.items.get(t.it.id); if(it && it.f && it.f[t.i]) setFieldValue(t.c, it.f[t.i]);
  setTimeout(() => {
    const a = document.activeElement;
    if(pfFocus && !(a && a.closest && a.closest('.pf'))){ pfFocus = null; renderFmt(); }
  }, 120);
});
worldBack.addEventListener('keydown', e => {
  if(e.key === 'Enter' && e.target.matches && e.target.matches('input.pf')){ e.preventDefault(); e.target.blur(); }
});
// focusing a field must never scroll the stage itself
stage.addEventListener('scroll', () => { if(stage.scrollTop || stage.scrollLeft){ stage.scrollTop = 0; stage.scrollLeft = 0; } });
function itemBox(it){
  if(it.t === 's') return geoOf(it).b;
  if(it.t === 'i' || it.t === 'tp') return [it.x, it.y, it.x + it.w, it.y + it.h];
  const el = elMap.get(it.id);
  const w = el ? el.offsetWidth : (it.w || 100), h = el ? el.offsetHeight : 30;
  return [it.x, it.y, it.x + w, it.y + h];
}
function contentBox(){
  if(!cur || !cur.items.size) return null;
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for(const it of cur.items.values()){ const q = itemBox(it); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; }
  return b;
}

/* =====================================================================
   Edits and undo
   ===================================================================== */
function setItems(pairs){
  for(const [id, it] of pairs){
    if(it){ if(!cur.items.has(id)) freshItems.set(id, Date.now()); cur.items.set(id, it); if(it.t !== 's') itemEl(it); cur.lastId = id; }
    else { cur.items.delete(id); geo.delete(id); dropEl(id); freshItems.delete(id); }
  }
  changed();
}
function commit(before, after){
  cur.undo.push({b: before, a: after});
  if(cur.undo.length > 300) cur.undo.shift();
  cur.redo.length = 0;
  updUndo();
}
function apply(after, before){ setItems(after); commit(before, after); }
function addItems(list){ apply(list.map(it => [it.id, it]), list.map(it => [it.id, null])); }
function removeItems(ids){ const before = ids.map(id => [id, cur.items.get(id) || null]); apply(ids.map(id => [id, null]), before); }
function replaceItems(list){ const before = list.map(it => [it.id, cur.items.get(it.id) || null]); apply(list.map(it => [it.id, it]), before); }
function undo(){
  if(!cur) return;
  if(editing) finishEditing();
  const op = cur.undo.pop(); if(!op) return;
  setItems(op.b); cur.redo.push(op); clearSel(); updUndo();
}
function redo(){
  if(!cur) return;
  const op = cur.redo.pop(); if(!op) return;
  setItems(op.a); cur.undo.push(op); clearSel(); updUndo();
}
function updUndo(){ $('undo').disabled = !cur || !cur.undo.length; $('redo').disabled = !cur || !cur.redo.length; }
function changed(){ if(cur) cur.lx = undefined; slPages = null; lastLocalEdit = Date.now(); invalidate(0, 1, 1); saveContentSoon(); refreshPaper(); markBadgeSoon(); hwSoon(); }

async function saveContent(){
  if(!cur) return;
  const c = cur;
  const items = [...c.items.values()].map(ser);
  const rec = c.crec || {id: 'c_' + c.id, kind: 'content', deleted: false};
  const prev = rec.data;
  if(prev && c.verAt !== undefined && Date.now() - c.verAt > VER_GAP){ c.verAt = Date.now(); saveVersion(c.id, prev).catch(e => console.warn('version', e)); }
  rec.data = {bg: c.bg, items};
  if(c.lastId) rec.data.last = c.lastId;
  c.crec = rec;
  await writeDoc(rec);
  const page = getDoc(c.id);
  if(page){
    let snip = '';
    for(const it of items){ if(it.t === 'x') snip += ' ' + htmlText(it.html); else if(it.t === 'm') snip += ' ' + it.tex; if(snip.length > 200) break; }
    snip = snip.trim();
    const ttl = (page.data.title || '').trim();
    if(ttl && snip.toLowerCase().startsWith(ttl.toLowerCase())) snip = snip.slice(ttl.length).replace(/^[\s:.,\-–—]+/, '');
    await patchDoc(page, {snippet: snip.slice(0, 160)});
    refreshPageItem(c.id);
  }
}
const saveContentSoon = debounce(() => saveContent(), 700);
async function flushSaves(){
  savePrefs.flush();   // (1.50) a settings change made just before the app closes was lost (saved 300 ms later)
  if(editing) syncEditingHTML();
  await saveContentSoon.flush();
  await saveTitleSoon.flush();
  if(cur) LSset('inkwell.cam.' + cur.id, {ox: cam.ox, oy: cam.oy, z: cam.z});
}
