/* Inkwell app: Writing tools: reference line, shape snapping, ruler.
   (1.64.1) split out of app/06-writing.js. All app/ files share one global scope and are run in order by app.js;
   code that runs while a file loads must not use a later file (tests/unit/load_order.test.js). */
'use strict';
/* =====================================================================
   Reference line (1.42, pen options → Writing menu, prefs.refLine). Replaces the 1.41 "Keep lines level"
   and "Even word spacing", which moved your strokes; nothing is moved any more.
   While you write with the pen, a faint dashed line appears under the line you are writing, at the height
   of its first word, so you can keep the rest of the line straight yourself. It stays for a few seconds
   after you lift the pen, then fades. Strokes stay exactly as written. State lives on cur (cur.wa).
   ===================================================================== */
const REF_LINGER = 4000, REF_FADE = 1200;
const WA = {
  last: null,   // {page, L, at}: the line written on last, for the guide after the pen is lifted
  on(){ return !!prefs.refLine; },
  st(){ if(!cur) return null; if(!cur.wa) cur.wa = {lines: []}; return cur.wa; },
  q(arr, f){ if(!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * f)))]; },
  box(p){ let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for(let i = 0; i < p.length; i += 3){ const x = p[i], y = p[i+1]; if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; } return [x0, y0, x1, y1]; },
  // A line: base = where the letters sit (median bottom of its first few letter-sized strokes, so one
  // descender like g or y does not move it), h = typical letter height. Dots, i-dots and t-bars never set it.
  mid(L){ return L.base - 0.5 * L.h; },
  small(h, w, L){ return L ? h < 0.45 * L.h : (h * cam.z < 10 || (h < 0.35 * w && h * cam.z < 16)); },
  findLine(st, b){
    const m = (b[1] + b[3]) / 2, h = b[3] - b[1], w = b[2] - b[0]; let best = null, bd = Infinity;
    for(const L of st.lines){
      if(b[0] < L.left - 2 * L.h || b[0] > L.right + 12 * L.h) continue;
      const d = m - this.mid(L);
      // dots and crossbars may sit well above the letters
      const ok = this.small(h, w, L) ? d > -2.2 * L.h && d < 1.1 * L.h : Math.abs(d) <= 1.1 * L.h;
      if(ok && Math.abs(d) < bd){ bd = Math.abs(d); best = L; }
    }
    return best;
  },
  // each finished pen stroke: find or start its line (only read, never changed)
  stroke(it){
    if(!this.on() || !cur || it.p.length < 6) return;
    const st = this.st();
    const b = this.box(it.p), w = b[2] - b[0], h = b[3] - b[1];
    let L = this.findLine(st, b);
    if(!L){
      if(h * cam.z > 200 || w * cam.z > 500) return;   // a drawing, not writing
      if(this.small(h, w, null)) return;                // a dot or dash on its own does not start a line
      L = {base: b[3], bots: [b[3]], h, hs: [h], left: b[0], right: b[2]};
      st.lines.push(L); if(st.lines.length > 8) st.lines.shift();
    } else {
      if(h > 3 * L.h || w > 8 * L.h) return;   // a drawing or a line across: not part of the writing
      L.left = Math.min(L.left, b[0]); L.right = Math.max(L.right, b[2]);
      if(!this.small(h, w, L)){
        L.hs.push(h); if(L.hs.length > 40) L.hs.shift();
        L.h = Math.max(this.q(L.hs, 0.5), 6 / cam.z);
        if(L.bots.length < 5){ L.bots.push(b[3]); L.base = this.q(L.bots, 0.5); }
      }
    }
    this.last = {page: cur.id, L, at: Date.now()};
    drawLiveSoon();
  },
  // after the pen is lifted the guide stays a moment, then fades
  linger(){
    const l = this.last;
    if(!l || !this.on() || !cur || l.page !== cur.id) return 0;
    const t = Date.now() - l.at;
    return t < REF_LINGER ? 1 : t < REF_LINGER + REF_FADE ? 1 - (t - REF_LINGER) / REF_FADE : 0;
  },
  drawAfter(){
    const f = this.linger(); if(!f) return;
    liveCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
    this.line(this.last.L, this.last.L.right, f);
    clearTimeout(this.tm);
    this.tm = setTimeout(drawLiveSoon, f < 1 ? 50 : REF_LINGER - (Date.now() - this.last.at) + 10);
  },
  // while writing: the line under the stroke being written (live canvas already in world units)
  guide(a){
    if(!this.on() || !cur || !cur.wa || a.pts.length < 3) return;
    // the line this stroke is near; while a dot or bar is being drawn above, keep showing the line just written
    let L = this.findLine(cur.wa, [a.pts[0], a.pts[1], a.pts[0], a.pts[1]]);
    const l = this.last;
    if(l && l.page === cur.id){
      const d = a.pts[1] - this.mid(l.L);
      if(d > -2.5 * l.L.h && d < 1.2 * l.L.h && a.pts[0] > l.L.left - 2 * l.L.h && a.pts[0] < l.L.right + 12 * l.L.h) L = l.L;
    }
    if(!L) return;
    this.line(L, Math.max(L.right, a.pts[a.pts.length - 3]), 1);
  },
  line(L, right, f){
    const y = L.base + 2 / cam.z;   // just under the bottom of the letters
    liveCtx.save();
    liveCtx.globalAlpha = 0.45 * f; liveCtx.strokeStyle = tokens.accent; liveCtx.lineWidth = 1.2 / cam.z;
    liveCtx.setLineDash([6 / cam.z, 5 / cam.z]);
    liveCtx.beginPath(); liveCtx.moveTo(L.left - L.h, y); liveCtx.lineTo(right + 8 * L.h, y); liveCtx.stroke();
    liveCtx.restore();
  }
};

/* eraser: 'stroke' removes whole strokes it touches, 'area' (partial) rubs out only the ink under it */
function eraseAt(sx, sy){
  const R = eraserRadius() / cam.z;
  const [wx, wy] = toWorld(sx, sy);
  // fill the gap since the last position so fast moves don't skip ink
  const last = act.lastW; act.lastW = [wx, wy];
  if(last){
    const d = Math.hypot(wx - last[0], wy - last[1]), n = Math.floor(d / (R * 0.5));
    for(let k = 1; k <= n; k++){ const t = k / (n + 1); eraseWorld(last[0] + (wx - last[0]) * t, last[1] + (wy - last[1]) * t, R); }
  }
  eraseWorld(wx, wy, R);
}
// Formulas (graph numbers and labels too) are erased whole by both eraser modes.
function eraseFormulas(wx, wy, R){
  let hit = false;
  for(const it of [...cur.items.values()]){
    if(it.t !== 'm' || it.ne) continue;   // ne: part of a graph, only removed with the Select tool (1.57)
    const b = itemBox(it), cx = clamp(wx, b[0], b[2]), cy = clamp(wy, b[1], b[3]);
    if((cx - wx) ** 2 + (cy - wy) ** 2 > R * R) continue;
    act.removed.push(it); cur.items.delete(it.id); dropEl(it.id); hit = true;
  }
  if(hit) changed();
}
// Text boxes (typed or made by Write to text): the Stroke eraser removes the whole box it touches,
// the Partial eraser removes only the words it passes over.
function eraseTexts(wx, wy, R){
  let hit = false;
  for(const it of [...cur.items.values()]){
    if(it.t !== 'x' || it.ne || (editing && editing.id === it.id)) continue;
    const b = itemBox(it), cx = clamp(wx, b[0], b[2]), cy = clamp(wy, b[1], b[3]);
    if((cx - wx) ** 2 + (cy - wy) ** 2 > R * R) continue;
    const el = elMap.get(it.id); if(!el) continue;
    if(act.mode !== 'area'){
      act.removed.push(it); cur.items.delete(it.id); dropEl(it.id); act.added.delete(it.id); hit = true; continue;
    }
    // words under the eraser circle (centre and a ring of sample points), found from screen positions
    const sx0 = SR.left + cam.ox, sy0 = SR.top + cam.oy, rs = R * cam.z, cut = new Map();
    for(const [dx, dy] of [[0, 0]]){   // the word under the eraser's centre; fast moves are filled in by eraseAt
      const x = sx0 + (wx + dx * R) * cam.z, y = sy0 + (wy + dy * R) * cam.z;
      const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
      const node = r && r.startContainer;
      if(!node || node.nodeType !== 3 || !el.contains(node) || (node.parentElement && node.parentElement.closest('[data-er]'))) continue;
      const t = node.data, k = Math.min(r.startOffset, t.length);
      // the caret lands between letters: take the word around it, only if a letter is really under the point
      let a = k, z = k;
      while(a > 0 && !/\s/.test(t[a - 1])) a--;
      while(z < t.length && !/\s/.test(t[z])) z++;
      if(z <= a) continue;
      const rr = document.createRange(); rr.setStart(node, a); rr.setEnd(node, z);
      const box = rr.getBoundingClientRect();
      const tol = Math.min(rs * 0.35, 6);
      if(x < box.left - tol || x > box.right + tol || y < box.top - tol || y > box.bottom + tol) continue;
      if(!cut.has(node)) cut.set(node, []);
      cut.get(node).push([a, z]);
    }
    if(!cut.size) continue;
    // erased words are only hidden while the pen is down, so the rest of the line does not slide under it;
    // finishTextErase() removes them when the pen lifts
    for(const [node, spans] of cut){
      spans.sort((p, q) => q[0] - p[0]);
      let last = Infinity;
      for(const [a, z] of spans){
        if(z > last) continue;
        const rr = document.createRange(); rr.setStart(node, a); rr.setEnd(node, z);
        const sp = document.createElement('span'); sp.dataset.er = '1'; sp.style.visibility = 'hidden';
        try { rr.surroundContents(sp); } catch { continue; }
        last = a;
      }
    }
    const orig = act.removed.find(r => r.id === it.id) || it;
    if(!act.removed.includes(orig)) act.removed.push(orig);
    (act.texts || (act.texts = new Set())).add(it.id);
  }
  if(hit) changed();
}
function finishTextErase(a){
  if(!a.texts) return;
  for(const id of a.texts){
    const it = cur.items.get(id), el = elMap.get(id); if(!it || !el) continue;
    el.querySelectorAll('[data-er]').forEach(n => n.remove());
    el.normalize();
    // tidy the spaces the removed words leave behind
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for(let n = w.nextNode(); n; n = w.nextNode()) n.data = n.data.replace(/ {2,}/g, ' ');
    const html = cleanHTML(el.innerHTML).replace(/<p> /g, '<p>').replace(/ <\/p>/g, '</p>');
    if(!htmlText(html).trim()){ a.added.delete(id); cur.items.delete(id); dropEl(id); continue; }   // last word gone: the box goes
    const nx = Object.assign({}, it, {html});
    cur.items.set(id, nx); a.added.set(id, nx); el._html = null; itemEl(nx);
  }
  changed();
}
function eraseWorld(wx, wy, R){
  eraseFormulas(wx, wy, R);
  eraseTexts(wx, wy, R);
  if(act.mode === 'area'){ eraseArea(wx, wy, R); return; }
  let hit = false;
  for(const it of [...cur.items.values()]){
    if(it.t !== 's' || it.ne) continue;
    const g = geoOf(it), pad = R + it.w / 2;
    if(wx < g.b[0] - pad || wx > g.b[2] + pad || wy < g.b[1] - pad || wy > g.b[3] + pad) continue;
    const lim = pad * pad, p = it.p;
    let touched = false;
    for(let i = 0; i < p.length && !touched; i += 3){
      const dx = p[i] - wx, dy = p[i+1] - wy;
      if(dx * dx + dy * dy <= lim) touched = true;
      else if(i + 3 < p.length && segDist2(wx, wy, p[i], p[i+1], p[i+3], p[i+4]) <= lim) touched = true;
    }
    if(touched){ act.removed.push(it); cur.items.delete(it.id); geo.delete(it.id); hit = true; }
  }
  if(hit) changed();
}
function eraseArea(wx, wy, R){
  let hit = false;
  for(const it of [...cur.items.values()]){
    if(it.t !== 's' || it.fl || it.ne) continue;   // graphs (ne) and their backgrounds stay: Select + delete removes them
    const g = geoOf(it), pad = R + it.w / 2;
    if(wx < g.b[0] - pad || wx > g.b[2] + pad || wy < g.b[1] - pad || wy > g.b[3] + pad) continue;
    const cut = R + it.w * 0.35, lim = cut * cut, p = it.p;
    // densify only the segments near the eraser, so the cut is clean even on long straight lines
    const step = Math.max(0.4, cut * 0.35), q = [];
    let near = false;
    for(let i = 0; i < p.length; i += 3){
      q.push(p[i], p[i+1], p[i+2]);
      if(i + 3 >= p.length) break;
      const d2 = segDist2(wx, wy, p[i], p[i+1], p[i+3], p[i+4]);
      if(d2 > lim * 4) continue;
      near = true;
      const len = Math.hypot(p[i+3] - p[i], p[i+4] - p[i+1]), n = Math.floor(len / step);
      for(let k = 1; k < n; k++){ const t = k / n; q.push(p[i] + (p[i+3] - p[i]) * t, p[i+1] + (p[i+4] - p[i+1]) * t, p[i+2] + (p[i+5] - p[i+2]) * t); }
    }
    if(!near && p.length > 3) continue;
    // split into the runs of points that stay
    const pieces = []; let run = [], gone = false;
    for(let i = 0; i < q.length; i += 3){
      const dx = q[i] - wx, dy = q[i+1] - wy;
      if(dx * dx + dy * dy <= lim){ gone = true; if(run.length) pieces.push(run); run = []; }
      else run.push(q[i], q[i+1], q[i+2]);
    }
    if(run.length) pieces.push(run);
    if(!gone) continue;
    hit = true;
    cur.items.delete(it.id); geo.delete(it.id);
    if(act.added.has(it.id)) act.added.delete(it.id); else act.removed.push(it);
    for(const pp of pieces){
      if(pp.length < 6) continue;   // a lone point is just a crumb
      const np = {t: 's', id: 's' + newId(), c: it.c, w: it.w, hl: it.hl, p: pp};
      if(it.mk){ np.mk = 1; if(it.at) np.at = it.at; }
      if(it.g) np.g = it.g;
      if(it.o) np.o = it.o;
      cur.items.set(np.id, np); act.added.set(np.id, np);
    }
  }
  if(hit) changed();
}
function segDist2(px, py, ax, ay, bx, by){
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = clamp(t, 0, 1);
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}

/* ---------- shape snapping: hold the pen still at the end of a stroke ---------- */
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function trySnap(a){
  const p = a.pts; if(p.length < 15) return;
  const P = []; for(let i = 0; i < p.length; i += 3) P.push([p[i], p[i+1]]);
  const s = recognize(P);
  if(!s) return;
  a.snapped = s.kind;
  if(s.kind === 'line') a.lineStart = s.pts[0];
  a.pts = densify(s.pts, s.closed);
  drawLive();
}
function densify(V, closed){
  const step = 2 / cam.z, out = [];
  const pts = closed ? V.concat([V[0]]) : V;
  for(let i = 0; i < pts.length - 1; i++){
    const a = pts[i], b = pts[i + 1], d = dist(a, b), n = Math.max(1, Math.ceil(d / step));
    for(let k = 0; k < n; k++) out.push(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, 0.55);
  }
  const l = pts[pts.length - 1]; out.push(l[0], l[1], 0.55);
  return out;
}
function rdp(P, eps){
  if(P.length < 3) return P.slice();
  let idx = 0, dm = 0;
  const a = P[0], b = P[P.length - 1];
  for(let i = 1; i < P.length - 1; i++){ const d = Math.sqrt(segDist2(P[i][0], P[i][1], a[0], a[1], b[0], b[1])); if(d > dm){ dm = d; idx = i; } }
  if(dm > eps){ const l = rdp(P.slice(0, idx + 1), eps), r = rdp(P.slice(idx), eps); return l.slice(0, -1).concat(r); }
  return [a, b];
}
function cleanCorners(V){
  // remove vertices that are almost straight (closed polygon)
  let changedAny = true;
  while(changedAny && V.length > 3){
    changedAny = false;
    for(let i = 0; i < V.length; i++){
      const p = V[(i - 1 + V.length) % V.length], c = V[i], n = V[(i + 1) % V.length];
      const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]), a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
      let d = Math.abs(a2 - a1); if(d > Math.PI) d = 2 * Math.PI - d;
      if(d < 0.45 || dist(p, c) < 1e-3){ V.splice(i, 1); changedAny = true; break; }
    }
  }
  return V;
}
function recognize(P){
  const n = P.length;
  let L = 0; for(let i = 1; i < n; i++) L += dist(P[i-1], P[i]);
  if(L < 24 / cam.z) return null;
  const a = P[0], b = P[n - 1], chord = dist(a, b);
  let maxDev = 0; for(const q of P) maxDev = Math.max(maxDev, Math.sqrt(segDist2(q[0], q[1], a[0], a[1], b[0], b[1])));
  if(chord > 0.85 * L && maxDev < Math.max(6 / cam.z, chord * 0.06)) return {kind: 'line', pts: [a, b]};
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for(const q of P){ x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  const bw = x1 - x0, bh = y1 - y0, diag = Math.hypot(bw, bh);
  if(diag < 16 / cam.z) return null;
  if(chord < 0.22 * diag){
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(bw / 2, 1e-3), ry = Math.max(bh / 2, 1e-3);
    let err = 0; for(const q of P) err += Math.abs(Math.hypot((q[0] - cx) / rx, (q[1] - cy) / ry) - 1); err /= n;
    let V = rdp(P.concat([P[0]]), diag * 0.07); V.pop();
    V = cleanCorners(V);
    const k = V.length;
    if(err < 0.09 && k >= 4 || err < 0.06) return ellipse(cx, cy, rx, ry);
    if(k === 3) return {kind: 'tri', pts: V, closed: true};
    if(k === 4){
      let aligned = true;
      for(let i = 0; i < 4; i++){ const p = V[i], q = V[(i + 1) % 4]; const ang = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2); if(Math.min(ang, Math.PI / 2 - ang) > 0.21) aligned = false; }
      if(aligned){ let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity; for(const v of V){ ax0 = Math.min(ax0, v[0]); ay0 = Math.min(ay0, v[1]); ax1 = Math.max(ax1, v[0]); ay1 = Math.max(ay1, v[1]); } return {kind: 'rect', pts: [[ax0, ay0], [ax1, ay0], [ax1, ay1], [ax0, ay1]], closed: true}; }
      return {kind: 'quad', pts: V, closed: true};
    }
    if(err < 0.13) return ellipse(cx, cy, rx, ry);
    if(k >= 5 && k <= 8) return {kind: 'poly', pts: V, closed: true};
    return null;
  }
  const V = rdp(P, Math.max(5 / cam.z, diag * 0.05));
  if(V.length >= 3 && V.length <= 5){
    let dev = 0;
    for(const q of P){ let m = Infinity; for(let i = 0; i < V.length - 1; i++) m = Math.min(m, segDist2(q[0], q[1], V[i][0], V[i][1], V[i+1][0], V[i+1][1])); dev = Math.max(dev, Math.sqrt(m)); }
    if(dev < diag * 0.06) return {kind: 'polyline', pts: V};
  }
  return null;
}
function ellipse(cx, cy, rx, ry){
  if(Math.abs(rx - ry) / Math.max(rx, ry) < 0.15){ const r = (rx + ry) / 2; rx = ry = r; }
  const pts = [], N = 72;
  for(let i = 0; i < N; i++){ const t = i / N * Math.PI * 2; pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
  return {kind: 'ellipse', pts, closed: true};
}

/* ---------- ruler ---------- */
const RULER_HALF_W = 430, RULER_HALF_H = 38;
let rulerZ = 0;
function rulerLocal(sx, sy){
  const r = prefs.ruler, dx = sx - r.cx, dy = sy - r.cy, c = Math.cos(r.a), s = Math.sin(r.a);
  return [dx * c + dy * s, -dx * s + dy * c];
}
function onRuler(sx, sy){ const [lx, ly] = rulerLocal(sx, sy); return Math.abs(lx) <= RULER_HALF_W && Math.abs(ly) <= RULER_HALF_H; }
function rulerEdge(sx, sy){
  const [lx, ly] = rulerLocal(sx, sy);
  if(Math.abs(lx) > RULER_HALF_W + 20) return null;
  if(Math.abs(Math.abs(ly) - RULER_HALF_H) < 26) return {side: ly < 0 ? -1 : 1};
  return null;
}
function projectEdge(edge, sx, sy, w){
  const r = prefs.ruler, [lx] = rulerLocal(sx, sy);
  const ly = edge.side * (RULER_HALF_H + (w * cam.z) / 2 + 1);
  const c = Math.cos(r.a), s = Math.sin(r.a);
  return [r.cx + lx * c - ly * s, r.cy + lx * s + ly * c];
}
function startRulerGesture(){
  return {kind: 'ruler', r0: {...prefs.ruler}, t0: [...touches.values()].map(t => [t.x, t.y])};
}
function rulerMove(){
  const ts = [...touches.values()].map(t => [t.x, t.y]), g = gesture, r = prefs.ruler;
  if(ts.length === 1 || g.t0.length === 1){
    r.cx = g.r0.cx + ts[0][0] - g.t0[0][0]; r.cy = g.r0.cy + ts[0][1] - g.t0[0][1];
  } else {
    const a0 = Math.atan2(g.t0[1][1] - g.t0[0][1], g.t0[1][0] - g.t0[0][0]);
    const a1 = Math.atan2(ts[1][1] - ts[0][1], ts[1][0] - ts[0][0]);
    let a = g.r0.a + (a1 - a0);
    const step = Math.PI / 12, snapA = Math.round(a / step) * step;
    if(r.snap !== false && Math.abs(a - snapA) < 0.035) a = snapA;
    r.a = a;
    r.cx = g.r0.cx + (ts[0][0] + ts[1][0]) / 2 - (g.t0[0][0] + g.t0[1][0]) / 2;
    r.cy = g.r0.cy + (ts[0][1] + ts[1][1]) / 2 - (g.t0[0][1] + g.t0[1][1]) / 2;
  }
  renderRuler();
}
// ruler centre inside the visible stage (it used to be saved as 0,0 = top left when the stage had no size yet)
function rulerVisible(){ const r = prefs.ruler; return r.cx != null && r.cx > 20 && r.cy > 20 && r.cx < W - 20 && r.cy < H - 20; }
function centerRuler(straight){
  if(!(W > 0 && H > 0)) return;
  prefs.ruler.cx = W / 2; prefs.ruler.cy = H / 2;
  if(straight) prefs.ruler.a = 0;
}
// mouse: move with the hand grip, turn with the arrows at the ends
let rulerDrag = null;
for(const h of ['rulerGrip', 'rulerTurnL', 'rulerTurnR']){
  const el = $(h);
  el.addEventListener('pointerdown', e => {
    if(e.button !== 0 || !prefs.ruler.on) return;
    e.stopPropagation(); e.preventDefault();
    const [sx, sy] = pt(e), r = prefs.ruler;
    rulerDrag = {id: e.pointerId, turn: !!el.dataset.turn, sx, sy, r0: {...r}, m0: Math.atan2(sy - r.cy, sx - r.cx)};
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    const d = rulerDrag; if(!d || d.id !== e.pointerId) return;
    e.stopPropagation();
    const [sx, sy] = pt(e), r = prefs.ruler;
    if(d.turn){
      let a = d.r0.a + Math.atan2(sy - d.r0.cy, sx - d.r0.cx) - d.m0;
      const step = Math.PI / 12, snapA = Math.round(a / step) * step;   // clicks into 15° steps
      if(r.snap !== false && Math.abs(a - snapA) < 0.05) a = snapA;
      r.a = Math.atan2(Math.sin(a), Math.cos(a));
    } else { r.cx = d.r0.cx + sx - d.sx; r.cy = d.r0.cy + sy - d.sy; }
    renderRuler();
  });
  const end = e => { if(!rulerDrag || rulerDrag.id !== e.pointerId) return; e.stopPropagation(); rulerDrag = null; savePrefs(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
// (1.50) Snap pill on the ruler: prefs.ruler.snap (missing = on) decides whether turning it (two fingers or the
// turn handles) clicks into 15° steps. A short tap (finger, Pencil or mouse) toggles it.
// (1.50.1) a finger on the pill still counts for moving/turning the ruler (the pill used to swallow it, so a
// two-finger twist with one finger on the pill only dragged the ruler); only a tap that stays put toggles.
{
  const el = $('rulerSnap'); let down = null;
  el.addEventListener('pointerdown', e => {
    if(e.pointerType !== 'touch' || pick || prefs.tool === 'space'){ e.stopPropagation(); e.preventDefault(); }   // Pencil/mouse (or a finger while placing a shape / using Space) would draw instead
    down = {id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), far: false};
  });
  addEventListener('pointermove', e => { if(down && down.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) down.far = true; }, true);
  addEventListener('pointerup', e => {
    if(!down || down.id !== e.pointerId) return;
    const d = down; down = null;
    if(d.far || touches.size > 1 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12 || performance.now() - d.t > 700) return;
    const r = prefs.ruler; r.snap = r.snap === false; savePrefs(); renderRuler();
    note(r.snap ? 'Ruler snap on · clicks into 0°, 15°, 45°, 90°' : 'Ruler snap off · turns to any angle');
  }, true);
  addEventListener('pointercancel', e => { if(down && down.id === e.pointerId) down = null; }, true);
  el.addEventListener('click', e => e.stopPropagation());
}
function renderRuler(){
  const el = $('ruler'), r = prefs.ruler;
  $('rulerSnap').classList.toggle('on', r.snap !== false); $('rulerSnap').setAttribute('aria-pressed', r.snap !== false);
  el.hidden = !r.on || !cur;
  $('rulerBtn').classList.toggle('on', !!r.on);
  if(!r.on) return;
  el.style.transform = `translate(${r.cx}px,${r.cy}px) rotate(${r.a}rad)`;
  el.style.setProperty('--turn-off', Math.round(Math.max(110, Math.min(RULER_HALF_W - 27, W / 2 - 50))) + 'px');   // turn handles stay on narrow screens
  let deg = ((Math.round(r.a * 180 / Math.PI) % 180) + 180) % 180; if(deg > 90) deg -= 180;   // same as shape rotation: clockwise positive, -89 … 90
  $('rulerAngle').textContent = deg + '°';
  if(rulerZ !== cam.z) renderRulerTicks();
}
function renderRulerTicks(){
  rulerZ = cam.z;
  const mm = MM * cam.z, box = $('rulerTicks');
  let every = 1; while(mm * every < 4) every *= 5;
  let h = '';
  for(let i = 0; i * mm <= RULER_HALF_W * 2 - 20; i += every){
    const x = 10 + i * mm, cm = i % 10 === 0, half = i % 5 === 0;
    h += `<i style="left:${x.toFixed(1)}px;height:${cm ? 16 : half ? 11 : 7}px"></i>`;
    if(cm && mm * 10 >= 22) h += `<b style="left:${x.toFixed(1)}px">${i / 10}</b>`;
  }
  box.innerHTML = h;
}
