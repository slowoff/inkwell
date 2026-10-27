/* Inkwell app, part 12 of 13: Page slider, camera scan, calculator, keyboard.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
/* =====================================================================
   Page slider on the right: jump through imported pages
   ===================================================================== */
let slPages = null, slDrag = null, slHideT = 0;
// The slider stays hidden and untouchable, so a resting palm can't grab it. It only shows up
// for a deliberate scroll: one finger dragged up or down at least 40 px, starting away from the
// right edge (where the palm rests), not right after the Pencil was used; or a wheel / trackpad scroll.
const SLIDER_EDGE = 160, SLIDER_PEN_QUIET = 900;
function panWakes(x0, dy, dx){
  if(x0 > W - SLIDER_EDGE) return false;
  if(penDown || performance.now() - penAt < SLIDER_PEN_QUIET) return false;
  return Math.abs(dy) >= 40 && Math.abs(dy) > Math.abs(dx);
}
function sleepSlider(){
  const el = $('pgSlider'); if(!el || slDrag) return;
  clearTimeout(slHideT); el.classList.remove('awake');
}
function wakeSlider(){
  const el = $('pgSlider'); if(!el) return;
  el.classList.add('awake');
  clearTimeout(slHideT);
  slHideT = setTimeout(() => { if(!slDrag) el.classList.remove('awake'); }, 1500);
}
function sliderPages(){
  if(slPages) return slPages;
  slPages = cur ? [...cur.items.values()].filter(it => it.t === 'i' && it.h > 150).sort((a, b) => a.y - b.y || a.x - b.x) : [];
  return slPages;
}
function sliderIndexAt(){
  const pages = sliderPages(); if(!pages.length) return 0;
  const v = viewRect(), cy = v[1] + (v[3] - v[1]) * 0.35;
  let best = 0, bd = Infinity;
  pages.forEach((p, i) => { const d = cy < p.y ? p.y - cy : cy > p.y + p.h ? cy - p.y - p.h : 0; if(d < bd){ bd = d; best = i; } });
  return best;
}
function renderSlider(){
  const el = $('pgSlider'); if(!el) return;
  const pages = sliderPages();
  if(!cur || pages.length < 2){ el.hidden = true; return; }
  el.hidden = false;
  const i = slDrag ? slDrag.i : sliderIndexAt(), n = pages.length;
  const track = $('pgTrack'), th = track.clientHeight;
  const y = n > 1 ? i / (n - 1) * th : 0;
  $('pgThumb').style.transform = `translateY(${y}px)`;
  $('pgLabel').textContent = `${i + 1} / ${n}`;
  $('pgLabel').style.transform = `translateY(${y}px)`;
  // violet ticks where pages have "later" marks
  const key = n + ':' + [...markCounts.entries()].join() + ':' + (cur.items.size);
  if(el._ticks !== key){
    el._ticks = key;
    const marks = clusterMarks([...cur.items.values()]);
    const idx = new Set();
    for(const g of marks){ const my = (g.b[1] + g.b[3]) / 2; const k = pages.findIndex(p => my >= p.y && my <= p.y + p.h); if(k >= 0) idx.add(k); }
    $('pgTicks').innerHTML = [...idx].map(k => `<i style="top:${(n > 1 ? k / (n - 1) * 100 : 0).toFixed(2)}%"></i>`).join('');
  }
}
function sliderJump(i){
  const p = sliderPages()[i]; if(!p) return;
  cam.oy = 16 - p.y * cam.z;
  const v = viewRect();
  if(p.x + p.w < v[0] || p.x > v[2]) cam.ox = Math.max(16, (W - p.w * cam.z) / 2) - p.x * cam.z;
  invalidate(); saveCamSoon();
}
{
  const el = $('pgSlider');
  const at = e => { const r = $('pgTrack').getBoundingClientRect(), n = sliderPages().length; return clamp(Math.round((e.clientY - r.top) / Math.max(1, r.height) * (n - 1)), 0, n - 1); };
  el.addEventListener('pointerdown', e => {
    e.stopPropagation(); e.preventDefault();
    if(!sliderPages().length || !el.classList.contains('awake')) return;
    if(e.pointerType === 'touch' && Math.max(e.width || 0, e.height || 0) > 44) return;   // palm, not a fingertip
    slDrag = {id: e.pointerId, i: at(e)};
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('on'); sliderJump(slDrag.i); renderSlider();
  });
  el.addEventListener('pointermove', e => {
    e.stopPropagation();
    if(!slDrag || e.pointerId !== slDrag.id) return;
    const i = at(e); if(i !== slDrag.i){ slDrag.i = i; sliderJump(i); renderSlider(); }
  });
  const end = e => { e.stopPropagation(); if(!slDrag || e.pointerId !== slDrag.id) return; slDrag = null; el.classList.remove('on'); wakeSlider(); renderSlider(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}

/* =====================================================================
   Scan paper with the camera: find the sheet, straighten it, clean it up
   ===================================================================== */
const Scan = {
  src: null,      // canvas with the photo (max 2600 px)
  q: null,        // corners in photo pixels [[x,y] x4] TL, TR, BR, BL
  mode: 'doc',
  // (1.52) several scans in a row: queue = photos chosen together (one by one, or Add all), n = scans added since
  // the window opened. iPad Safari only opens the camera right after a tap, so "scan next" shows a button for it.
  queue: [], n: 0, total: 0,
  reset(){ this.queue = []; this.n = 0; this.total = 0; this.pickView(); },
  pickView(){
    $('scanSetup').hidden = true; $('scanPick').hidden = false; $('scanStatus').textContent = '';
    const n = this.n;
    $('scanPickMsg').textContent = n ? (n === 1 ? '1 scan added.' : n + ' scans added.') + ' Take the next photo, choose more, or tap Done.' : 'Lay the sheet on a darker table, take the photo from above, and Inkwell straightens it.';
    $('scanTake').firstChild.textContent = n ? 'Take next photo' : 'Take photo';
    $('scanDone').hidden = !n;
  },
  ui(){
    const left = this.queue.length, pos = this.total - left;
    $('scanNext').textContent = left ? 'Add & next (' + pos + ' of ' + this.total + ')' : 'Add & scan next';
    $('scanGo').textContent = left ? 'Add & finish' : 'Add to page';
    $('scanAll').hidden = !left;
    $('scanAll').textContent = 'Add all ' + (left + 1) + ' as they are';
  },
  async next(){
    const f = this.queue.shift();
    $('scanPick').hidden = true; $('scanSetup').hidden = false;
    this.ui();
    try { await this.load(f); } catch(e){ console.warn(e); $('scanStatus').textContent = 'This photo could not be opened.'; }
    if(this.total > 1) $('scanStatus').textContent = 'Photo ' + (this.total - this.queue.length) + ' of ' + this.total + '. ' + $('scanStatus').textContent;
  },
  async load(file){
    $('scanStatus').textContent = 'Reading photo';
    let bmp;
    try { bmp = await createImageBitmap(file, {imageOrientation: 'from-image'}); }
    catch { const u = URL.createObjectURL(file); const im = new Image(); im.src = u; await im.decode(); bmp = im; }
    const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight, k = Math.min(1, 2600 / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if(bmp.close) bmp.close();
    this.src = c; this.q = findSheet(c); this.draw();
    $('scanStatus').textContent = this.q.auto ? 'Drag the corners if they are not on the edges of the sheet.' : 'Could not find the sheet. Drag the corners onto its edges.';
  },
  rotate(){
    if(!this.src) return;
    const s = this.src, c = document.createElement('canvas'); c.width = s.height; c.height = s.width;
    const ctx = c.getContext('2d'); ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(s, 0, 0);
    // corners turn with the photo: (x, y) -> (H - y, x), and the order shifts by one
    const q = this.q.map(([x, y]) => [s.height - y, x]);
    this.q = [q[3], q[0], q[1], q[2]]; this.q.auto = true;
    s.width = s.height = 1; this.src = c; this.draw();
  },
  // view geometry: photo fitted into the editor box
  fit(){
    const box = $('scanView'), bw = box.clientWidth || 480, bh = box.clientHeight || 520;
    const k = Math.min(bw / this.src.width, bh / this.src.height);
    return {k, ox: (bw - this.src.width * k) / 2, oy: (bh - this.src.height * k) / 2};
  },
  draw(){
    if(!this.src) return;
    const cv = $('scanCv'), f = this.fit(), d = Math.min(window.devicePixelRatio || 1, 2);
    const vw = $('scanView').clientWidth || 480, vh = $('scanView').clientHeight || 520;
    cv.width = Math.round(vw * d); cv.height = Math.round(vh * d); cv.style.width = vw + 'px'; cv.style.height = vh + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, vw, vh);
    ctx.drawImage(this.src, f.ox, f.oy, this.src.width * f.k, this.src.height * f.k);
    const P = this.q.map(([x, y]) => [f.ox + x * f.k, f.oy + y * f.k]);
    ctx.fillStyle = 'rgba(10,14,20,.45)';
    ctx.beginPath(); ctx.rect(0, 0, vw, vh); ctx.moveTo(P[0][0], P[0][1]); for(const p of [P[3], P[2], P[1]]) ctx.lineTo(p[0], p[1]); ctx.closePath(); ctx.fill('evenodd');
    ctx.strokeStyle = '#3BA5F0'; ctx.lineWidth = 2; ctx.beginPath(); P.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
    $('scanView').querySelectorAll('.scan-h').forEach((h, i) => { h.style.left = P[i][0] + 'px'; h.style.top = P[i][1] + 'px'; });
  },
  async place(again){
    if(!this.src || !cur) return;
    const go = $('scanGo'), go2 = $('scanNext'), go3 = $('scanAll'); go.disabled = go2.disabled = go3.disabled = true;
    $('scanStatus').textContent = 'Straightening';
    await new Promise(r => setTimeout(r, 30));
    try {
      await this.put();
      if(again === 'all'){
        // the rest of the chosen photos, with the corners Inkwell finds
        while(this.queue.length){
          const f = this.queue.shift();
          $('scanStatus').textContent = 'Adding photo ' + (this.total - this.queue.length) + ' of ' + this.total;
          try { await this.load(f); await this.put(); } catch(e){ console.warn('scan', e); }
        }
        toast(this.n === 1 ? 'Scan placed on the page' : this.n + ' scans placed on the page');
        this.queue = []; hideModal('scanDlg');
      } else if(this.queue.length && again !== false){ toast('Scan placed on the page'); await this.next(); }
      else if(again){ toast('Scan placed on the page'); this.queue = []; this.pickView(); }
      else { toast(this.n > 1 ? this.n + ' scans placed on the page' : 'Scan placed on the page'); this.queue = []; hideModal('scanDlg'); }
    } catch(e){ console.warn(e); $('scanStatus').textContent = 'Could not process the photo: ' + (e.message || e); }
    go.disabled = go2.disabled = go3.disabled = false;
  },
  // straighten the current photo and put it under everything on the page
  async put(){
    {   // (body kept from before 1.52)
      const out = warpSheet(this.src, this.q, 1700);
      if(this.mode === 'doc'){ $('scanStatus').textContent = 'Cleaning up'; await new Promise(r => setTimeout(r, 10)); cleanPaper(out); }
      const a = await saveAsset(await canvasBlob(out));
      const wW = A4W, hW = wW * out.height / out.width;
      out.width = out.height = 1;
      const cb = contentBox(), [vx, vy] = toWorld(W > 600 ? 48 : 16, 24);
      const x0 = cb ? cb[0] : vx, y0 = cb ? cb[3] + 48 : vy;
      addItems([{t: 'i', id: 'i' + newId(), x: x0, y: y0, w: wW, h: hW, a, doc: 1}]); PT.soon();
      setTool('pen');
      cam.ox = (W > 600 ? 48 : 16) - x0 * cam.z; cam.oy = 24 - y0 * cam.z; invalidate(); saveCamSoon();
      this.src.width = this.src.height = 1; this.src = null;
      this.n++;
    }
  }
};
// Finds the sheet of paper: the biggest bright area, then its four outermost corners.
function findSheet(src){
  const k = Math.min(1, 360 / Math.max(src.width, src.height)), w = Math.max(8, Math.round(src.width * k)), h = Math.max(8, Math.round(src.height * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', {willReadFrequently: true}); ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const L = new Float32Array(w * h), hist = new Uint32Array(256);
  for(let i = 0; i < w * h; i++){ const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2]; const v = (r * 77 + g * 150 + b * 29) >> 8; const sat = Math.max(r, g, b) - Math.min(r, g, b); L[i] = v - sat * 0.5; hist[clamp(Math.round(L[i]), 0, 255)]++; }
  // Otsu threshold between paper and background
  let sum = 0; for(let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, t = 128;
  for(let i = 0; i < 256; i++){ wB += hist[i]; if(!wB) continue; const wF = w * h - wB; if(!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if(v > best){ best = v; t = i; } }
  const on = new Uint8Array(w * h); for(let i = 0; i < w * h; i++) on[i] = L[i] > t ? 1 : 0;
  // biggest connected bright area
  const lab = new Int32Array(w * h).fill(-1), stack = [];
  let bestN = 0, bestL = -1, nl = 0;
  for(let i = 0; i < w * h; i++){
    if(!on[i] || lab[i] >= 0) continue;
    let n = 0; lab[i] = nl; stack.push(i);
    while(stack.length){ const j = stack.pop(); n++; const x = j % w, y = (j / w) | 0; for(const q of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if(q >= 0 && on[q] && lab[q] < 0){ lab[q] = nl; stack.push(q); } }
    if(n > bestN){ bestN = n; bestL = nl; } nl++;
  }
  const fallback = () => { const m = 0.04; const q = [[src.width * m, src.height * m], [src.width * (1 - m), src.height * m], [src.width * (1 - m), src.height * (1 - m)], [src.width * m, src.height * (1 - m)]]; q.auto = false; return q; };
  if(bestN < w * h * 0.12) return fallback();
  // touching the photo edge on all four sides means it is the background (or a full-frame page)
  let tl = null, tr = null, br = null, bl = null;
  for(let i = 0; i < w * h; i++){
    if(lab[i] !== bestL) continue;
    const x = i % w, y = (i / w) | 0;
    if(!tl || x + y < tl[0] + tl[1]) tl = [x, y];
    if(!br || x + y > br[0] + br[1]) br = [x, y];
    if(!tr || x - y > tr[0] - tr[1]) tr = [x, y];
    if(!bl || y - x > bl[1] - bl[0]) bl = [x, y];
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / k, (y + 0.5) / k]);
  const area = Math.abs(q.reduce((a, p, i) => { const n2 = q[(i + 1) % 4]; return a + p[0] * n2[1] - n2[0] * p[1]; }, 0)) / 2;
  // too small, or simply the whole photo (no edge between sheet and table): let the user place the corners
  if(area < src.width * src.height * 0.15 || area > src.width * src.height * 0.95) return fallback();
  q.auto = true;
  return q;
}
// Perspective warp of the quadrilateral q (TL, TR, BR, BL) onto a rectangle outW wide.
function warpSheet(src, q, outW){
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wq = (d(q[0], q[1]) + d(q[3], q[2])) / 2, hq = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  let ratio = hq / Math.max(1, wq);
  if(Math.abs(ratio - Math.SQRT2) / Math.SQRT2 < 0.1) ratio = Math.SQRT2;   // close to A4 portrait
  else if(Math.abs(ratio - 1 / Math.SQRT2) * Math.SQRT2 < 0.1) ratio = 1 / Math.SQRT2;
  const W2 = Math.round(outW), H2 = Math.round(outW * ratio);
  // homography from the unit square to the quadrilateral
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den ? (dx3 * dy2 - dx2 * dy3) / den : 0, hh = den ? (dx1 * dy3 - dx3 * dy1) / den : 0;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0, dd = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  const sctx = src.getContext('2d', {willReadFrequently: true});
  const S = sctx.getImageData(0, 0, src.width, src.height), sp = S.data, SW = src.width, SH = src.height;
  const out = document.createElement('canvas'); out.width = W2; out.height = H2;
  const octx = out.getContext('2d'), O = octx.createImageData(W2, H2), op = O.data;
  for(let y = 0; y < H2; y++){
    const v = (y + 0.5) / H2;
    for(let x = 0; x < W2; x++){
      const u = (x + 0.5) / W2, z = g * u + hh * v + 1;
      let sx = (a * u + b * v + c) / z - 0.5, sy = (dd * u + e * v + f) / z - 0.5;
      if(sx < 0) sx = 0; else if(sx > SW - 1.001) sx = SW - 1.001;
      if(sy < 0) sy = 0; else if(sy > SH - 1.001) sy = SH - 1.001;
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy, i0 = (iy * SW + ix) * 4, i1 = i0 + SW * 4, o = (y * W2 + x) * 4;
      for(let ch = 0; ch < 3; ch++){
        const top = sp[i0 + ch] + (sp[i0 + 4 + ch] - sp[i0 + ch]) * fx, bot = sp[i1 + ch] + (sp[i1 + 4 + ch] - sp[i1 + ch]) * fx;
        op[o + ch] = top + (bot - top) * fy;
      }
      op[o + 3] = 255;
    }
  }
  octx.putImageData(O, 0, 0);
  return out;
}
// "Document" look: even out shadows (divide by the paper brightness around each spot), then white paper, dark ink.
function cleanPaper(cv){
  const w = cv.width, h = cv.height, ctx = cv.getContext('2d', {willReadFrequently: true});
  const img = ctx.getImageData(0, 0, w, h), p = img.data;
  const bs = 24, gw = Math.ceil(w / bs), gh = Math.ceil(h / bs), bg = new Float32Array(gw * gh);
  // brightest paper in each block (90th percentile of brightness), smoothed
  for(let gy = 0; gy < gh; gy++) for(let gx = 0; gx < gw; gx++){
    const hist = new Uint16Array(64); let n = 0;
    for(let y = gy * bs; y < Math.min(h, gy * bs + bs); y += 2) for(let x = gx * bs; x < Math.min(w, gx * bs + bs); x += 2){ const i = (y * w + x) * 4; hist[((p[i] * 77 + p[i + 1] * 150 + p[i + 2] * 29) >> 8) >> 2]++; n++; }
    let acc = 0, k = 63; for(; k > 0; k--){ acc += hist[k]; if(acc >= n * 0.1) break; }
    bg[gy * gw + gx] = Math.max(40, k * 4 + 2);
  }
  // spread the paper level across blocks that are mostly ink (max over neighbours), then blur
  const bg2 = new Float32Array(gw * gh);
  for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++){ let m = 0; for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){ const xx = x + dx, yy = y + dy; if(xx >= 0 && yy >= 0 && xx < gw && yy < gh) m = Math.max(m, bg[yy * gw + xx]); } bg2[y * gw + x] = m; }
  for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++){ let s = 0, n = 0; for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){ const xx = x + dx, yy = y + dy; if(xx >= 0 && yy >= 0 && xx < gw && yy < gh){ s += bg2[yy * gw + xx]; n++; } } bg[y * gw + x] = s / n; }
  for(let y = 0; y < h; y++){
    const fy = clamp((y + 0.5) / bs - 0.5, 0, gh - 1), y0 = fy | 0, y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for(let x = 0; x < w; x++){
      const fx = clamp((x + 0.5) / bs - 0.5, 0, gw - 1), x0 = fx | 0, x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const b = (bg[y0 * gw + x0] * (1 - tx) + bg[y0 * gw + x1] * tx) * (1 - ty) + (bg[y1 * gw + x0] * (1 - tx) + bg[y1 * gw + x1] * tx) * ty;
      const i = (y * w + x) * 4;
      for(let ch = 0; ch < 3; ch++){
        let v = p[i + ch] / b;                 // 1 = paper
        v = (v - 0.45) / 0.45;                 // stretch: paper white, ink dark
        v = v >= 1 ? 1 : v <= 0 ? 0 : v * v * (3 - 2 * v);
        p[i + ch] = v * 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
for(const id of ['scanFile', 'scanFiles']) $(id).addEventListener('change', async () => {
  const fs = [...$(id).files]; $(id).value = '';
  if(!fs.length) return;
  if(Scan.src && !$('scanSetup').hidden && id === 'scanFile' && Scan.retake){ Scan.retake = false; Scan.queue.unshift(fs[0]); await Scan.next(); return; }
  Scan.queue = fs; Scan.total = fs.length;
  await Scan.next();
});
$('scanBtn').addEventListener('click', () => { hideModal('importDlg'); if(!cur){ toast('Open a page first'); return; } Scan.reset(); showModal('scanDlg'); });
$('scanDone').addEventListener('click', () => { hideModal('scanDlg'); Scan.queue = []; });
$('scanAll').addEventListener('click', () => Scan.place('all'));
// Retake replaces the photo being edited (the rest of a chosen batch stays queued)
$('scanRetake').addEventListener('click', () => { Scan.retake = true; $('scanFile').click(); });
$('scanRot').addEventListener('click', () => Scan.rotate());
$('scanMode').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if(!b) return; Scan.mode = b.dataset.v; $('scanMode').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
$('scanGo').addEventListener('click', () => Scan.place(false));
$('scanNext').addEventListener('click', () => Scan.place(true));
$('scanView').querySelectorAll('.scan-h').forEach((hd, i) => {
  let drag = null;
  hd.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); drag = e.pointerId; try { hd.setPointerCapture(e.pointerId); } catch {} hd.classList.add('on'); });
  hd.addEventListener('pointermove', e => {
    if(drag !== e.pointerId || !Scan.src) return;
    const r = $('scanView').getBoundingClientRect(), f = Scan.fit();
    Scan.q[i] = [clamp((e.clientX - r.left - f.ox) / f.k, 0, Scan.src.width), clamp((e.clientY - r.top - f.oy) / f.k, 0, Scan.src.height)];
    Scan.draw();
  });
  const up = () => { drag = null; hd.classList.remove('on'); };
  hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
});
addEventListener('resize', () => { if(!$('scanDlg').hidden && Scan.src) Scan.draw(); });

/* =====================================================================
   Calculator (top bar button): a strip on the left, about a fifth of the screen. Opening it hides the
   notebooks/pages panel; closing it leaves the page full width. Scientific keys, DEG/RAD, Ans, history.
   The expression is kept as tokens (internal form) and shown with maths symbols.
   ===================================================================== */
const CALC_SHOW = {'*': '×', '/': '÷', '-': '−', 'pi': 'π', 'sqrt(': '√(', 'cbrt(': '∛(', 'asin(': 'sin⁻¹(', 'acos(': 'cos⁻¹(', 'atan(': 'tan⁻¹(', '^2': '²', 'E': '×10^', 'Ans': 'Ans', 'exp(': 'e^('};
const Calc = {
  toks: [], hist: [], ans: 0, inv: false, fresh: false,
  load(){
    const d = LSget('inkwell.calc', null);
    if(d){ this.hist = Array.isArray(d.hist) ? d.hist.slice(-30) : []; this.ans = isFinite(d.ans) ? d.ans : 0; }
  },
  save(){ LSset('inkwell.calc', {hist: this.hist.slice(-30), ans: this.ans}); },
  open(){
    $('calc').hidden = false; $('calcBtn').classList.add('on');
    if(width() !== 'narrow' && !prefs.focus){ prefs.focus = true; app.classList.add('focus'); }
    prefs.calc = true; savePrefs(); this.render();
  },
  close(){ $('calc').hidden = true; $('calcBtn').classList.remove('on'); prefs.calc = false; savePrefs(); },
  // a result reused in a new calculation is one token '#<number>'
  show(t){ return t[0] === '#' ? fmtCalc(+t.slice(1)) : CALC_SHOW[t] || t; },
  src(){ return this.toks.map(t => t[0] === '#' ? '(' + t.slice(1).replace(/e\+?/, 'E') + ')' : t).join(''); },
  key(k){
    const isOp = /^[+\-*/^]$/.test(k) || k === '^2' || k === '%' || k === '!' || k === 'E';
    if(this.fresh){ this.toks = isOp ? ['Ans'] : []; this.fresh = false; }
    if(k === 'AC'){ this.toks = []; }
    else if(k === 'del'){ this.toks.pop(); }
    else if(k === '='){ this.equals(); return; }
    else if(k === 'neg'){ this.toks.push('-'); }
    else this.toks.push(k);
    this.inv = false;
    this.render();
  },
  equals(){
    if(!this.toks.length) return;
    const src = this.src();
    try {
      const v = calcEval(src, this.ans, prefs.calcDeg !== false);
      if(!isFinite(v)) throw new Error(isNaN(v) ? 'Not defined' : 'Too big');
      const shown = this.toks.map(t => this.show(t)).join(''), open = (src.match(/\(/g) || []).length - (src.match(/\)/g) || []).length;
      this.hist.push({e: shown + ')'.repeat(Math.max(0, open)), v});
      if(this.hist.length > 30) this.hist.shift();
      this.ans = v; this.toks = ['#' + v]; this.fresh = true; this.save();
      this.render(true);
    } catch(e){ $('calcRes').textContent = e.message || 'Error'; $('calcRes').classList.add('err'); }
  },
  render(scroll){
    const disp = this.toks.map(t => this.show(t)).join('');
    $('calcExpr').textContent = disp || '0';
    $('calcExpr').classList.toggle('empty', !disp);
    const r = $('calcRes'); r.classList.remove('err');
    if(this.fresh || !this.toks.length){ r.textContent = ''; }
    else { try { const v = calcEval(this.src(), this.ans, prefs.calcDeg !== false); r.textContent = isFinite(v) ? '= ' + fmtCalc(v) : ''; } catch { r.textContent = ''; } }
    const h = $('calcHist');
    h.innerHTML = this.hist.map((x, i) => `<button class="ch-row" data-i="${i}" title="Use this result"><span class="ch-e">${esc(x.e)}</span><span class="ch-v">= ${esc(fmtCalc(x.v))}</span></button>`).join('');
    if(scroll !== false) h.scrollTop = h.scrollHeight;
    $('calcDeg').textContent = prefs.calcDeg === false ? 'RAD' : 'DEG';
    $('calc').classList.toggle('inv', this.inv);
    $('calcInv').classList.toggle('on', this.inv);
  }
};
// numbers: up to 10 significant digits, exponent form when very big or small
function fmtCalc(v){
  if(v === 0) return '0';
  const a = Math.abs(v);
  let s = a >= 1e12 || a < 1e-9 ? v.toExponential(8).replace(/\.?0+e/, 'e') : String(parseFloat(v.toPrecision(10)));
  return s.replace(/e\+?/, ' × 10^').replace(/^-/, '−');
}
{
  // keys: [label, inverse label, token, inverse token, class]
  const K = [
    ['inv', '', 'inv', '', 'fn'], ['sin', 'sin⁻¹', 'sin(', 'asin(', 'fn'], ['cos', 'cos⁻¹', 'cos(', 'acos(', 'fn'], ['tan', 'tan⁻¹', 'tan(', 'atan(', 'fn'], ['π', 'e', 'pi', 'e', 'fn'],
    ['ln', 'eˣ', 'ln(', 'exp(', 'fn'], ['log', '10ˣ', 'log(', '10^', 'fn'], ['√', '∛', 'sqrt(', 'cbrt(', 'fn'], ['x²', 'x!', '^2', '!', 'fn'], ['xʸ', '', '^', '', 'fn'],
    ['(', '', '(', '', 'op'], [')', '', ')', '', 'op'], ['Ans', '', 'Ans', '', 'op'], ['⌫', '', 'del', '', 'op'], ['AC', '', 'AC', '', 'op ac'],
    ['7', '', '7', '', 'num'], ['8', '', '8', '', 'num'], ['9', '', '9', '', 'num'], ['÷', '', '/', '', 'op'], ['EE', '', 'E', '', 'op'],
    ['4', '', '4', '', 'num'], ['5', '', '5', '', 'num'], ['6', '', '6', '', 'num'], ['×', '', '*', '', 'op'], ['%', '', '%', '', 'op'],
    ['1', '', '1', '', 'num'], ['2', '', '2', '', 'num'], ['3', '', '3', '', 'num'], ['−', '', '-', '', 'op'], ['=', '', '=', '', 'eq'],
    ['0', '', '0', '', 'num zero'], ['.', '', '.', '', 'num'], ['+', '', '+', '', 'op']
  ];
  $('calcKeys').innerHTML = K.map(([l, il, t, it, c]) => `<button class="ck ${c}" data-k="${esc(t)}"${it ? ` data-ik="${esc(it)}"` : ''}${t === 'inv' ? ' id="calcInv"' : ''}><span class="kl">${esc(l)}</span>${il ? `<span class="ki">${esc(il)}</span>` : ''}</button>`).join('');
  $('calcKeys').addEventListener('click', e => {
    const b = e.target.closest('.ck'); if(!b) return;
    let k = b.dataset.k;
    if(k === 'inv'){ Calc.inv = !Calc.inv; Calc.render(false); return; }
    if(Calc.inv && b.dataset.ik) k = b.dataset.ik;
    Calc.key(k);
  });
  $('calcHist').addEventListener('click', e => {
    const r = e.target.closest('.ch-row'); if(!r) return;
    const x = Calc.hist[+r.dataset.i]; if(!x) return;
    if(Calc.fresh){ Calc.toks = []; Calc.fresh = false; }
    Calc.toks.push('#' + x.v);
    Calc.render(false);
  });
  $('calcDeg').addEventListener('click', () => { prefs.calcDeg = prefs.calcDeg === false; savePrefs(); Calc.render(false); });
  $('calcClose').addEventListener('click', () => Calc.close());
  $('calcClear').addEventListener('click', () => { Calc.hist = []; Calc.save(); Calc.render(); });
  $('calcBtn').addEventListener('click', () => { if($('calc').hidden) Calc.open(); else Calc.close(); });
  // hardware keyboard while the calculator is open and nothing else is being typed into
  document.addEventListener('keydown', e => {
    if($('calc').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    const a = document.activeElement;
    if(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if(!$('settingsDlg').hidden || document.querySelector('.modal:not([hidden])')) return;
    const map = {'Enter': '=', '=': '=', 'Backspace': 'del', 'Delete': 'AC', 'Escape': 'AC', '*': '*', '/': '/', ':': '/', '+': '+', '-': '-', '^': '^', '(': '(', ')': ')', '.': '.', ',': '.', '%': '%', '!': '!'};
    if(sel && /^(Backspace|Delete|Escape)$/.test(e.key)) return;   // those still act on a lasso selection
    let k = /^[0-9]$/.test(e.key) ? e.key : map[e.key];
    if(!k) return;
    e.preventDefault(); e.stopImmediatePropagation();
    Calc.key(k);
  }, true);
  Calc.load();
}

/* =====================================================================
   Keyboard (hardware keyboard / PC)
   ===================================================================== */
document.addEventListener('keydown', e => {
  if(typeof e.key !== 'string') return;   // (1.67.3) some browsers send key events without a key (autofill)
  const ae = document.activeElement;
  // (1.60.2) the hidden paste catcher (focused for a moment after Ctrl/Cmd+V) is not a text field: a shortcut pressed
  // right after a paste (Ctrl+X, Ctrl+Z, Delete) was ignored while it held the focus
  if(ae && ae.id === 'pasteCatch' && !(e.key.toLowerCase() === 'v' && (e.metaKey || e.ctrlKey))) ae.blur();
  const typing = ae && ae.id !== 'pasteCatch' && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
  if(typing){ if(e.key === 'Escape' && editing) finishEditing(); return; }
  // (1.67.3) with a window open (Settings, export, …) the page's shortcuts are off: Backspace deleted the selected
  // things behind the window, a letter switched the tool, Ctrl+Z undid on the page
  if(e.key !== 'Escape' && document.querySelector('.modal:not([hidden])')) return;
  if(e.key === ' '){ spaceDown = true; e.preventDefault(); return; }
  if(e.metaKey || e.ctrlKey){
    const k = e.key.toLowerCase();
    if(k === 'z'){ e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if(k === 'y'){ e.preventDefault(); redo(); }
    else if(k === 'c' && sel){ e.preventDefault(); Clip.copy(); }
    else if(k === 'x' && sel){ e.preventDefault(); Clip.copy(); const ids = sel ? sel.ids.slice() : []; clearSel(); removeItems(ids); }
    else if(k === 'v'){
      // (1.53.1) iPad Safari only sends a paste event to a focused text field: focus a hidden one so Cmd+V lands there
      const c = $('pasteCatch'); c.value = ''; try { c.focus({preventScroll: true}); } catch {}
      const t0 = Date.now(); setTimeout(() => { if(document.activeElement === c) c.blur(); if(Paste.got < t0) Paste.read(); }, 150);
    }
    return;
  }
  if(e.altKey) return;
  const map = {p: 'pen', h: 'hl', k: 'mark', e: 'eraser', l: 'lasso', t: 'text', m: 'math', s: 'space'};
  const t = map[e.key.toLowerCase()];
  if(t){ setTool(t); return; }
  if((e.key === 'Delete' || e.key === 'Backspace') && sel){ const ids = sel.ids.slice(); clearSel(); removeItems(ids); return; }
  if(e.key === 'Escape'){ closeWheel(); clearSel(); closePops(); if(pick){ endPick(); toast('Cancelled'); } }
});
document.addEventListener('keyup', e => { if(e.key === ' ') spaceDown = false; });
// (1.67.3) the Space key released while another window or app had the focus never sent keyup: the mouse kept panning
addEventListener('blur', () => { spaceDown = false; });
