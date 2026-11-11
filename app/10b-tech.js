/* Inkwell app, part 10b: Technical notebooks (2.0, for Rafael's robotics drawings).
   A notebook marked "Technical" (notebook data.tech = true; pages anywhere else are untouched) adds:
   - line types for the pen and the shapes: thick, thin, hidden (dashed), centre (dash-dot), or the normal pen (prefs.techLs)
   - snapping for shapes and held (straightened) lines: onto the ends and middles of other lines, corners and centres of
     rectangles and circles, and onto a mm grid (prefs.techSnap: 0 = off, 1, 2, 5 or 10 mm)
   - the length and angle (lines), width × height (rectangles) or diameter (circles) next to the pen while drawing
   Strokes made here remember their exact shape in it.geo, which later stages (dimensions, typing exact sizes) use:
     {k: 'l', v: [x0, y0, x1, y1]} line, {k: 'r', v: [L, T, R, B]} rectangle, {k: 'e', v: [cx, cy, rx, ry]} ellipse.
   geoOf() only trusts it while the points still fit (an eraser cut or an older app version moving the stroke drops it). */
'use strict';
const TECH_LS = {
  f: {name: 'Pen', sub: 'Normal pen, pressure as you write'},
  k: {name: 'Thick', sub: 'Visible edges, 0.7 mm', mm: 0.7},
  n: {name: 'Thin', sub: 'Sizes and helper lines, 0.35 mm', mm: 0.35},
  h: {name: 'Hidden', sub: 'Edges you can\'t see, dashed', mm: 0.35},
  c: {name: 'Centre', sub: 'Middle of holes, shafts, wheels', mm: 0.35}
};
const TECH_STEPS = [0, 1, 2, 5, 10];
const Tech = {
  // is the open page (or this page doc) in a technical notebook?
  on(page){
    const p = page || (cur && getDoc(cur.id)); if(!p || !p.data) return false;
    const s = getDoc(p.data.sec), nb = s && getDoc(s.data.nb);
    return !!(nb && nb.data.tech);
  },
  ls(){ const v = prefs.techLs; return TECH_LS[v] && v !== 'f' ? v : null; },
  // the line type and width a new pen stroke or shape gets here (null: normal pen)
  style(){ if(!this.on()) return null; const ls = this.ls(); return ls ? {ls, w: TECH_LS[ls].mm * MM} : null; },
  step(){ const v = +prefs.techSnap; return TECH_STEPS.includes(v) ? v : 0; },

  /* ---------- exact shapes ---------- */
  geoOf(it){
    const g = it && it.geo; if(!g || !Array.isArray(g.v) || it.t !== 's' || !it.p || it.p.length < 6) return null;
    const p = it.p, n = p.length, near = (a, b) => Math.abs(a - b) < 0.75;
    if(g.k === 'l') return near(p[0], g.v[0]) && near(p[1], g.v[1]) && near(p[n-3], g.v[2]) && near(p[n-2], g.v[3]) ? g : null;
    const b = strokeBox(Object.assign({}, it, {w: 0}));   // points' own box (+1 margin)
    if(g.k === 'r') return near(b[0] + 1, g.v[0]) && near(b[1] + 1, g.v[1]) && near(b[2] - 1, g.v[2]) && near(b[3] - 1, g.v[3]) ? g : null;
    if(g.k === 'e') return near(b[0] + 1, g.v[0] - g.v[2]) && near(b[2] - 1, g.v[0] + g.v[2]) && near(b[1] + 1, g.v[1] - g.v[3]) && near(b[3] - 1, g.v[1] + g.v[3]) ? g : null;
    return null;
  },
  // moved / resized with the selection (rotation: a line turns with it, a rectangle or ellipse is no longer axis-aligned)
  moveGeo(o, it, m, s){
    const g = it.geo; if(!g) return;
    if(g.k === 'l'){ const a = m(g.v[0], g.v[1]), b = m(g.v[2], g.v[3]); o.geo = {k: 'l', v: [a[0], a[1], b[0], b[1]]}; }
    else if(g.k === 'r'){ const a = m(g.v[0], g.v[1]), b = m(g.v[2], g.v[3]); o.geo = {k: 'r', v: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]}; }
    else if(g.k === 'e'){ const c = m(g.v[0], g.v[1]); o.geo = {k: 'e', v: [c[0], c[1], g.v[2] * Math.abs(s), g.v[3] * Math.abs(s)]}; }
  },
  turnGeo(o, it, rot){
    const g = it.geo; if(!g) return;
    if(g.k === 'l'){ const a = rot(g.v[0], g.v[1]), b = rot(g.v[2], g.v[3]); o.geo = {k: 'l', v: [a[0], a[1], b[0], b[1]]}; }
    else delete o.geo;
  },
  // points that other lines can snap onto: ends of strokes; middles, corners and centres of exact shapes
  targets(x, y, r, skip){
    const out = [];
    if(!cur) return out;
    for(const it of cur.items.values()){
      if(it.t !== 's' || it.hl || it.mk || (skip && skip.has(it.id))) continue;
      const b = geoBox(it); if(x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
      const g = this.geoOf(it), p = it.p, n = p.length;
      if(g && g.k === 'l'){ const v = g.v; out.push([v[0], v[1], 'end'], [v[2], v[3], 'end'], [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2, 'middle']); }
      else if(g && g.k === 'r'){ const [L, T, R, B] = g.v; out.push([L, T, 'corner'], [R, T, 'corner'], [R, B, 'corner'], [L, B, 'corner'], [(L + R) / 2, T, 'middle'], [R, (T + B) / 2, 'middle'], [(L + R) / 2, B, 'middle'], [L, (T + B) / 2, 'middle'], [(L + R) / 2, (T + B) / 2, 'centre']); }
      else if(g && g.k === 'e'){ const [cx, cy, rx, ry] = g.v; out.push([cx, cy, 'centre'], [cx + rx, cy, 'edge'], [cx - rx, cy, 'edge'], [cx, cy + ry, 'edge'], [cx, cy - ry, 'edge']); }
      else if(!it.fl){ out.push([p[0], p[1], 'end']); if(Math.hypot(p[n-3] - p[0], p[n-2] - p[1]) > 1) out.push([p[n-3], p[n-2], 'end']); }
    }
    return out;
  },
  // nearest snap target within reach (screen px), or null
  target(x, y, skip){
    const r = 14 / cam.z; let best = null, bd = r;
    for(const t of this.targets(x, y, r, skip)){ const d = Math.hypot(t[0] - x, t[1] - y); if(d < bd){ bd = d; best = t; } }
    return best;
  },
  // a point snapped onto a target, else onto the mm grid; {p, why} (why: 'end', 'middle', ..., 'grid' or '')
  snap(x, y, skip){
    if(!this.on()) return {p: [x, y], why: ''};
    const t = this.target(x, y, skip); if(t) return {p: [t[0], t[1]], why: t[2]};
    const s = this.step() * MM; if(!s) return {p: [x, y], why: ''};
    return {p: [Math.round(x / s) * s, Math.round(y / s) * s], why: 'grid'};
  },
  // a line's end while dragging: an end point nearby wins; otherwise the length goes to whole grid steps (angle kept)
  lineEnd(a, b, skip){
    if(!this.on()) return b;
    const t = this.target(b[0], b[1], skip); if(t){ this.why = t[2]; return [t[0], t[1]]; }
    this.why = '';
    const s = this.step() * MM, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if(!s || len < 1e-6) return b;
    const k = Math.max(s, Math.round(len / s) * s) / len;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  },
  // the geo of a shape from the shapes menu (as built by shapePolys)
  shapeGeo(shape, polys){
    if(!polys.length) return null;
    const V = polys[0][0];
    if(['line', 'arrow', 'darrow'].includes(shape) && V.length === 2) return {k: 'l', v: [V[0][0], V[0][1], V[1][0], V[1][1]]};
    if(shape === 'rect' && V.length === 4) return {k: 'r', v: [V[0][0], V[0][1], V[2][0], V[2][1]]};
    if(shape === 'ellipse' || shape === 'compass' && polys[0][1]){
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for(const q of V){ x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
      return {k: 'e', v: [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2]};
    }
    return null;
  },
  // the geo of a held stroke that became a shape (recognize() result)
  heldGeo(s){
    if(s.kind === 'line') return {k: 'l', v: [s.pts[0][0], s.pts[0][1], s.pts[1][0], s.pts[1][1]]};
    if(s.kind === 'rect') return {k: 'r', v: [s.pts[0][0], s.pts[0][1], s.pts[2][0], s.pts[2][1]]};
    if(s.kind === 'ellipse'){ const g = this.shapeGeo('ellipse', [[s.pts, true]]); return g; }
    return null;
  },
  // a held stroke that became a shape: corners onto targets / grid (rectangle stays square to the page)
  snapHeld(s, skip){
    if(!this.on()) return s;
    if(s.kind === 'rect'){
      const a = this.snap(s.pts[0][0], s.pts[0][1], skip).p, b = this.snap(s.pts[2][0], s.pts[2][1], skip).p;
      return Object.assign({}, s, {pts: [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]});
    }
    if(s.kind === 'ellipse') return s;
    return Object.assign({}, s, {pts: s.pts.map(q => this.snap(q[0], q[1], skip).p)});
  },

  /* ---------- sizes shown while drawing ---------- */
  num(v){ const r = Math.round(v * 10) / 10; return (Math.abs(r - Math.round(r)) < 0.05 ? String(Math.round(r)) : r.toFixed(1)); },
  lineText(a, b){
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) / MM;
    let deg = -Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; if(deg < 0) deg += 360; if(Math.round(deg) === 360) deg = 0;
    return this.num(len) + ' mm · ' + Math.round(deg) + '°';
  },
  boxText(g){
    if(g.k === 'r') return this.num((g.v[2] - g.v[0]) / MM) + ' × ' + this.num((g.v[3] - g.v[1]) / MM) + ' mm';
    if(g.k === 'e') return Math.abs(g.v[2] - g.v[3]) < 0.5 ? '⌀ ' + this.num(2 * g.v[2] / MM) + ' mm' : this.num(2 * g.v[2] / MM) + ' × ' + this.num(2 * g.v[3] / MM) + ' mm';
    if(g.k === 'l') return this.lineText([g.v[0], g.v[1]], [g.v[2], g.v[3]]);
    return '';
  },
  // label next to the pen (world point), on the live layer, with what it snapped to
  label(txt, wx, wy, why){
    if(!txt) return;
    liveCtx.save();
    liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = wx * cam.z + cam.ox, sy = wy * cam.z + cam.oy, full = why && why !== 'grid' ? txt + '  ·  ' + why : txt;
    liveCtx.font = '600 13px system-ui, sans-serif';
    const tw = liveCtx.measureText(full).width;
    const lx = clamp(sx + 22, 8, W - tw - 20), ly = clamp(sy - 34, 8, H - 30);
    liveCtx.fillStyle = tokens.accent; liveCtx.beginPath();
    if(liveCtx.roundRect) liveCtx.roundRect(lx, ly, tw + 14, 22, 6); else liveCtx.rect(lx, ly, tw + 14, 22);
    liveCtx.fill();
    liveCtx.fillStyle = '#fff'; liveCtx.fillText(full, lx + 7, ly + 15.5);
    if(why && why !== 'grid'){
      // ring on the point it snapped to
      liveCtx.strokeStyle = tokens.accent; liveCtx.lineWidth = 2; liveCtx.beginPath(); liveCtx.arc(sx, sy, 7, 0, Math.PI * 2); liveCtx.stroke();
    }
    liveCtx.restore();
  },
  // live label for a stroke being drawn (held and turned into a shape)
  liveStroke(a){
    if(!this.on() || !a.snapped || a.hl) return;
    const P = a.pts, n = P.length;
    if(a.snapped === 'line') this.label(this.lineText([P[0], P[1]], [P[n-3], P[n-2]]), P[n-3], P[n-2], this.why);
    else if(a.snapGeo) this.label(this.boxText(a.snapGeo), a.snapGeo.v[2], a.snapGeo.v[a.snapGeo.k === 'e' ? 1 : 3], '');
  },
  // live label for a shape from the shapes menu being dragged out
  livePick(shape, b, polys){
    if(!this.on() || b.tap) return;
    const g = this.shapeGeo(shape, polys);
    if(g) this.label(this.boxText(g), b.x1, b.y1, this.pickWhy || '');
  },

  /* ---------- toolbar: line type and snap ---------- */
  icon(ls){
    const d = {f: '<path d="M4 15c3-5 6 3 9-2s5-3 7-4" stroke-width="2"/>', k: '<path d="M4 12h16" stroke-width="3.4"/>', n: '<path d="M4 12h16" stroke-width="1.4"/>',
      h: '<path d="M3 12h4M10 12h4M17 12h4" stroke-width="1.8"/>', c: '<path d="M2 12h7M11.5 12h1M15 12h7" stroke-width="1.6"/>'}[ls] || '';
    return `<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-linecap:round">${d}</svg>`;
  },
  render(){
    const show = this.on() && (prefs.tool === 'pen');
    const b = $('techBtn'); if(!b) return;
    b.hidden = !show;
    if(!show) return;
    const ls = TECH_LS[prefs.techLs] ? prefs.techLs : 'f';
    b.innerHTML = this.icon(ls);
    b.title = 'Line: ' + TECH_LS[ls].name + (this.step() ? ' · snap ' + this.step() + ' mm' : '');
    b.classList.toggle('on', ls !== 'f');
    const list = $('techLs');
    if(list) list.innerHTML = Object.keys(TECH_LS).map(k => `<button type="button" data-ls="${k}" class="${k === ls ? 'on' : ''}">${this.icon(k)}<span><b>${TECH_LS[k].name}</b><small>${esc(TECH_LS[k].sub)}</small></span></button>`).join('');
    const st = $('techSnap');
    if(st) st.innerHTML = TECH_STEPS.map(v => `<button type="button" data-step="${v}" class="${v === this.step() ? 'on' : ''}">${v ? v + ' mm' : 'Off'}</button>`).join('');
  }
};
// a stroke's box, also for strokes without a cached geometry
function geoBox(it){ try { return geoOf(it).b; } catch { return strokeBox(it); } }
$('techBtn').addEventListener('click', e => { Tech.render(); openPop('techPop', e.currentTarget); });
$('techLs').addEventListener('click', e => { const b = e.target.closest('[data-ls]'); if(!b) return; prefs.techLs = b.dataset.ls; savePrefs(); Tech.render(); closePops(); });
$('techSnap').addEventListener('click', e => { const b = e.target.closest('[data-step]'); if(!b) return; prefs.techSnap = +b.dataset.step; savePrefs(); Tech.render(); });
