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
  // (1.88.1) the outline is only built when the stroke is first drawn: before, opening a page built one for every stroke
  // on it, seen or not, and kept them all in memory
  g = {it, b: strokeBox(it), _path: null, get path(){ if(!this._path){ this._path = strokePath(this.it, false); geoPaths++; } return this._path; }};
  geo.set(it.id, g);
  return g;
}
let geoPaths = 0;
// a long page: forget the outlines far from the view again (they are rebuilt when the page comes back)
function geoTrim(){
  if(geoPaths <= GEO_KEEP) return;
  const v = viewRect(), mx = v[2] - v[0], my = v[3] - v[1];
  let n = 0;
  for(const g of geo.values()){
    if(!g._path) continue;
    if(g.b[2] < v[0] - mx || g.b[0] > v[2] + mx || g.b[3] < v[1] - my || g.b[1] > v[3] + my) g._path = null; else n++;
  }
  geoPaths = n;
}
const GEO_KEEP = 3000;

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
// hl: a highlighter stroke. (1.93.1) its colour is used as it is: the swap of very light ink for dark ink (so white
// pen ink shows on white paper) turned a pale yellow highlighter into dark grey
function inkColor(c, print, onPaper, hl){
  if(onPaper) print = true;
  const dark = !print && isDark();
  if(!c || c === 'auto') return print ? '#18212B' : tokens.fg;
  if(c === 'paper') return print ? '#FFFFFF' : (tokens.paper || '#FFFFFF');   // (1.57) the page colour: white, or dark in dark mode
  if(hl) return c;
  const l = lum(c);
  if(dark && l < 0.07) return tokens.fg;
  if(!dark && l > 0.93) return '#18212B';
  return c;
}

/* =====================================================================
   Stage, camera, rendering
   ===================================================================== */
const stage = $('stage'), bgCv = $('bg'), liveCv = $('live');
let inkCv = $('ink');   // (1.69) let: replaced by a fresh canvas when the iPad loses its drawing (InkCheck)
const worldBack = $('worldBack'), worldFront = $('worldFront');
const bgCtx = bgCv.getContext('2d'), liveCtx = liveCv.getContext('2d');
let inkCtx = inkCv.getContext('2d');
// (1.62) highlighter layer under the ink: blended with "multiply" (CSS), so dark text and lines of imported pages
// stay as dark as they are and only the light paper takes the colour, like a real highlighter. On white the colour is
// exactly as before (40 % on white). Highlights over a filled shape (graph background) or, in dark mode, on the dark
// page background stay on the ink layer as before (multiply would hide them there).
let hlmCv = $('hlm'), hlmCtx = hlmCv.getContext('2d');
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

/* (1.88.1) The paper, highlighter and ink layers are bigger than the screen by MX/MY on each side, so a pan can simply slide
   them (the graphics chip does that, nothing has to be drawn). See moveInk. */
let MX = 0, MY = 0;
const LAYER_MAX_PX = 14e6;   // iPad Safari refuses canvases above about 16.7 million pixels
function setMargins(){
  let k = 1;
  while(k > 0.05 && (W + 2 * k * W * 0.1) * (H + 2 * k * H * 0.35) * dpr * dpr > LAYER_MAX_PX) k *= 0.8;
  if((W + 2 * k * W * 0.1) * (H + 2 * k * H * 0.35) * dpr * dpr > LAYER_MAX_PX) k = 0;
  MX = Math.round(W * 0.1 * k); MY = Math.round(H * 0.35 * k);
}
const toWorld = (sx, sy) => [(sx - cam.ox) / cam.z, (sy - cam.oy) / cam.z];
const viewRect = () => [-cam.ox / cam.z, -cam.oy / cam.z, (W - cam.ox) / cam.z, (H - cam.oy) / cam.z];
const layerRect = () => [(-MX - cam.ox) / cam.z, (-MY - cam.oy) / cam.z, (W + MX - cam.ox) / cam.z, (H + MY - cam.oy) / cam.z];
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
  setMargins();
  liveCv.width = Math.max(1, Math.round(W * dpr)); liveCv.height = Math.max(1, Math.round(H * dpr));
  liveCv.style.width = W + 'px'; liveCv.style.height = H + 'px';
  for(const c of [bgCv, hlmCv, inkCv]){
    c.width = Math.max(1, Math.round((W + 2 * MX) * dpr)); c.height = Math.max(1, Math.round((H + 2 * MY) * dpr));
    c.style.width = W + 2 * MX + 'px'; c.style.height = H + 2 * MY + 'px';
    c.style.transform = `translate(${-MX}px,${-MY}px)`;
  }
  inkAt.ok = false; inkAt.xf = false; bgAt.ok = false;
  if(W > 0 && H > 0 && !rulerVisible()) centerRuler(false);
  renderRuler();
  invalidate();
}
new ResizeObserver(resize).observe(stage);
addEventListener('resize', fitScreen);
addEventListener('scroll', () => { SR = stage.getBoundingClientRect(); }, true);

let rafId = 0, need = {bg: 0, ink: 0, over: 0, move: 0, boxes: []}, frontZ = 1, frontTimer = 0, frameZoomTxt = '';
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
// (1.88.1) the camera moved and nothing on the page changed: the ink already drawn can be reused (see moveInk)
function invalidateMove(){
  need.over = 1; need.move = 1;
  if(!rafId) rafId = requestAnimationFrame(frame);
}
function settleFront(){
  frontTimer = 0;
  if(frontZ === cam.z) return;
  frontZ = cam.z;
  for(const el of worldFront.children) frontXf(el);
  worldFront.style.transform = `translate(${cam.ox}px,${cam.oy}px)`;
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
  // (1.88.1) During a pinch the whole layer is stretched and the text boxes are set one by one when the zoom stops, like the pictures.
  if(cam.z !== frontZ && need.move && !need.ink){
    worldFront.style.transform = `translate(${cam.ox}px,${cam.oy}px) scale(${cam.z / frontZ})`;
    clearTimeout(frontTimer); frontTimer = setTimeout(settleFront, 150);
  } else {
    worldFront.style.transform = `translate(${cam.ox}px,${cam.oy}px)`;
    if(cam.z !== frontZ){ frontZ = cam.z; for(const el of worldFront.children) frontXf(el); }
  }
  const zt = Math.round(cam.z * 100) + '%';
  if(zt !== frameZoomTxt){ frameZoomTxt = zt; $('zoomPct').textContent = zt; }   // (1.72) only when it changes
  // (1.69) each step on its own: before, one step that threw left the rest undone on every later frame too (the
  // ink was cleared but never drawn again until the app was restarted)
  const n = need; need = {bg: 0, ink: 0, over: 0, move: 0, boxes: []};
  const step = (f, what) => { try { f(); } catch(e){ frameError(e, what); } };
  if(n.bg) step(drawBg, 'bg');
  else if(n.move) step(moveBg, 'bg');
  if(n.ink) step(drawInk, 'ink');
  else {
    if(n.boxes.length) step(() => inkBoxes(n.boxes), 'ink');
    if(n.move) step(moveInk, 'ink');
  }
  if(n.over) step(() => { positionOverlays(); imgSoon(); renderSlider(); }, 'over');
  if(act || WA.linger()) step(drawLive, 'live');   // the reference line follows the page while it is still showing
}
let frameErrs = 0;
function frameError(e, what){
  if(frameErrs++ < 20){
    console.error('frame ' + what, e);
    try { (window.__inkwellErrors = window.__inkwellErrors || []).push('frame ' + what + ': ' + (e && e.message || e)); } catch(_){}
  }
}
const bgAt = {ox: 0, oy: 0, z: 0, ok: false};
// how far (in CSS px, whole device pixels) the camera is from where a layer was drawn
const slideOf = at => [Math.round((cam.ox - at.ox) * dpr) / dpr, Math.round((cam.oy - at.oy) * dpr) / dpr];
function moveBg(){
  if(!bgAt.ok || cam.z !== bgAt.z) return drawBg();
  const [dx, dy] = slideOf(bgAt);
  if(Math.abs(dx) > MX || Math.abs(dy) > MY) return drawBg();
  bgCv.style.transform = `translate(${dx - MX}px,${dy - MY}px)`;
}
function drawBg(){
  bgCtx.setTransform(1, 0, 0, 1, 0, 0);
  bgCtx.clearRect(0, 0, bgCv.width, bgCv.height);
  bgAt.ox = cam.ox; bgAt.oy = cam.oy; bgAt.z = cam.z; bgAt.ok = true;
  bgCv.style.transform = `translate(${-MX}px,${-MY}px)`;
  if(!cur) return;
  drawPaperLines();
  const col = ML_COLORS[cur.bg.ml];
  if(col){
    // (1.75) stays the same width on screen at any zoom, like the paper lines
    const lw = cur.bg.mw === 'thick' ? 3 : 1.5, X = Math.round(mlX(cur.bg) * cam.z + cam.ox);
    bgCtx.setTransform(dpr, 0, 0, dpr, dpr * MX, dpr * MY);
    bgCtx.fillStyle = col; bgCtx.fillRect(X - lw / 2, -MY, lw, H + 2 * MY);
  }
}
function drawPaperLines(){
  const bg = cur.bg;
  if(bg.type === 'blank') return;
  bgCtx.setTransform(dpr, 0, 0, dpr, dpr * MX, dpr * MY);
  let kx = 1, ky = 1;
  while(bg.sx * kx * cam.z < 7) kx *= 2;
  while(bg.sy * ky * cam.z < 7) ky *= 2;
  const stepX = bg.sx * kx, stepY = bg.sy * ky;
  const v = layerRect();
  const x0 = Math.floor(v[0] / stepX) * stepX, y0 = Math.floor(v[1] / stepY) * stepY;
  if(bg.type === 'hex'){
    // (1.73) chemistry hexagons; zoomed far out the cells double in size so the lines never turn into a grey wash
    let s = bg.sy;
    while(s * cam.z < 6) s *= 2;
    bgCtx.strokeStyle = tokens.rule; bgCtx.lineWidth = 1;
    bgCtx.beginPath();
    const z = cam.z, ox = cam.ox, oy = cam.oy;
    hexEdges(s, v[0], v[1], v[2], v[3], (x1, y1, x2, y2) => { bgCtx.moveTo(x1 * z + ox, y1 * z + oy); bgCtx.lineTo(x2 * z + ox, y2 * z + oy); });
    bgCtx.stroke();
    return;
  }
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
  for(let y = y0; y <= v[3]; y += stepY){ const Y = Math.round(y * cam.z + cam.oy) + 0.5; bgCtx.moveTo(-MX, Y); bgCtx.lineTo(W + MX, Y); }
  if(bg.type === 'grid') for(let x = x0; x <= v[2]; x += stepX){ const X = Math.round(x * cam.z + cam.ox) + 0.5; bgCtx.moveTo(X, -MY); bgCtx.lineTo(X, H + MY); }
  bgCtx.stroke();
}
/* (1.69) Ink self-check. Rafael's iPad sometimes showed none of his ink after moving around the page while every
   stroke was still saved: the ink layer had lost its picture (iPad Safari can drop a canvas's drawing, for example
   when it runs short of memory for canvases, and then draws nothing on it). After the page stops moving, a few
   points on the centre line of pen strokes that were just drawn are read back from the ink layer; if none of them
   has any ink, the ink and highlighter layers are replaced by fresh canvases and drawn again. A wrong alarm only costs
   one extra redraw (at most every 3 s). */
const InkCheck = {
  probes: [], timer: 0, last: 0, heals: 0,
  // remember where a fully visible pen stroke must have ink (device pixels on the ink layer)
  note(it){
    if(this.probes.length >= 8 || it.fl || it.c === 'paper' || opOf(it) < 1 || it.w * cam.z * dpr < 3) return;
    const p = it.p, m = p.length / 3; if(m < 1) return;
    // (1.72) the point on the drawn centre line: the raw recorded point can lie beside the ink on sharp little
    // zigzags (the drawing smooths them), which at high zoom made a false "ink lost" and replaced the layers for nothing
    const [px, py] = shapePoint(p, Math.floor(m / 2)), x = Math.round((px * inkAt.z + inkAt.ox + MX) * dpr), y = Math.round((py * inkAt.z + inkAt.oy + MY) * dpr);
    if(x >= 1 && y >= 1 && x < inkCv.width - 1 && y < inkCv.height - 1) this.probes.push([x, y]);
  },
  soon(){ clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 450); },
  lost(){
    try {
      if(typeof inkCtx.isContextLost === 'function' && inkCtx.isContextLost()) return true;
      for(const [x, y] of this.probes){
        const d = inkCtx.getImageData(x - 1, y - 1, 3, 3).data;
        for(let i = 3; i < d.length; i += 4) if(d[i] > 0) return false;
      }
      return true;
    } catch(e){ return false; }   // could not read it back: no proof that anything is wrong
  },
  run(){
    this.timer = 0;
    if(act || !cur || !this.probes.length) return;
    if(!this.lost()) return;
    if(Date.now() - this.last < 3000) return;
    this.last = Date.now(); this.heals++;
    try { const E = window.__inkwellErrors = window.__inkwellErrors || []; if(E.length < 50) E.push('ink layer was empty, drawn again on a fresh canvas'); } catch(_){}
    inkCv = freshCanvas(inkCv); inkCtx = inkCv.getContext('2d');
    hlmCv = freshCanvas(hlmCv); hlmCtx = hlmCv.getContext('2d'); hlmUsed = false;
    invalidate(0, 1, 0);
  }
};
// a new canvas in place of an old one (same id, size and look); the old one gives back its memory
function freshCanvas(old){
  const c = document.createElement('canvas');
  c.id = old.id; c.className = old.className; c.style.cssText = old.style.cssText;
  c.width = old.width; c.height = old.height;
  watchCanvas(c);
  old.replaceWith(c);
  old.width = old.height = 1;
  return c;
}
// a canvas whose drawing the browser threw away and gives back later: draw everything again
function watchCanvas(c){
  c.addEventListener('contextlost', e => e.preventDefault());
  c.addEventListener('contextrestored', () => invalidate());
}
for(const c of [bgCv, hlmCv, inkCv, liveCv]) watchCanvas(c);
// (1.94) highlighter strength: the exact colour picked (was 0.4, and 0.34 on the dark page). Highlights blend into
// what is under them (multiply), so printed text and writing stay readable through them
const HL_A = 1;
// (1.62) does this highlight blend into the page (multiply)? fills = boxes of filled shapes on the page
const hlMultiply = (paper, b, fills) => (paper || !isDark()) && !fills.some(f => f[0] < b[2] && f[2] > b[0] && f[1] < b[3] && f[3] > b[1]);
// the camera the ink and highlighter layers were last drawn with
const inkAt = {ox: 0, oy: 0, z: 0, ok: false, t: 0, xf: false, full: 0, moves: 0, scales: 0, slides: 0, parts: 0};
let inkScratch = null, inkSettleT = 0;
function setInkXf(v){ inkCv.style.transform = v; hlmCv.style.transform = v; }
// draw the strokes that touch one of the boxes (world units); the marks of "Mark for later" go on top
function paintInk(boxes, probe){
  const tr = [dpr * inkAt.z, 0, 0, dpr * inkAt.z, dpr * (inkAt.ox + MX), dpr * (inkAt.oy + MY)];
  inkCtx.setTransform(...tr); hlmCtx.setTransform(...tr);
  const pages = paperRects(), fills = [];
  const seen = b => boxes.some(v => !(b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3]));
  for(const pass of [2, 1, 0]){
    for(const it of cur.items.values()){
      if(it.t !== 's' || inkPass(it) !== pass || Tech.hidden(it)) continue;   // (2.0) hidden layer
      // (1.69) one broken stroke is skipped instead of stopping the drawing of all the others
      try {
        const g = geoOf(it);
        if(pass === 2) fills.push(g.b);
        if(!seen(g.b)) continue;
        const paper = onPaperAt(pages, (g.b[0] + g.b[2]) / 2, (g.b[1] + g.b[3]) / 2);
        const ctx = pass === 1 && hlMultiply(paper, g.b, fills) ? hlmCtx : inkCtx;
        if(ctx === hlmCtx) hlmUsed = true;
        ctx.globalAlpha = (pass === 1 ? HL_A : 1) * opOf(it);
        // (1.94) on the ink layer (over a filled shape) a light-mode highlight multiplies too, so the fill shows through;
        // on the dark page it is drawn as it is (multiply would hide it there)
        ctx.globalCompositeOperation = pass === 1 && ctx === inkCtx && !(isDark() && !paper) ? 'multiply' : 'source-over';
        ctx.fillStyle = inkColor(it.c, false, paper, it.hl);
        ctx.fill(g.path);
        if(probe && pass === 0) InkCheck.note(it);
      } catch(e){ frameError(e, 'stroke ' + it.id); }
    }
  }
  inkCtx.globalAlpha = 1; hlmCtx.globalAlpha = 1; inkCtx.globalCompositeOperation = 'source-over';
  // one small bookmark at the top right of every marked spot
  inkCtx.setTransform(dpr, 0, 0, dpr, dpr * MX, dpr * MY);
  inkCtx.fillStyle = MARK_C;
  for(const g of clusterMarks([...cur.items.values()])){
    const b = g.b;
    if(!boxes.some(v => !(b[2] < v[0] - 40 / inkAt.z || b[0] > v[2] + 40 / inkAt.z || b[3] < v[1] - 40 / inkAt.z || b[1] > v[3] + 40 / inkAt.z))) continue;
    const x = b[2] * inkAt.z + inkAt.ox - 4, y = b[1] * inkAt.z + inkAt.oy - 8;
    inkCtx.beginPath(); inkCtx.moveTo(x, y); inkCtx.lineTo(x + 10, y); inkCtx.lineTo(x + 10, y + 14); inkCtx.lineTo(x + 5, y + 10.5); inkCtx.lineTo(x, y + 14); inkCtx.closePath(); inkCtx.fill();
  }
  // (1.88.1) an empty blending layer over the whole page still has to be blended on every frame: left out while it is empty
  const show = hlmUsed ? '' : 'none';
  if(hlmCv.style.display !== show) hlmCv.style.display = show;
}
function drawInk(){
  clearTimeout(inkSettleT); inkSettleT = 0;
  inkAt.xf = false;
  setInkXf(`translate(${-MX}px,${-MY}px)`);
  inkCtx.setTransform(1, 0, 0, 1, 0, 0);
  inkCtx.clearRect(0, 0, inkCv.width, inkCv.height);
  if(hlmUsed){ hlmCtx.setTransform(1, 0, 0, 1, 0, 0); hlmCtx.clearRect(0, 0, hlmCv.width, hlmCv.height); hlmUsed = false; }
  inkAt.ok = !!cur;
  if(!cur) return;
  inkAt.ox = cam.ox; inkAt.oy = cam.oy; inkAt.z = cam.z; inkAt.t = performance.now(); inkAt.full++;
  InkCheck.probes = [];
  paintInk([layerRect()], true);
  if(InkCheck.probes.length) InkCheck.soon();
}
// redraw only these parts of the layers (device pixels: [x, y, w, h]), with everything that touches them, in the right order
function paintRects(rects, probe){
  const b = r => [(r[0] / dpr - MX - inkAt.ox) / inkAt.z - 8 / inkAt.z, (r[1] / dpr - MY - inkAt.oy) / inkAt.z - 8 / inkAt.z, ((r[0] + r[2]) / dpr - MX - inkAt.ox) / inkAt.z + 8 / inkAt.z, ((r[1] + r[3]) / dpr - MY - inkAt.oy) / inkAt.z + 8 / inkAt.z];
  for(const ctx of [inkCtx, hlmCtx]){
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    for(const r of rects) ctx.clearRect(r[0], r[1], r[2], r[3]);
    ctx.beginPath();
    for(const r of rects) ctx.rect(r[0], r[1], r[2], r[3]);
    ctx.clip();
  }
  try { paintInk(rects.map(b), probe); }
  finally { inkCtx.restore(); hlmCtx.restore(); }
}
// (1.88.1) strokes added or removed: only their part of the layers. The layers are bigger than the screen now, and drawing
// all of it after every stroke would have made writing slower.
function inkBoxes(boxes){
  if(!cur || !inkAt.ok || cam.z !== inkAt.z || inkAt.xf) return drawInk();
  const w = inkCv.width, h = inkCv.height, rects = [];
  if(boxes.length > 12) boxes = [boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])])];
  for(const q of boxes){
    const x0 = Math.max(0, Math.floor(dpr * (q[0] * inkAt.z + inkAt.ox + MX)) - 2), y0 = Math.max(0, Math.floor(dpr * (q[1] * inkAt.z + inkAt.oy + MY)) - 2);
    const x1 = Math.min(w, Math.ceil(dpr * (q[2] * inkAt.z + inkAt.ox + MX)) + 2), y1 = Math.min(h, Math.ceil(dpr * (q[3] * inkAt.z + inkAt.oy + MY)) + 2);
    if(x1 > x0 && y1 > y0) rects.push([x0, y0, x1 - x0, y1 - y0]);
  }
  if(!rects.length) return;
  paintRects(rects, true);
  inkAt.parts++;
  if(InkCheck.probes.length) InkCheck.soon();
}
/* (1.88.1) Moving around a page. Every frame of a pan used to clear the ink layer and fill every stroke on screen again, which
   is what made pages with a lot of writing lag: the code itself takes about 3 ms, turning the strokes into pixels far longer.
   Now the picture already drawn is reused:
   - pan: the layers are bigger than the screen (MX, MY) and just slide, by whole device pixels so they stay sharp. Only when
     the edge gets near is the picture moved back and the strip that came into view drawn. Through a helper canvas and not
     onto itself: Safari has had trouble with a canvas drawing itself in some composite modes.
   - pinch: the layers are stretched with CSS, and drawn again when the zoom stops, or sooner if empty edges would show.
   When the page stops, the camera settles on the same whole device pixel, so nothing has to be drawn again. Any change to the
   page goes through invalidate() or inkBoxes() as before. */
function shiftLayer(cv, ctx, dx, dy){
  if(inkScratch.width !== cv.width || inkScratch.height !== cv.height){ inkScratch.width = cv.width; inkScratch.height = cv.height; }
  const sc = inkScratch.getContext('2d');
  sc.setTransform(1, 0, 0, 1, 0, 0); sc.clearRect(0, 0, cv.width, cv.height); sc.drawImage(cv, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(inkScratch, dx, dy);
}
function moveInk(){
  if(!cur || !inkAt.ok) return drawInk();
  inkSettle();
  if(cam.z !== inkAt.z || inkAt.xf){
    const k = cam.z / inkAt.z, tx = cam.ox - k * (inkAt.ox + MX), ty = cam.oy - k * (inkAt.oy + MY);
    const gaps = tx > 0 || ty > 0 || tx + (W + 2 * MX) * k < W || ty + (H + 2 * MY) * k < H;
    if((gaps || k > 1.6) && performance.now() - inkAt.t > 160) return drawInk();
    inkAt.xf = true;
    setInkXf(`translate(${tx}px,${ty}px) scale(${k})`);
    inkAt.scales++;
    return;
  }
  const [sx, sy] = slideOf(inkAt);
  if(Math.abs(sx) <= MX * 0.7 && Math.abs(sy) <= MY * 0.7){
    setInkXf(`translate(${sx - MX}px,${sy - MY}px)`);
    inkAt.slides++;
    return;
  }
  const w = inkCv.width, h = inkCv.height, dx = Math.round(sx * dpr), dy = Math.round(sy * dpr);
  if(Math.abs(dx) * 2 >= w || Math.abs(dy) * 2 >= h) return drawInk();
  if(!inkScratch) inkScratch = document.createElement('canvas');
  shiftLayer(inkCv, inkCtx, dx, dy);
  if(hlmUsed) shiftLayer(hlmCv, hlmCtx, dx, dy);
  inkAt.ox += sx; inkAt.oy += sy; inkAt.moves++;
  setInkXf(`translate(${-MX}px,${-MY}px)`);
  InkCheck.probes = InkCheck.probes.map(q => [q[0] + dx, q[1] + dy]).filter(q => q[0] >= 1 && q[1] >= 1 && q[0] < w - 1 && q[1] < h - 1);
  const rects = [];
  if(dx > 0) rects.push([0, 0, dx, h]); else if(dx < 0) rects.push([w + dx, 0, -dx, h]);
  if(dy > 0) rects.push([0, 0, w, dy]); else if(dy < 0) rects.push([0, h + dy, w, -dy]);
  if(rects.length) paintRects(rects, false);
}
function inkSettle(){
  clearTimeout(inkSettleT);
  inkSettleT = setTimeout(() => {
    inkSettleT = 0;
    if(inkScratch){ inkScratch.width = inkScratch.height = 1; inkScratch = null; }   // back to the canvas memory used at rest
    if(!cur) return;
    if(inkAt.xf || cam.z !== inkAt.z) invalidate(1, 1, 0);
    else {
      // settle on the whole device pixel the layers are at, so the ink and the pictures line up exactly
      const [sx, sy] = slideOf(inkAt), nx = inkAt.ox + sx, ny = inkAt.oy + sy;
      if(!act && (nx !== cam.ox || ny !== cam.oy)){ cam.ox = nx; cam.oy = ny; invalidateMove(); }   // the frame after this finds nothing to change, so this ends
      if(InkCheck.probes.length) InkCheck.soon();
    }
    geoTrim();
  }, 120);
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
  }, () => { el._loading = false; el._failAt = Date.now(); if(el._msg) el._msg.textContent = 'Not downloaded yet'; });   // (1.72) a failed read waits too
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
  const keep = (n.getAttribute('style') || '').split(';').filter(d => d.trim() && !/\\|url\s*\(|expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding|^\s*position\s*:/i.test(d));
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
  el.classList.toggle('ly-off', Tech.hidden(it));   // (2.0) technical notebook: hidden layer
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
// (1.88.1) the parts of the ink layers a change touches; null = draw everything (pictures change the ink colour on them,
// filled shapes change how highlights blend, marks group with marks elsewhere)
function dirtyBoxes(pairs){
  const out = [];
  for(const [id, it] of pairs){
    for(const x of [cur.items.get(id), it]){
      if(!x || x.t === 'x' || x.t === 'm' || x.t === 'tp') continue;
      if(x.t !== 's' || x.mk || inkPass(x) === 2) return null;
      out.push(geoOf(x).b);
    }
  }
  return out;
}
function setItems(pairs){
  const dirty = dirtyBoxes(pairs);
  for(const [id, it] of pairs){
    if(it){ if(!cur.items.has(id)) freshItems.set(id, Date.now()); cur.items.set(id, it); if(it.t !== 's') itemEl(it); cur.lastId = id; }
    else { cur.items.delete(id); geo.delete(id); dropEl(id); freshItems.delete(id); }
  }
  changed(dirty);
}
function commit(before, after){
  // (2.0) dimensions anchored to something that changed are rebuilt in the same undo step; an id already in the step keeps
  // its first "before" and its latest "after"
  for(const ex of [Tech.follow(before, after), Tech.followParts(before, after)]){
    if(!ex) continue;
    const seen = new Set(before.map(p => p[0]));
    before = before.concat(ex[0].filter(p => !seen.has(p[0])));
    const late = new Map(ex[1]); after = after.filter(p => !late.has(p[0])).concat(ex[1]);
  }
  cur.undo.push({b: before, a: after});
  if(cur.undo.length > 300) cur.undo.shift();
  cur.redo.length = 0;
  updUndo();
}
function apply(after, before){ setItems(after); commit(before, after); }
function addItems(list){ list = Tech.layerNew(list); apply(list.map(it => [it.id, it]), list.map(it => [it.id, null])); }
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
  if(editing) finishEditing();   // (1.72) like undo: the box being typed in is finished first (else its old text came back over the redo)
  const op = cur.redo.pop(); if(!op) return;
  setItems(op.a); cur.undo.push(op); clearSel(); updUndo();
}
function updUndo(){ $('undo').disabled = !cur || !cur.undo.length; $('redo').disabled = !cur || !cur.redo.length; }
function changed(dirty){
  if(cur) cur.lx = undefined;
  slPages = null; lastLocalEdit = Date.now();
  if(dirty){ need.boxes.push(...dirty); invalidate(0, 0, 1); } else invalidate(0, 1, 1);
  saveContentSoon(); refreshPaper(); markBadgeSoon(); hwSoon();
}

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
const saveContentSoon = debounce(() => saveContent().catch(e => console.warn('save', e)), 700);   // (1.88) SaveWatch shows and retries a failed save
async function flushSaves(){
  savePrefs.flush();   // (1.50) a settings change made just before the app closes was lost (saved 300 ms later)
  if(editing) syncEditingHTML();
  await saveContentSoon.flush();
  await saveTitleSoon.flush();
  if(cur) LSset('inkwell.cam.' + cur.id, {ox: cam.ox, oy: cam.oy, z: cam.z});
}
