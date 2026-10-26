/* Inkwell app: Answer lines on imported pages (typed text snaps onto them).
   (1.64.1) split out of app/06-writing.js. All app/ files share one global scope and are run in order by app.js;
   code that runs while a file loads must not use a later file (tests/unit/load_order.test.js). */
'use strict';
/* ---------- Answer lines on imported pages (typed text snaps onto them) ----------
   Found by scanning the page image for long thin horizontal lines; works for PDFs and pictures,
   old imports included. Cached per image; nothing is stored. */
const lineCache = new Map(), lineReady = new Map();   // asset id -> Promise / lines [{y, x1, x2}] as page fractions
let lineQ = Promise.resolve();
function pageLines(aId){
  let p = lineCache.get(aId);
  if(!p){
    // one page at a time: each scan decodes a full page picture
    const run = lineQ.then(() => detectLines(aId));
    lineQ = run.catch(() => {});
    p = run.catch(e => { console.warn(e); return null; }).then(r => {
      if(r) lineReady.set(aId, r); else lineCache.delete(aId);
      return r || [];
    });
    lineCache.set(aId, p);
  }
  return p;
}
async function detectLines(aId){
  const u = await assetURL(aId); if(!u) return null;
  const img = new Image(); img.src = u; await img.decode();
  const W0 = img.naturalWidth, H0 = img.naturalHeight; if(!W0 || !H0) return null;
  const sc = Math.min(1, 1400 / W0), w = Math.max(1, Math.round(W0 * sc)), h = Math.max(1, Math.round(H0 * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', {willReadFrequently: true});
  // (1.58.8) averaged scaling: the plain one can skip a thin line almost completely when the page is made smaller
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data; c.width = c.height = 1;
  const lum = new Uint8Array(w * h), hist = new Uint32Array(256);
  for(let i = 0; i < w * h; i++){ const l = (px[4 * i] * 77 + px[4 * i + 1] * 150 + px[4 * i + 2] * 29) >> 8; lum[i] = l; hist[l]++; }
  let bg = 0; for(let acc = 0; bg < 255 && (acc += hist[bg]) < w * h / 2; bg++);   // median = paper colour (light or dark)
  const ink = new Uint8Array(w * h); for(let i = 0; i < w * h; i++) ink[i] = Math.abs(lum[i] - bg) > 60 ? 1 : 0;
  const gap = Math.max(2, Math.round(w * 0.004)), minLen = w * 0.1;
  // (1.58.8) pale answer lines (light grey, 1-2 px): scaling the page down can nearly wipe them out, so the page is
  // read again in strips at its full height (only made narrower) with a much lower contrast, keeping only long and
  // almost unbroken rows, which text rows and letters never are; found rows are mapped onto the smaller page
  const fsegs = [];
  {
    const SH = 160, sv = document.createElement('canvas'); sv.width = w; sv.height = SH;
    const g = sv.getContext('2d', {willReadFrequently: true});
    const need = Math.max(minLen, w * 0.2);
    for(let y0 = 0; y0 < H0; y0 += SH){
      const n = Math.min(SH, H0 - y0);
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, SH);
      g.drawImage(img, 0, y0, W0, n, 0, 0, w, n);
      const d = g.getImageData(0, 0, w, n).data;
      for(let r = 0; r < n; r++){
        let fs = -1, fl = -1, fn = 0;
        const fflush = () => { if(fs >= 0 && fl - fs + 1 >= need && fn / (fl - fs + 1) >= 0.97) fsegs.push({y: Math.min(h - 1, Math.floor((y0 + r) * sc)), x1: fs, x2: fl, f: 1}); };
        for(let x = 0; x < w; x++){
          const i = 4 * (r * w + x), l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
          if(Math.abs(l - bg) > 12){ if(fs < 0 || x - fl > 2){ fflush(); fs = x; fn = 0; } fl = x; fn++; }
        }
        fflush();
      }
    }
    sv.width = sv.height = 1;
  }
  // dotted and dashed lines: a row of short marks with regular gaps
  const maxMark = Math.max(4, w * 0.045), maxGapD = Math.max(6, w * 0.03);
  const segs = [];
  for(let y = 0; y < h; y++){
    const row = y * w; let s = -1, last = -1, n = 0;
    const flush = () => { if(s >= 0 && last - s + 1 >= minLen && n / (last - s + 1) >= 0.6) segs.push({y, x1: s, x2: last}); };
    const runs = []; let rs = -1;
    for(let x = 0; x < w; x++){
      if(ink[row + x]){ if(s < 0 || x - last > gap){ flush(); s = x; n = 0; } last = x; n++; if(rs < 0) rs = x; }
      else if(rs >= 0){ runs.push(rs, x - 1); rs = -1; }
    }
    if(rs >= 0) runs.push(rs, w - 1);
    flush();

    // short marks with small gaps form a chain; letters on the same baseline (e.g. "the 1........") join it too,
    // so the chain is cut wherever the spacing or mark size jumps, and each evenly spaced part is judged alone (1.43)
    const parts = [];
    for(let i = 0; i < runs.length;){
      let j = i;
      while(j + 2 < runs.length && runs[j + 1] - runs[j] + 1 <= maxMark && runs[j + 3] - runs[j + 2] + 1 <= maxMark && runs[j + 2] - runs[j + 1] - 1 <= maxGapD) j += 2;
      let a = i;
      for(let k = i + 2; k <= j; k += 2){
        const p0 = k - 2 > a ? runs[k - 2] - runs[k - 4] : -1, p1 = runs[k] - runs[k - 2];
        const l0 = runs[k - 1] - runs[k - 2] + 1, l1 = runs[k + 1] - runs[k] + 1;
        if((p0 >= 0 && Math.abs(p1 - p0) > Math.max(2, 0.3 * p0)) || Math.abs(l1 - l0) > Math.max(2, 0.5 * Math.max(l0, l1))){ parts.push(a, k - 2); a = k; }
      }
      parts.push(a, j);
      i = j + 2;
    }
    for(let q = 0; q < parts.length; q += 2){
      let i = parts[q], j = parts[q + 1];
      if(j - i >= 6){   // drop an end mark whose spacing is off (the digit or letter right before the dots)
        const ps = []; for(let k = i + 2; k <= j; k += 2) ps.push(runs[k] - runs[k - 2]);
        const pm = ps.slice().sort((x, y) => x - y)[ps.length >> 1];
        if(Math.abs(runs[i + 2] - runs[i] - pm) > 1) i += 2;
        if(Math.abs(runs[j] - runs[j - 2] - pm) > 1) j -= 2;
      }
      const cnt = (j - i) / 2 + 1, x1 = runs[i], x2 = runs[j + 1];
      if(cnt >= 6 && x2 - x1 + 1 >= minLen){
        let on = 0; const gaps = [], lens = [];
        for(let k = i; k <= j; k += 2){ lens.push(runs[k + 1] - runs[k] + 1); on += lens[lens.length - 1]; if(k > i) gaps.push(runs[k] - runs[k - 1] - 1); }
        const cv = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return [m, Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length)]; };
        const [gm, gs] = cv(gaps), [lm, ls] = cv(lens);
        const fill = on / (x2 - x1 + 1);
        // evenly spaced marks of about the same size; letters in a text row never are
        if(gs <= 0.35 * gm + 1 && ls <= 0.35 * lm + 1 && fill >= 0.12 && fill < 0.95) segs.push({y, x1, x2, d: 1});
      }
    }
  }
  // pale lines found on the full-height strips: skip rows already found, then keep everything in row order
  const strong = segs.filter(g => !g.d);
  for(const f of fsegs) if(!strong.some(g => Math.abs(g.y - f.y) <= 1 && g.x1 <= f.x1 + 2 && g.x2 >= f.x2 - 2)) segs.push(f);
  segs.sort((a, b) => a.y - b.y);
  // join touching rows into lines; keep only thin ones with clear paper above and below (not text, not filled boxes)
  const bands = [];
  for(const g of segs){
    const b = bands.find(b => g.y - b.y2 <= 1 && Math.min(b.x2, g.x2) - Math.max(b.x1, g.x1) > 0.5 * Math.min(b.x2 - b.x1, g.x2 - g.x1));
    if(b){ b.y2 = g.y; b.x1 = Math.min(b.x1, g.x1); b.x2 = Math.max(b.x2, g.x2); if(!g.d) b.d = 0; } else bands.push({y1: g.y, y2: g.y, x1: g.x1, x2: g.x2, d: g.d ? 1 : 0});
  }
  const clear = (y, x1, x2, lim = 0.3) => { if(y < 0 || y >= h) return true; let n = 0; for(let x = x1; x <= x2; x++) n += ink[y * w + x]; return n / (x2 - x1 + 1) < lim; };
  const maxT = Math.max(3, Math.round(Math.max(w, h) * 0.0065)), out = [];   // thickest line that still counts as a line
  for(const b of bands){
    if(b.y2 - b.y1 + 1 > maxT) continue;
    if(!clear(b.y1 - 3, b.x1, b.x2) || !clear(b.y2 + 3, b.x1, b.x2)) continue;
    // a dotted/dashed line needs empty paper just above and below it (text around it has letters there)
    // (1.43) the digit or letter right before the dots and the comma after them are cut off: the line is the longest
    // stretch with nothing above or below, shrunk to the dots inside it
    let x1 = b.x1, x2 = b.x2;
    if(b.d){
      const m = Math.max(4, Math.round(h * 0.003));
      const hit = x => { for(let k = 2; k <= m; k++){ const ya = b.y1 - k, yb = b.y2 + k; if((ya >= 0 && ink[ya * w + x]) || (yb < h && ink[yb * w + x])) return true; } return false; };
      let bs = -1, be = -2;
      for(let x = b.x1, s = -1; x <= b.x2 + 1; x++){
        if(x <= b.x2 && !hit(x)){ if(s < 0) s = x; }
        else if(s >= 0){ if(x - 1 - s > be - bs) bs = s, be = x - 1; s = -1; }
      }
      if(bs < 0) continue;
      const col = x => { for(let y = b.y1; y <= b.y2; y++) if(ink[y * w + x]) return true; return false; };
      while(bs < be && !col(bs)) bs++;
      while(be > bs && !col(be)) be--;
      if(be - bs + 1 < minLen) continue;
      x1 = bs; x2 = be;
    }
    out.push({y: (b.y1 + b.y2 + 1) / 2 / h, x1: x1 / w, x2: (x2 + 1) / w, _b: b, _x1: x1, _x2: x2});
    if(b.d){ out[out.length - 1].d = 1; out[out.length - 1].yb = (b.y2 + 1) / h; }   // dots sit on the text baseline
  }
  // (1.43) size of the printed text: rows of ink (without the solid lines) form text rows; a row's height from the
  // tops of tall letters to the bottoms of g/p/y is about 0.95 of the font size. Each line gets the size of the text
  // on it or just above it (fs, page fraction); out.fs0 = the page's usual text size
  const prof = new Int32Array(h);
  for(let y = 0; y < h; y++){ let n = 0; const r = y * w; for(let x = 0; x < w; x++) n += ink[r + x]; prof[y] = n; }
  for(const l of out) if(!l._b.d) for(let y = l._b.y1; y <= l._b.y2; y++){ const r = y * w; for(let x = l._x1; x <= l._x2; x++) prof[y] -= ink[r + x]; }
  // a frame or a dark page edge puts the same few ink pixels in every row: count only what is above that
  const pb = Array.from(prof).sort((x, y) => x - y)[Math.floor(h * 0.2)] || 0, rows = [];
  for(let y = 0, s = -1; y <= h; y++){
    if(y < h && prof[y] >= pb + 2){ if(s < 0) s = y; }
    else if(s >= 0){ if(y - s >= 4 && y - s <= h * 0.08) rows.push({y1: s, y2: y - 1, hh: y - s}); s = -1; }
  }
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
  const m0 = med(rows.map(r => r.hh)), txt = rows.filter(r => r.hh >= 0.5 * m0 && r.hh <= 1.8 * m0);
  const m1 = med(txt.map(r => r.hh));
  if(txt.length >= 3 && m1 >= 6) out.fs0 = m1 / 0.95 / h;
  for(const l of out){
    const yc = (l._b.y1 + l._b.y2) / 2;
    let r = txt.find(r => r.y1 <= yc && r.y2 >= yc);
    if(!r){ const up = txt.filter(r => r.y2 < yc && yc - r.y2 <= 3 * (m1 || 20)); r = up[up.length - 1]; }
    // a row without g/p/y (or without tall letters) measures smaller than its font, so the page's usual size is used
    // unless the row is clearly bigger (a heading-size line)
    const rf = r ? r.hh / 0.95 / h : 0;
    if(out.fs0) l.fs = rf > 1.3 * out.fs0 ? rf : out.fs0; else if(rf) l.fs = rf;
    delete l._b; delete l._x1; delete l._x2;
  }
  out.sort((a, b) => a.y - b.y);
  // table borders (since 1.29): thin solid vertical lines, for snapping text into table cells
  const vmin = Math.max(14, Math.round(h * 0.009)), vgap = Math.max(2, Math.round(h * 0.002)), vsegs = [];
  for(let x = 0; x < w; x++){
    let s = -1, last = -1, n = 0;
    const flush = () => { if(s >= 0 && last - s + 1 >= vmin && n / (last - s + 1) >= 0.85) vsegs.push({x, y1: s, y2: last}); };
    for(let y = 0; y < h; y++){
      if(ink[y * w + x]){ if(s < 0 || y - last > vgap){ flush(); s = y; n = 0; } last = y; n++; }
    }
    flush();
  }
  const vb = [];
  for(const g of vsegs){
    const b = vb.find(b => g.x - b.x2 <= 1 && Math.min(b.y2, g.y2) - Math.max(b.y1, g.y1) > 0.5 * Math.min(b.y2 - b.y1, g.y2 - g.y1));
    if(b){ b.x2 = g.x; b.y1 = Math.min(b.y1, g.y1); b.y2 = Math.max(b.y2, g.y2); } else vb.push({x1: g.x, x2: g.x, y1: g.y1, y2: g.y2});
  }
  const vclear = (x, y1, y2) => { if(x < 0 || x >= w) return true; let n = 0; for(let y = y1; y <= y2; y++) n += ink[y * w + x]; return n / (y2 - y1 + 1) < 0.3; };
  out.v = vb.filter(b => b.x2 - b.x1 + 1 <= maxT && vclear(b.x1 - 3, b.y1, b.y2) && vclear(b.x2 + 3, b.y1, b.y2))
    .map(b => ({x: (b.x1 + b.x2 + 1) / 2 / w, y1: b.y1 / h, y2: (b.y2 + 1) / h}));
  return out;
}
// The table cell (four border lines around it) at world point (wx, wy) on an imported page, or null.
function snapCellAt(wx, wy){
  if(!cur) return null;
  const imgs = [...cur.items.values()].filter(it => it.t === 'i' && wx >= it.x && wx <= it.x + it.w && wy >= it.y && wy <= it.y + it.h);
  for(const it of imgs.reverse()){
    const fr = lineReady.get(it.a);
    if(!fr){ pageLines(it.a); continue; }
    if(!fr.v || !fr.v.length) continue;
    const tol = 4;
    const H = fr.map(l => ({y: it.y + l.y * it.h, x1: it.x + l.x1 * it.w, x2: it.x + l.x2 * it.w})).filter(l => wx >= l.x1 - tol && wx <= l.x2 + tol);
    const top = H.filter(l => l.y <= wy).sort((a, b) => b.y - a.y)[0], bot = H.filter(l => l.y > wy).sort((a, b) => a.y - b.y)[0];
    if(!top || !bot) continue;
    const V = fr.v.map(l => ({x: it.x + l.x * it.w, y1: it.y + l.y1 * it.h, y2: it.y + l.y2 * it.h})).filter(l => l.y1 <= top.y + tol && l.y2 >= bot.y - tol);
    const left = V.filter(l => l.x <= wx).sort((a, b) => b.x - a.x)[0], right = V.filter(l => l.x > wx).sort((a, b) => a.x - b.x)[0];
    if(!left || !right) continue;
    const ch = bot.y - top.y, cw = right.x - left.x;
    if(ch < 8 || ch > 200 || cw < 16) continue;
    if(top.x1 > left.x + tol || top.x2 < right.x - tol || bot.x1 > left.x + tol || bot.x2 < right.x - tol) continue;
    return {x1: left.x, x2: right.x, y1: top.y, y2: bot.y};
  }
  return null;
}
// Text in a table cell shrinks (and wraps onto up to 3 lines) so it always fits inside the cell.
function fitCell(id){
  const it = cur && cur.items.get(id), el = elMap.get(id);
  if(!it || !it.ch || !el) return;
  const ch = it.ch, F0 = (it.fs0 || it.fs) * 17;
  let best = null;
  // one line filling the cell (a short answer), as before
  for(let F = Math.min(F0, ch * 0.82); F >= Math.min(F0, ch * 0.82) * 0.75 && F >= 6; F *= 0.92){
    el.style.fontSize = F + 'px'; el.style.lineHeight = ch + 'px';
    if(el.scrollHeight <= ch + 4.5){ best = {fs: F / 17, lh: ch}; break; }
  }
  // (1.44.1) more text (e.g. several pasted lines): normal line spacing, shrinking only down to a readable size;
  // if it still does not fit, the box runs past the cell instead of turning tiny (before: 6 px letters, 3 huge lines)
  if(!best){
    const floor = Math.max(7, F0 * 0.6);
    for(let F = Math.min(F0, ch * 0.82); ; F *= 0.92){
      if(F < floor) F = floor;
      const lh = Math.round(F * 1.3 * 100) / 100;
      el.style.fontSize = F + 'px'; el.style.lineHeight = lh + 'px';
      if(el.scrollHeight <= ch + 4.5 || F <= floor){ best = {fs: F / 17, lh}; break; }
    }
  }
  const r = n => Math.round(n * 1000) / 1000;
  if(r(best.fs) !== r(it.fs) || r(best.lh) !== r(it.lh || 0)) cur.items.set(id, Object.assign({}, it, {fs: r(best.fs), lh: r(best.lh)}));
}
// The answer line to write on for a tap/click at world point (wx, wy), or null.
function snapLineAt(wx, wy){
  if(!cur) return null;
  const imgs = [...cur.items.values()].filter(it => it.t === 'i' && wx >= it.x && wx <= it.x + it.w && wy >= it.y - 20 && wy <= it.y + it.h);
  for(const it of imgs.reverse()){
    const fr = lineReady.get(it.a);
    if(!fr){ pageLines(it.a); continue; }
    // world coordinates; skip the edges of fillable field boxes
    const ls = fr.map(l => ({y: it.y + l.y * it.h, x1: it.x + l.x1 * it.w, x2: it.x + l.x2 * it.w, f: l.fs ? l.fs * it.h : 0, yb: l.d ? it.y + l.yb * it.h : 0}))
      .filter(l => !(it.f || []).some(f => { const fx1 = it.x + f.x * it.w, fx2 = fx1 + f.w * it.w, fy1 = it.y + f.y * it.h, fy2 = fy1 + f.h * it.h;
        return Math.min(l.x2, fx2) - Math.max(l.x1, fx1) > 0 && (Math.abs(l.y - fy1) < 4 || Math.abs(l.y - fy2) < 4); }));
    const near = ls.filter(l => wx >= l.x1 - 24 && wx <= l.x2 + 24 && l.y >= wy - 10);
    if(!near.length) continue;
    const c = near[0], i = ls.indexOf(c), tol = it.w * 0.03;
    const same = (a, b) => Math.abs(a.x1 - b.x1) < tol && Math.abs(a.x2 - b.x2) < tol;
    let d = 0;
    const nx = ls[i + 1], pv = ls[i - 1];
    if(nx && same(c, nx) && nx.y - c.y > 8 && nx.y - c.y < 90) d = nx.y - c.y;
    else if(pv && same(c, pv) && c.y - pv.y > 8 && c.y - pv.y < 90) d = c.y - pv.y;
    const dd = d || 30;
    if(c.y - wy > Math.max(dd * 1.3, 26)) continue;   // too far above the line (e.g. on the question text)
    return {x1: c.x1, x2: c.x2, y: c.y, d: dd, rep: !!d, f: c.f, yb: c.yb};
  }
  return null;
}
// Font size (world px) of the printed text on the imported page at (wx, wy), or 0 if not known (yet).
function pageTextAt(wx, wy){
  if(!cur) return 0;
  const imgs = [...cur.items.values()].filter(it => it.t === 'i' && wx >= it.x && wx <= it.x + it.w && wy >= it.y && wy <= it.y + it.h);
  for(const it of imgs.reverse()){
    const fr = lineReady.get(it.a);
    if(!fr){ pageLines(it.a); continue; }
    if(fr.fs0) return fr.fs0 * it.h;
  }
  return 0;
}
// distance from the top of the first line to the text baseline, for font size F and line height lh
function baselineOf(F, lh){
  const p = document.createElement('div');
  p.className = 'it it-text lh';
  p.style.cssText = `visibility:hidden;left:0;top:0;width:300px;padding:0;font-size:${F}px;line-height:${lh}px`;
  p.innerHTML = '<p>Xg<span style="display:inline-block;width:0;height:0"></span></p>';
  worldFront.appendChild(p);
  const b = p.querySelector('span').offsetTop;
  p.remove();
  return b;
}
