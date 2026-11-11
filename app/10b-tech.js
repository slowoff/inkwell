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
      if(it.t !== 's' || it.hl || it.mk || it.dim || it.dp || (skip && skip.has(it.id))) continue;
      const b = geoBox(it); if(x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
      const P = this.points(it);
      // [x, y, what, item id, point name] (a stroke that ends where it started offers one point)
      for(const k in P){ if(k === 'b' && P.a && Math.hypot(P.b[0] - P.a[0], P.b[1] - P.a[1]) <= 1) continue; out.push([P[k][0], P[k][1], this.why(k), it.id, k]); }
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
/* ---------- (2.0 stage 2) dimension lines and exact sizes ----------
   A dimension is ordinary items in one group, so selecting, moving, erasing, export and sync all work as for any drawing:
   two extension lines, the dimension line (thin), two filled arrowheads and a text box with the size in mm.
   The dimension line carries it.dim = {a, b, parts: [ids], k: 'lin' | 'dia'}; a and b are anchors: {id, k} = a point of
   another item (an end, middle, corner or centre, see Tech.points) or {p: [x, y]} = a fixed point. Whenever a change is
   committed that touches an anchored item (or the dimension itself, e.g. moved further out), the dimension is rebuilt from
   its anchors in the same undo step, so the number always shows the part's real size. Older app versions just see the
   lines and the text. */
Object.assign(Tech, {
  // the named points of an item (the same ones the snapping offers)
  points(it){
    const out = {};
    if(!it || it.t !== 's' || !it.p || it.p.length < 3) return out;
    const g = this.geoOf(it), p = it.p, n = p.length;
    if(g && g.k === 'l'){ const v = g.v; out.a = [v[0], v[1]]; out.b = [v[2], v[3]]; out.m = [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2]; }
    else if(g && g.k === 'r'){ const [L, T, R, B] = g.v; Object.assign(out, {c0: [L, T], c1: [R, T], c2: [R, B], c3: [L, B], m0: [(L + R) / 2, T], m1: [R, (T + B) / 2], m2: [(L + R) / 2, B], m3: [L, (T + B) / 2], ce: [(L + R) / 2, (T + B) / 2]}); }
    else if(g && g.k === 'e'){ const [cx, cy, rx, ry] = g.v; Object.assign(out, {ce: [cx, cy], q0: [cx + rx, cy], q1: [cx, cy + ry], q2: [cx - rx, cy], q3: [cx, cy - ry]}); }
    else if(!it.fl){ out.a = [p[0], p[1]]; out.b = [p[n-3], p[n-2]]; }
    return out;
  },
  why(k){ return k === 'm' || /^m\d/.test(k) ? 'middle' : k === 'ce' ? 'centre' : /^c\d/.test(k) ? 'corner' : /^q\d/.test(k) ? 'edge' : 'end'; },
  resolve(an){
    if(!an) return null;
    if(an.p) return an.p;
    const it = cur && cur.items.get(an.id); if(!it) return null;
    return this.points(it)[an.k] || null;
  },
  isDimPart(it){ return !!(it && (it.dim || it.dp)); },

  /* building a dimension */
  MMs(v){ return v * MM; },
  arrow(tip, dir, c){
    // filled arrowhead, 3 mm long, 1 mm wide, pointing along dir (unit) to tip
    const l = 3 * MM, w = 0.5 * MM, bx = tip[0] - dir[0] * l, by = tip[1] - dir[1] * l, nx = -dir[1], ny = dir[0];
    return {t: 's', c, w: 0.2 * MM, hl: 0, fl: 1, p: [tip[0], tip[1], 0.5, bx + nx * w, by + ny * w, 0.5, bx - nx * w, by - ny * w, 0.5]};
  },
  line(a, b, c){
    const P = [], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
    for(let i = 0; i <= n; i++) P.push(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, 0.5);
    return {t: 's', c, w: 0.25 * MM, hl: 0, ls: 'n', p: P};
  },
  textItem(txt, cx, cy, side){
    // upright text (ISO 129 allows all dimension text to read from the bottom); about 3.5 mm tall
    const px = 13, fs = Math.round(px / 17 * 1000) / 1000, w = Math.max(28, txt.length * px * 0.62 + 14), h = px * 1.45 + 6;
    const x = cx - w / 2 + side[0] * (w / 2 + 1 * MM), y = cy - h / 2 + side[1] * (h / 2 + 0.5 * MM);
    return {t: 'x', x, y, w, fs, html: '<p>' + esc(txt) + '</p>'};
  },
  // the items of a linear dimension from A to B, the dimension line at distance off (signed, along normal n)
  buildLin(A, B, off, c){
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    if(L < 0.5) return null;
    const u = [dx / L, dy / L], n = [-u[1], u[0]], s = off >= 0 ? 1 : -1, gap = 1 * MM, over = 2 * MM;
    const D1 = [A[0] + n[0] * off, A[1] + n[1] * off], D2 = [B[0] + n[0] * off, B[1] + n[1] * off];
    const e = (P, D) => Math.abs(off) > gap + 0.5 ? this.line([P[0] + n[0] * gap * s, P[1] + n[1] * gap * s], [D[0] + n[0] * over * s, D[1] + n[1] * over * s], c) : null;
    const mid = [(D1[0] + D2[0]) / 2, (D1[1] + D2[1]) / 2];
    return {
      main: this.line(D1, D2, c),
      parts: [e(A, D1), e(B, D2), this.arrow(D1, [-u[0], -u[1]], c), this.arrow(D2, u, c), this.textItem(this.num(L / MM), mid[0], mid[1], [n[0] * s, n[1] * s])]
    };
  },
  // diameter: a line across the circle through its centre at 45° (or along the drag), arrows on the circle, ⌀ text outside
  buildDia(C, r, ang, c){
    const u = [Math.cos(ang), Math.sin(ang)], P1 = [C[0] - u[0] * r, C[1] - u[1] * r], P2 = [C[0] + u[0] * r, C[1] + u[1] * r];
    const tail = [P2[0] + u[0] * 6 * MM, P2[1] + u[1] * 6 * MM];
    return {
      main: this.line(P1, tail, c),
      parts: [null, null, this.arrow(P1, [-u[0], -u[1]], c), this.arrow(P2, u, c), this.textItem('⌀' + this.num(2 * r / MM), tail[0], tail[1], [u[0] >= 0 ? 1 : -1, 0])]
    };
  },
  // finished items (ids kept from the old dimension when rebuilding, so a selection holding it stays valid)
  dimItems(spec, old){
    const c = old ? old.c : (prefs.pen.c || 'auto');
    let built = null;
    if(spec.k === 'dia'){
      const it = cur.items.get(spec.a.id), g = it && this.geoOf(it);
      if(!g || g.k !== 'e') return null;
      built = this.buildDia([g.v[0], g.v[1]], (g.v[2] + g.v[3]) / 2, spec.ang == null ? -Math.PI / 4 : spec.ang, c);
    } else {
      const A = this.resolve(spec.a), B = this.resolve(spec.b);
      if(!A || !B) return null;
      built = this.buildLin(A, B, spec.off, c);
    }
    if(!built) return null;
    const ids = old && old.dim && old.dim.parts && old.dim.parts.length === 5 ? old.dim.parts.slice() : [0, 1, 2, 3, 4].map(i => (i === 4 ? 'x' : 's') + newId() + Math.random().toString(36).slice(2, 5));
    const mainId = old ? old.id : 's' + newId() + Math.random().toString(36).slice(2, 5);
    const g = old && old.g ? old.g : 'g' + newId();
    const main = Object.assign(built.main, {id: mainId, g, dim: {k: spec.k, a: spec.a, b: spec.b || null, off: spec.off || 0, ang: spec.ang == null ? null : spec.ang, parts: ids}});
    const parts = built.parts.map((it, i) => it ? Object.assign(it, {id: ids[i], g, dp: mainId}) : null);
    return {main, parts, ids};
  },
  // where the dimension line now is (after the user moved it): its signed distance from A-B
  offNow(it, A, B){
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1, n = [-dy / L, dx / L], p = it.p;
    return (p[0] - A[0]) * n[0] + (p[1] - A[1]) * n[1];
  },
  // anchor from a snap target, or a fixed point
  anchorAt(x, y){
    const t = this.target(x, y);
    if(t && t[3]) return {an: {id: t[3], k: t[4]}, p: [t[0], t[1]], why: t[2]};
    const s = this.snap(x, y); return {an: {p: s.p}, p: s.p, why: s.why};
  },
  // the dimension shape from the shapes menu: drag from one point to another (a tap on a circle: its diameter)
  dimFromPick(b){
    if(b.tap){
      // tap on a circle
      for(const it of cur.items.values()){
        const g = this.geoOf(it); if(!g || g.k !== 'e') continue;
        const d = Math.hypot((b.x0 - g.v[0]) / g.v[2], (b.y0 - g.v[1]) / g.v[3]);
        if(Math.abs(d - 1) < 0.25 || d < 1) return this.dimItems({k: 'dia', a: {id: it.id, k: 'ce'}, ang: -Math.PI / 4});
      }
      return null;
    }
    const A = this.pickA || {an: {p: [b.x0, b.y0]}, p: [b.x0, b.y0]}, B = this.pickB || {an: {p: [b.x1, b.y1]}, p: [b.x1, b.y1]};
    // away from the part: the side the part's centre is not on; else above / left
    const dx = B.p[0] - A.p[0], dy = B.p[1] - A.p[1], L = Math.hypot(dx, dy) || 1, n = [-dy / L, dx / L];
    let side = (n[1] < -0.01 || (Math.abs(n[1]) <= 0.01 && n[0] < 0)) ? 1 : -1;   // default: up (or left)
    const host = A.an.id && cur.items.get(A.an.id), hb = host ? geoBox(host) : null;
    if(hb){ const cx = (hb[0] + hb[2]) / 2 - A.p[0], cy = (hb[1] + hb[3]) / 2 - A.p[1], dot = cx * n[0] + cy * n[1]; if(Math.abs(dot) > 1) side = dot > 0 ? -1 : 1; }
    return this.dimItems({k: 'lin', a: A.an, b: B.an, off: side * 8 * MM});
  },
  // committed changes: rebuild every dimension anchored to a changed item (or itself changed); returns extra [before, after] pairs
  follow(before, after){
    if(!cur) return null;
    const changed = new Set(after.map(p => p[0]));
    const dims = [...cur.items.values()].filter(it => it.dim && (changed.has(it.id) || changed.has(it.dim.a && it.dim.a.id) || changed.has(it.dim.b && it.dim.b.id)));
    if(!dims.length) return null;
    const B = [], A = [];
    for(const d of dims){
      let off = d.dim.off;
      if(d.dim.k === 'lin'){
        const pa = this.resolve(d.dim.a), pb = this.resolve(d.dim.b);
        if(!pa || !pb) continue;
        if(changed.has(d.id)) off = this.offNow(d, pa, pb);   // the dimension itself was moved: keep it where it was put
      }
      let ang = d.dim.ang;
      if(d.dim.k === 'dia' && changed.has(d.id)){ const p = d.p; ang = Math.atan2(p[p.length-2] - p[1], p[p.length-3] - p[0]); }
      const r = this.dimItems({k: d.dim.k, a: d.dim.a, b: d.dim.b, off, ang}, d);
      if(!r) continue;
      for(const it of [r.main, ...r.parts]){ if(!it) continue; B.push([it.id, cur.items.get(it.id) || null]); A.push([it.id, it]); }
      // a part that is no longer needed (extension lines of a dimension pulled onto the part)
      r.ids.forEach((id, i) => { if(!r.parts[i] && cur.items.get(id)){ B.push([id, cur.items.get(id)]); A.push([id, null]); } });
    }
    if(!A.length) return null;
    setItems(A);
    return [B, A];
  },

  /* typing an exact size: one line, rectangle or circle selected */
  sizeTarget(its){
    if(!this.on() || its.length !== 1) return null;
    const it = its[0]; if(it.dim || it.dp || it.g) return null;
    return this.geoOf(it) ? it : null;
  },
  withGeo(it, g){
    const pr = it.p[2] || 0.5, P = [];
    const push = V => { for(let i = 0; i < V.length - 1; i++){ const a = V[i], b = V[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.5)); for(let k = 0; k < n; k++) P.push(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, pr); } const l = V[V.length - 1]; P.push(l[0], l[1], pr); };
    if(g.k === 'l') push([[g.v[0], g.v[1]], [g.v[2], g.v[3]]]);
    else if(g.k === 'r'){ const [L, T, R, B] = g.v; push([[L, T], [R, T], [R, B], [L, B], [L, T]]); }
    else { const [cx, cy, rx, ry] = g.v, V = []; for(let i = 0; i <= 96; i++){ const t = i / 96 * Math.PI * 2; V.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); } push(V); }
    const o = Object.assign({}, it, {p: P, geo: g}); delete o.ra;
    return o;
  },
  openSize(){
    const it = sel && this.sizeTarget(sel.ids.map(id => cur.items.get(id)).filter(Boolean)); if(!it) return;
    const g = this.geoOf(it), f = v => this.num(v / MM);
    let rows;
    if(g.k === 'l'){
      const L = Math.hypot(g.v[2] - g.v[0], g.v[3] - g.v[1]); let deg = -Math.atan2(g.v[3] - g.v[1], g.v[2] - g.v[0]) * 180 / Math.PI; if(deg < 0) deg += 360;
      rows = [['len', 'Length', f(L), 'mm'], ['ang', 'Angle', String(Math.round(deg * 10) / 10), '°']];
    } else if(g.k === 'r') rows = [['w', 'Width', f(g.v[2] - g.v[0]), 'mm'], ['h', 'Height', f(g.v[3] - g.v[1]), 'mm']];
    else rows = Math.abs(g.v[2] - g.v[3]) < 0.5 ? [['d', 'Diameter', f(2 * g.v[2]), 'mm']] : [['w', 'Width', f(2 * g.v[2]), 'mm'], ['h', 'Height', f(2 * g.v[3]), 'mm']];
    $('sizeRows').innerHTML = rows.map(([k, l, v, u]) => `<label class="size-row"><span>${l}</span><input type="text" inputmode="decimal" data-k="${k}" value="${v}" autocomplete="off"><em>${u}</em></label>`).join('');
    $('sizeErr').hidden = true;
    $('sizePop').dataset.id = it.id;
    openPop('sizePop', $('selSize'));
    const first = $('sizeRows').querySelector('input'); if(first){ first.focus(); first.select(); }
  },
  applySize(){
    const it = cur && cur.items.get($('sizePop').dataset.id), g = it && this.geoOf(it); if(!g) return;
    const val = k => { const el = $('sizeRows').querySelector(`[data-k="${k}"]`); if(!el) return null; const v = parseFloat(el.value.replace(',', '.')); return isFinite(v) ? v : NaN; };
    const bad = msg => { $('sizeErr').textContent = msg; $('sizeErr').hidden = false; };
    let ng;
    if(g.k === 'l'){
      const L = val('len'), a = val('ang');
      if(!(L > 0) || L > 5000) return bad('Enter a length above 0 mm.');
      if(!isFinite(a)) return bad('Enter an angle in degrees.');
      const t = -a * Math.PI / 180;
      ng = {k: 'l', v: [g.v[0], g.v[1], g.v[0] + L * MM * Math.cos(t), g.v[1] + L * MM * Math.sin(t)]};
    } else if(g.k === 'r'){
      const w = val('w'), h = val('h');
      if(!(w > 0) || !(h > 0) || w > 5000 || h > 5000) return bad('Enter a width and height above 0 mm.');
      ng = {k: 'r', v: [g.v[0], g.v[1], g.v[0] + w * MM, g.v[1] + h * MM]};
    } else {
      const d = val('d');
      if(d != null){ if(!(d > 0) || d > 5000) return bad('Enter a diameter above 0 mm.'); ng = {k: 'e', v: [g.v[0], g.v[1], d * MM / 2, d * MM / 2]}; }
      else { const w = val('w'), h = val('h'); if(!(w > 0) || !(h > 0)) return bad('Enter a width and height above 0 mm.'); ng = {k: 'e', v: [g.v[0], g.v[1], w * MM / 2, h * MM / 2]}; }
    }
    closePops();
    replaceItems([this.withGeo(it, ng)]);
    selectIds([it.id]);
    toast(this.boxText(ng));
  }
});

/* ---------- (2.0 stage 3) robotics symbols and the parts list ----------
   A symbol is a group of ordinary strokes (so it moves, recolours, erases, exports and syncs like any drawing); its first stroke
   carries it.sym = name, which the parts list counts. Shapes are in mm around the symbol's middle, at a sensible real size;
   dragging a box scales a symbol to fit it. Parts lists are text boxes marked it.pl; they are rewritten whenever a symbol on
   the page is added or removed (in the same undo step). */
const SYM = (() => {
  const C = (cx, cy, r, o) => { const V = [], n = Math.max(16, Math.round(r * 6)); for(let i = 0; i < n; i++){ const t = i / n * Math.PI * 2; V.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); } return [V, true, o]; };
  const R = (x0, y0, x1, y1, o) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, o];
  const L = (...pts) => [pts, false];
  const Lo = (o, ...pts) => [pts, false, o];
  const arc = (cx, cy, r, a0, a1) => { const V = []; for(let i = 0; i <= 12; i++){ const t = (a0 + (a1 - a0) * i / 12) * Math.PI / 180; V.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); } return [V, false]; };
  const gear = () => {
    const z = 12, ro = 15, rr = 12.6, V = [];
    for(let i = 0; i < z; i++){
      const a = i / z * Math.PI * 2, s = Math.PI * 2 / z;
      for(const [f, r] of [[0, rr], [0.18, ro], [0.5, ro], [0.68, rr]]) V.push([r * Math.cos(a + f * s), r * Math.sin(a + f * s)]);
    }
    return [[V, true], C(0, 0, 4), Lo('c', [-18, 0], [18, 0]), Lo('c', [0, -18], [0, 18])];
  };
  const balls = () => { const out = []; for(let i = 0; i < 8; i++){ const t = i / 8 * Math.PI * 2; out.push(C(8 * Math.cos(t), 8 * Math.sin(t), 1.6)); } return out; };
  const pins = () => { const out = []; for(let i = 0; i < 11; i++){ const x = -17 + i * 3.4; out.push(R(x - 0.7, -12.7, x + 0.7, -11.3), R(x - 0.7, 11.3, x + 0.7, 12.7)); } return out; };
  return {
    gear: {name: 'Gear', grp: 'mech', d: gear},
    wheel: {name: 'Wheel', grp: 'mech', d: () => [C(0, 0, 20), C(0, 0, 15.5), C(0, 0, 4), Lo('c', [-23, 0], [23, 0]), Lo('c', [0, -23], [0, 23])]},
    bearing: {name: 'Bearing', grp: 'mech', d: () => [C(0, 0, 11), C(0, 0, 5), ...balls()]},
    pivot: {name: 'Pivot / joint', grp: 'mech', d: () => [C(0, 0, 3), C(0, 0, 0.9)]},
    horn: {name: 'Servo horn', grp: 'mech', d: () => [C(0, 0, 4), C(18, 0, 2.5), L([0, -4], [18, -2.5]), L([0, 4], [18, 2.5]), C(10, 0, 0.8), C(14, 0, 0.8), C(18, 0, 0.8), C(0, 0, 1.2)]},
    shaft: {name: 'Shaft', grp: 'mech', d: () => [R(-20, -3, 20, 3), Lo('c', [-23, 0], [23, 0])]},
    motor: {name: 'Motor', grp: 'elec', d: () => [C(0, 0, 7), L([-3.5, 3], [-3.5, -3], [0, 0.6], [3.5, -3], [3.5, 3]), L([-13, 0], [-7, 0]), L([7, 0], [13, 0])]},
    servo: {name: 'Servo', grp: 'elec', d: () => [R(-12, -7, 12, 7), C(5, 0, 2.5), L([5, -2.5], [5, -12]), C(5, -12, 1.2), L([-12, -3], [-17, -3]), L([-12, 0], [-17, 0]), L([-12, 3], [-17, 3])]},
    battery: {name: 'Battery', grp: 'elec', d: () => [L([-13, 0], [-2, 0]), L([2, 0], [13, 0]), L([-2, -6], [-2, 6]), Lo('k', [2, -3], [2, 3]), L([-7, -6], [-4, -6]), L([-5.5, -7.5], [-5.5, -4.5])]},
    switch: {name: 'Switch', grp: 'elec', d: () => [L([-13, 0], [-5, 0]), C(-4, 0, 1), C(4, 0, 1), L([5, 0], [13, 0]), L([-3.1, -0.6], [4.5, -5])]},
    led: {name: 'LED', grp: 'elec', d: () => [L([-13, 0], [-4, 0]), L([4, 0], [13, 0]), [[[-4, -4], [-4, 4], [4, 0]], true], L([4, -4], [4, 4]), L([0, -5], [3.5, -8.5]), L([1.8, -8.5], [3.5, -8.5], [3.5, -6.8]), L([3.5, -4], [7, -7.5]), L([5.3, -7.5], [7, -7.5], [7, -5.8])]},
    resistor: {name: 'Resistor', grp: 'elec', d: () => [R(-6, -2.5, 6, 2.5), L([-13, 0], [-6, 0]), L([6, 0], [13, 0])]},
    sensor: {name: 'Sensor', grp: 'elec', d: () => [R(-8, -6, 8, 6), arc(8, 0, 3.5, -45, 45), arc(8, 0, 6, -45, 45), arc(8, 0, 8.5, -45, 45), L([-8, -3], [-13, -3]), L([-8, 0], [-13, 0]), L([-8, 3], [-13, 3])]},
    board: {name: 'Controller board', grp: 'elec', d: () => [R(-20, -14, 20, 14), R(-7, -7, 7, 7), R(-24, -4, -20, 4), ...pins()]}
  };
})();
Object.assign(Tech, {
  symBox(key){
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for(const [V] of SYM[key].d()) for(const q of V){ x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
    return [x0, y0, x1, y1];
  },
  // the symbol's strokes; a tap: real size around the tap; a box: scaled to fit it, centred
  symItems(key, b){
    const S = SYM[key]; if(!S) return [];
    const [x0, y0, x1, y1] = this.symBox(key), bw = x1 - x0, bh = y1 - y0;
    let k = MM, cx, cy;
    if(b.tap){ cx = b.x0; cy = b.y0; }
    else {
      const W = Math.abs(b.x1 - b.x0), H = Math.abs(b.y1 - b.y0);
      if(W * cam.z < 8 && H * cam.z < 8){ cx = b.x0; cy = b.y0; }
      else { k = Math.min(W / bw, H / bh) || MM; cx = (b.x0 + b.x1) / 2; cy = (b.y0 + b.y1) / 2; }
    }
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, g = 'g' + newId(), c = prefs.pen.c, out = [];
    const base = Math.max(0.3, 0.5 * k / MM) * MM;
    for(const [V, closed, o] of S.d()){
      const P = V.map(q => [cx + (q[0] - mx) * k, cy + (q[1] - my) * k]);
      const it = {t: 's', id: 's' + newId() + Math.random().toString(36).slice(2, 5), c, w: o === 'k' ? base * 1.5 : o === 'c' ? base * 0.6 : base, hl: 0, ls: o === 'c' ? 'c' : 'n', g, p: polyPts(P, closed, 1.5)};
      if(!out.length) it.sym = key;
      out.push(it);
    }
    return out;
  },
  // small picture of a symbol for the menu
  symIcon(key){
    const [x0, y0, x1, y1] = this.symBox(key), s = Math.max(x1 - x0, y1 - y0) || 1, pad = s * 0.08;
    const d = SYM[key].d().map(([V, closed]) => 'M' + V.map(q => (+q[0].toFixed(2)) + ' ' + (+q[1].toFixed(2))).join('L') + (closed ? 'Z' : '')).join('');
    return `<svg viewBox="${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}" style="fill:none;stroke:currentColor;stroke-width:${(s / 22).toFixed(2)};stroke-linejoin:round;stroke-linecap:round"><path d="${d}"/></svg>`;
  },
  renderSyms(){
    const el = $('symGrid'); if(!el) return;
    const btn = k => `<button type="button" data-sym="${k}" title="${esc(SYM[k].name)}" aria-label="${esc(SYM[k].name)}">${this.symIcon(k)}<span>${esc(SYM[k].name)}</span></button>`;
    const keys = Object.keys(SYM);
    el.innerHTML = '<div class="sym-h">Mechanical</div>' + keys.filter(k => SYM[k].grp === 'mech').map(btn).join('') +
      '<div class="sym-h">Electronics</div>' + keys.filter(k => SYM[k].grp === 'elec').map(btn).join('');
  },
  /* parts list */
  partsHTML(){
    const n = {};
    for(const it of cur.items.values()) if(it.sym && SYM[it.sym]) n[it.sym] = (n[it.sym] || 0) + 1;
    const keys = Object.keys(SYM).filter(k => n[k]);
    return '<p><b>Parts list</b></p>' + (keys.length ? keys.map(k => `<p>${n[k]} × ${esc(SYM[k].name)}</p>`).join('') : '<p>No parts yet: add symbols from Shapes</p>');
  },
  partsItem(b){ return {t: 'x', id: 'x' + newId(), x: b.x0, y: b.y0, w: 200, fs: 1, html: this.partsHTML(), pl: 1}; },
  // rewrite every parts list on the page when a symbol came or went; returns [before, after] pairs
  followParts(before, after){
    const touched = before.concat(after).some(([id, it]) => it && it.sym) || before.some(([id]) => { const x = cur.items.get(id); return x && x.sym; });
    if(!touched) return null;
    const html = this.partsHTML(), B = [], A = [];
    for(const it of cur.items.values()) if(it.pl && it.html !== html){ B.push([it.id, it]); A.push([it.id, Object.assign({}, it, {html})]); }
    if(!A.length) return null;
    setItems(A);
    return [B, A];
  }
});

$('techBtn').addEventListener('click', e => { Tech.render(); openPop('techPop', e.currentTarget); });
$('techLs').addEventListener('click', e => { const b = e.target.closest('[data-ls]'); if(!b) return; prefs.techLs = b.dataset.ls; savePrefs(); Tech.render(); closePops(); });
$('techSnap').addEventListener('click', e => { const b = e.target.closest('[data-step]'); if(!b) return; prefs.techSnap = +b.dataset.step; savePrefs(); Tech.render(); });
$('selSize').addEventListener('click', () => Tech.openSize());
$('sizeForm').addEventListener('submit', e => { e.preventDefault(); Tech.applySize(); });
$('symGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-sym]'); if(!b) return;
  closePops();
  startPick({kind: 'shape', shape: 'sym:' + b.dataset.sym}, 'Tap to place the ' + SYM[b.dataset.sym].name.toLowerCase() + ' at its real size, or drag a box to size it');
});
$('partsBtn').addEventListener('click', () => { closePops(); startPick({kind: 'shape', shape: 'parts'}, 'Tap where the parts list should go'); });
