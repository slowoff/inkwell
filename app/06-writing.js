/* Inkwell app, part 6 of 13: Writing tools: reference line, text boxes, selection and more.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
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
    toast(r.snap ? 'Ruler snaps to 0°, 15°, 45°, 90° …' : 'Ruler snap off: it turns to any angle');
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

/* ---------- lasso and selection ---------- */
let sel = null;
function pip(x, y, poly){
  let inside = false;
  for(let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2){
    const xi = poly[i], yi = poly[i+1], xj = poly[j], yj = poly[j+1];
    if(((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// what is under a tap: (1.63) typed text and formulas first, then ink, then pictures and imported pages. Before,
// a picture came before the ink on it, so a tap on writing over an imported page picked the whole page.
function hitItem(sx, sy, target){
  const back = [];
  const look = el => {
    const it = el && el.closest && el.closest('.it');
    if(!it || !cur.items.has(it.dataset.id)) return null;
    if(worldBack.contains(it)){ if(!back.includes(it.dataset.id)) back.push(it.dataset.id); return null; }
    return it.dataset.id;
  };
  const f = look(target); if(f) return f;
  for(const e2 of document.elementsFromPoint(SR.left + sx, SR.top + sy)){ const id = look(e2); if(id) return id; }
  const [wx, wy] = toWorld(sx, sy), tol = 14 / cam.z;
  const list = [...cur.items.values()].reverse();
  for(const it of list){
    if(it.t !== 's') continue;
    const g = geoOf(it);
    if(wx < g.b[0] - tol || wx > g.b[2] + tol || wy < g.b[1] - tol || wy > g.b[3] + tol) continue;
    const p = it.p, lim = (tol + it.w / 2) ** 2;
    for(let i = 0; i < p.length; i += 3){
      if((p[i] - wx) ** 2 + (p[i+1] - wy) ** 2 <= lim) return it.id;
      if(i + 3 < p.length && segDist2(wx, wy, p[i], p[i+1], p[i+3], p[i+4]) <= lim) return it.id;
    }
  }
  return back[0] || null;
}
/* (1.63) Select tool, Tap mode (prefs.lassoMode 'tap'): tap things to select them, with the Pencil, a finger or the
   mouse. Each tap adds what is under it (with its group); tapping something already selected drops it; tapping empty
   space clears the selection. Drawing a loop still selects like Free. */
const tapPick = () => prefs.tool === 'lasso' && prefs.lassoMode === 'tap';
function tapSelect(sx, sy, target){
  if(!cur) return;
  const id = hitItem(sx, sy, target) || groupAt(sx, sy);
  if(!id){ clearSel(); tapAt(target, sx, sy); return; }
  const ids = withGroups([id]), now = sel ? sel.ids : [];
  if(ids.every(x => now.includes(x))){
    const left = now.filter(x => !ids.includes(x));
    if(left.length) selectIds(left); else clearSel();
  } else selectIds([...new Set([...now, ...ids])]);
}
// (1.53) rectangle as a loop (screen px), once around with 8 points per side so the lasso tests work unchanged
function boxPoly(x0, y0, x1, y1){
  const C = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], out = [];
  for(let i = 0; i < 4; i++){ const [ax, ay] = C[i], [bx, by] = C[(i + 1) % 4]; for(let k = 0; k < 8; k++) out.push(ax + (bx - ax) * k / 8, ay + (by - ay) * k / 8); }
  return out;
}
function finishLasso(a){
  const poly = a.poly;
  if(!a.moved || poly.length < 12){
    if(a.tap){ tapSelect(a.sx, a.sy, a.target); return; }
    const id = hitItem(a.sx, a.sy, a.target) || groupAt(a.sx, a.sy);
    if(id) selectIds([id]); else { clearSel(); tapAt(a.target, a.sx, a.sy); }
    return;
  }
  const wp = [];
  for(let i = 0; i < poly.length; i += 2) wp.push(...toWorld(poly[i], poly[i+1]));
  const ids = [];
  // (1.53) Box mode: the rectangle (world) can also be copied as a picture
  let area = null;
  if(a.box && a.b1){ const [ax, ay] = toWorld(a.sx, a.sy), [bx, by] = toWorld(a.b1[0], a.b1[1]); area = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]; }
  let lb = [Infinity, Infinity, -Infinity, -Infinity];
  for(let i = 0; i < wp.length; i += 2){ lb[0] = Math.min(lb[0], wp[i]); lb[1] = Math.min(lb[1], wp[i+1]); lb[2] = Math.max(lb[2], wp[i]); lb[3] = Math.max(lb[3], wp[i+1]); }
  const lw = lb[2] - lb[0], lh = lb[3] - lb[1];
  for(const it of cur.items.values()){
    if(it.t === 's'){
      const p = it.p, n = p.length / 3, step = Math.max(1, Math.floor(n / 40)) * 3;
      let inside = 0, tot = 0;
      for(let i = 0; i < p.length; i += step){ tot++; if(pip(p[i], p[i+1], wp)) inside++; }
      if(tot && inside / tot >= 0.35) ids.push(it.id);
    } else {
      // boxes (pictures, imported pages, text, formulas) must be mostly inside the loop (1.41.1): before, a loop
      // around writing in the middle of an imported page caught the whole page because its centre was inside
      const b = itemBox(it);
      let n = 0;
      for(const fx of [0.1, 0.5, 0.9]) for(const fy of [0.1, 0.5, 0.9]) if(pip(b[0] + (b[2] - b[0]) * fx, b[1] + (b[3] - b[1]) * fy, wp)) n++;
      // centre inside counts only when the loop is about as big as the item (a loose oval around it)
      const fits = (b[2] - b[0]) * 0.7 <= lw && (b[3] - b[1]) * 0.7 <= lh;
      if(n >= 6 || (fits && pip((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, wp))) ids.push(it.id);
    }
  }
  if(ids.length) selectIds(ids); else clearSel();
  TS.find(wp, lb, area);   // (1.52) text of imported pages inside the loop; (1.53) box area
}
/* Groups: items with the same optional field g move, select and resize as one piece */
function withGroups(ids){
  const gs = new Set(ids.map(id => cur.items.get(id)).filter(it => it && it.g).map(it => it.g));
  if(!gs.size) return ids;
  const out = new Set(ids);
  for(const it of cur.items.values()) if(it.g && gs.has(it.g)) out.add(it.id);
  return [...out];
}
// tapping empty space inside a group (e.g. between the axes of a graph) selects that group
function groupAt(sx, sy){
  const [wx, wy] = toWorld(sx, sy), boxes = new Map();
  for(const it of cur.items.values()){
    if(!it.g) continue;
    const b = itemBox(it), q = boxes.get(it.g);
    boxes.set(it.g, q ? [Math.min(q[0], b[0]), Math.min(q[1], b[1]), Math.max(q[2], b[2]), Math.max(q[3], b[3])] : b.slice());
  }
  let best = null, area = Infinity;
  for(const [g, b] of boxes){ if(wx >= b[0] && wx <= b[2] && wy >= b[1] && wy <= b[3]){ const a = (b[2] - b[0]) * (b[3] - b[1]); if(a < area){ area = a; best = g; } } }
  if(!best) return null;
  for(const it of cur.items.values()) if(it.g === best) return it.id;
  return null;
}
function selectIds(ids){
  ids = withGroups(ids);
  sel = {ids};
  computeSel();
  if(!sel) return;
  $('selBox').hidden = false;
  renderSelColors();
  positionOverlays();
}
function computeSel(){
  if(!sel) return;
  sel.ids = sel.ids.filter(id => cur.items.has(id));
  if(!sel.ids.length){ clearSel(); return; }
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for(const id of sel.ids){ const q = itemBox(cur.items.get(id)); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; }
  sel.b = b;
}
function clearSel(){ sel = null; $('selBox').hidden = true; if(!$('fadePop').hidden) closePop('fadePop'); TS.clear(); }
function transformItem(it, tf){
  if(tf.r !== undefined) return rotateItem(it, tf.r, tf.ax, tf.ay);   // r can be 0 (back to start)
  const m = (x, y) => [tf.ax + (x - tf.ax) * tf.s + tf.dx, tf.ay + (y - tf.ay) * tf.s + tf.dy];
  const o = Object.assign({}, it);
  if(it.t === 's'){
    const p = it.p.slice();
    for(let i = 0; i < p.length; i += 3){ const [x, y] = m(p[i], p[i+1]); p[i] = x; p[i+1] = y; }
    o.p = p; o.w = it.w * tf.s;
  } else {
    [o.x, o.y] = m(it.x, it.y);
    if(it.t === 'x'){ o.w = it.w * tf.s; o.fs = (it.fs || 1) * tf.s; if(it.lh) o.lh = it.lh * tf.s; }
    else if(it.t === 'm'){ o.fs = (it.fs || 24) * tf.s; }
    else { o.w = it.w * tf.s; o.h = it.h * tf.s; }
  }
  return o;
}
// Angle in whole degrees, -179 … 180 (positive = clockwise on screen).
const normDeg = d => { let v = ((Math.round(d) % 360) + 360) % 360; return v > 180 ? v - 360 : v; };
// Rotate by r radians around (ax, ay). Ink and shapes turn; text, formulas, pictures and tape
// move with the selection but stay upright (they have no rotation of their own).
// Strokes remember their total turn in optional field ra (degrees) so the angle shown is the real one.
function rotateItem(it, r, ax, ay){
  const c = Math.cos(r), s = Math.sin(r), rot = (x, y) => [ax + (x - ax) * c - (y - ay) * s, ay + (x - ax) * s + (y - ay) * c];
  const o = Object.assign({}, it);
  if(it.t === 's'){
    const p = it.p.slice();
    for(let i = 0; i < p.length; i += 3){ const [x, y] = rot(p[i], p[i+1]); p[i] = x; p[i+1] = y; }
    o.p = p;
    const ra = normDeg((it.ra || 0) + r * 180 / Math.PI);
    if(ra) o.ra = ra; else delete o.ra;
  } else {
    const b = itemBox(it), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, [nx, ny] = rot(cx, cy);
    o.x = it.x + nx - cx; o.y = it.y + ny - cy;
  }
  return o;
}
const selRect = $('selRect');
selRect.addEventListener('pointerdown', e => {
  if(!sel || !cur) return;
  e.stopPropagation(); e.preventDefault();
  const [sx, sy] = pt(e);
  selDrag = {id: e.pointerId, sx, sy, handle: e.target.id === 'selHandle', rot: !!e.target.closest('#selRot'), orig: sel.ids.map(id => cur.items.get(id)), b: sel.b.slice(), moved: false};
  if(selDrag.rot){
    const b = sel.b; selDrag.cx = (b[0] + b[2]) / 2; selDrag.cy = (b[1] + b[3]) / 2; const [wx, wy] = toWorld(sx, sy); selDrag.a0 = Math.atan2(wy - selDrag.cy, wx - selDrag.cx);
    // angle the selection already has (shown and snapped as a total); mixed angles count from 0
    const ras = new Set(selDrag.orig.filter(it => it && it.t === 's').map(it => it.ra || 0));
    selDrag.base = ras.size === 1 ? [...ras][0] : 0;
    const lab = $('selAng'); lab.hidden = false; lab.textContent = selDrag.base + '°';
  }
  try { selRect.setPointerCapture(e.pointerId); } catch {}
});
selRect.addEventListener('pointermove', e => {
  if(!selDrag || e.pointerId !== selDrag.id) return;
  const [sx, sy] = pt(e);
  if(Math.hypot(sx - selDrag.sx, sy - selDrag.sy) > 2) selDrag.moved = true;
  let tf;
  if(selDrag.rot){
    const [wx, wy] = toWorld(sx, sy);
    const delta = (Math.atan2(wy - selDrag.cy, wx - selDrag.cx) - selDrag.a0) * 180 / Math.PI;
    let tot = selDrag.base + delta;
    tot = ((tot % 360) + 540) % 360 - 180;
    const snap = Math.round(tot / 15) * 15;
    if(prefs.angleSnap !== false && Math.abs(tot - snap) < 4) tot = snap;   // clicks into 15° steps (0, 45, 90 ...) of the total angle; off with Snap to angles (1.51)
    tot = normDeg(tot);                          // whole degrees: what is shown is what is applied
    const lab = $('selAng'); lab.hidden = false; lab.textContent = tot + '°';
    tf = {r: normDeg(tot - selDrag.base) * Math.PI / 180, ax: selDrag.cx, ay: selDrag.cy};
  } else if(selDrag.handle){
    const b = selDrag.b, w0 = (b[2] - b[0]) * cam.z, h0 = (b[3] - b[1]) * cam.z;
    const s = Math.max(0.1, 1 + ((sx - selDrag.sx) + (sy - selDrag.sy)) / Math.max(20, w0 + h0));
    tf = {dx: 0, dy: 0, s, ax: b[0], ay: b[1]};
  } else tf = {dx: (sx - selDrag.sx) / cam.z, dy: (sy - selDrag.sy) / cam.z, s: 1, ax: 0, ay: 0};
  const moved = selDrag.orig.map(it => transformItem(it, tf));
  for(const it of moved){ cur.items.set(it.id, it); if(it.t !== 's') itemEl(it); cur.lastId = it.id; }
  selDrag.cur = moved;
  computeSel(); invalidate(0, 1, 1);
});
const endSelDrag = e => {
  if(!selDrag || e.pointerId !== selDrag.id) return;
  const d = selDrag; selDrag = null;
  $('selAng').hidden = true;
  if(d.moved && d.cur){ commit(d.orig.map(it => [it.id, it]), d.cur.map(it => [it.id, it])); changed(); }
  else if(!d.moved){
    // (1.63) Tap mode: a tap inside the selection adds or drops the thing under it
    if(tapPick() && !d.handle && !d.rot){ tapSelect(d.sx, d.sy, null); return; }
    // tap inside the selection: open a formula or a text box directly
    if(d.orig.length === 1){ const it = d.orig[0]; if(it.t === 'm'){ clearSel(); openMath(it); } else if(it.t === 'x'){ clearSel(); startEditing(it.id); } }
  }
};
selRect.addEventListener('pointerup', endSelDrag);
selRect.addEventListener('pointercancel', endSelDrag);
function renderGroupBtns(){
  const its = sel ? sel.ids.map(id => cur.items.get(id)).filter(Boolean) : [];
  const gs = new Set(its.map(it => it.g || ''));
  const oneGroup = gs.size === 1 && !gs.has('');
  $('selGroup').hidden = its.length < 2 || oneGroup;
  $('selUngroup').hidden = !its.some(it => it.g);
  $('selMath').hidden = !its.some(it => it.t === 's' && !it.hl) || its.some(it => it.t !== 's');
  $('selGraph').hidden = !GAdd.find(its);
  if(!$('selGraph').hidden) $('selMath').hidden = true;
  // (1.59) imported pages and pictures turn in 90° steps with the button (their picture is turned); no free turning
  const pics = its.some(it => it.t === 'i');
  const noRot = its.length === 1 && its[0].t !== 's' && !pics;
  $('selRot90').hidden = noRot; $('selRot').hidden = noRot || pics;
  $('selRot90').title = pics ? 'Turn 90° clockwise (also the pages)' : 'Rotate 90° clockwise';
}
function renderSelColors(){
  renderGroupBtns();
  const box = $('selColors');
  const anyInk = sel && sel.ids.some(id => { const it = cur.items.get(id); return it && (it.t === 's' || it.t === 'm'); });
  box.hidden = !anyInk;
  if(!anyInk) return;
  box.innerHTML = prefs.penFavs.map(c => `<button class="swatch" data-c="${c}" aria-label="Recolour"><span style="--c:${c === 'auto' ? 'var(--fg)' : c}"></span></button>`).join('');
}
$('selColors').addEventListener('click', e => {
  const b = e.target.closest('[data-c]'); if(!b || !sel) return;
  const c = b.dataset.c;
  const list = sel.ids.map(id => cur.items.get(id)).filter(it => it && ((it.t === 's' && !it.fl) || it.t === 'm')).map(it => Object.assign({}, it, {c}));
  if(list.length) replaceItems(list);
});
$('selMath').addEventListener('click', () => strokesToFormula());
// Writing menu (1.42): Write to text and Reference line
function renderAssist(){
  $('waRef').classList.toggle('on', !!prefs.refLine);
  renderOpts();
}
$('assistBtn').addEventListener('click', e => { renderAssist(); renderScribe(); openPop('assistPop', e.currentTarget); });
$('waRef').addEventListener('click', () => { prefs.refLine = !prefs.refLine; savePrefs(); if(cur) cur.wa = null; WA.last = null; drawLiveSoon(); renderAssist(); });
// Fade (1.40): sets the optional o field on everything selected; dragging the slider is one undo step
const withFade = (it, v) => { const o = Object.assign({}, it); if(v >= 0.995) delete o.o; else o.o = Math.round(v * 100) / 100; return o; };
let fadeOrig = null;
const fadeLabel = v => { $('fadeVal').textContent = Math.round(v * 100) + ' %'; };
$('selFade').addEventListener('click', e => {
  if(!sel || !cur) return;
  const its = sel.ids.map(id => cur.items.get(id)).filter(Boolean);
  const v = its.length ? Math.max(...its.map(opOf)) : 1;
  $('fadeRange').value = Math.round(v * 100); fadeLabel(v); fadeOrig = null;
  openPop('fadePop', e.currentTarget);
});
function fadeCommit(){
  if(!fadeOrig || !cur) { fadeOrig = null; return; }
  const after = fadeOrig.map(it => [it.id, cur.items.get(it.id) || null]);
  if(after.some(([id, it], i) => it !== fadeOrig[i])) commit(fadeOrig.map(it => [it.id, it]), after);
  fadeOrig = null;
}
$('fadeRange').addEventListener('input', () => {
  if(!sel || !cur) return;
  const v = clamp(+$('fadeRange').value / 100, 0.1, 1);
  if(!fadeOrig) fadeOrig = sel.ids.map(id => cur.items.get(id)).filter(Boolean);
  setItems(fadeOrig.map(it => [it.id, withFade(it, v)]));
  fadeLabel(v);
});
$('fadeRange').addEventListener('change', fadeCommit);
let picTurning = false;
$('selRot90').addEventListener('click', async () => {
  if(!sel || picTurning) return;
  const b = sel.b, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, page = cur;
  const its = sel.ids.map(id => cur.items.get(id)).filter(Boolean);
  if(!its.some(it => it.t === 'i')){
    replaceItems(its.map(it => rotateItem(it, Math.PI / 2, cx, cy)));
    computeSel(); positionOverlays(); return;
  }
  // (1.59) pages and pictures: the picture itself is turned (a new picture), the box keeps its centre's turned place
  picTurning = true; $('selRot90').classList.add('busy');
  try {
    const out = [];
    for(const it of its){
      if(it.t !== 'i'){ out.push(rotateItem(it, Math.PI / 2, cx, cy)); continue; }
      const u = await assetURL(it.a);
      if(!u) throw new Error('This page picture is not on this device yet');
      const img = new Image(); img.src = u; await img.decode();
      const c = rotCanvas(img, 90), a = await saveAsset(await canvasBlob(c)); c.width = c.height = 1;
      const icx = it.x + it.w / 2, icy = it.y + it.h / 2;
      const nx = cx - (icy - cy), ny = cy + (icx - cx);   // centre turned 90° clockwise around the selection's centre
      const o = Object.assign({}, it, {a, w: it.h, h: it.w, x: nx - it.h / 2, y: ny - it.w / 2});
      if(it.f) o.f = rotFields(it.f, 90);
      out.push(o);
    }
    if(cur !== page) return;
    replaceItems(out); selectIds(out.map(it => it.id));
    PT.soon();
  } catch(e){ console.warn(e); toast('Could not turn: ' + (e.message || e)); }
  finally { picTurning = false; $('selRot90').classList.remove('busy'); }
});
$('selDel').addEventListener('click', () => { if(!sel) return; const ids = sel.ids.slice(); clearSel(); removeItems(ids); });
$('selGroup').addEventListener('click', () => {
  if(!sel) return;
  const g = 'g' + newId();
  replaceItems(sel.ids.map(id => cur.items.get(id)).filter(Boolean).map(it => Object.assign({}, it, {g})));
  selectIds(sel.ids); toast('Grouped: it now moves as one piece');
});
$('selUngroup').addEventListener('click', () => {
  if(!sel) return;
  replaceItems(sel.ids.map(id => cur.items.get(id)).filter(it => it && it.g).map(it => { const o = Object.assign({}, it); delete o.g; return o; }));
  const ids = sel.ids; sel = null; selectIds(ids); toast('Ungrouped: tap a part to select it alone');
});
$('selDup').addEventListener('click', () => {
  if(!sel) return;
  const off = 24 / cam.z, gmap = new Map();
  const copies = sel.ids.map(id => cur.items.get(id)).filter(Boolean).map(it => {
    const o = transformItem(it, {dx: off, dy: off, s: 1, ax: 0, ay: 0});
    o.id = it.id[0] + newId() + Math.random().toString(36).slice(2, 5);
    if(it.g){ if(!gmap.has(it.g)) gmap.set(it.g, 'g' + newId()); o.g = gmap.get(it.g); }
    return o;
  });
  addItems(copies);
  selectIds(copies.map(c => c.id));
});
/* Copy / paste (1.38): Copy in the selection menu keeps the selected items on this device (localStorage
   inkwell.clip, items stored like in content docs), so they can be pasted on any page with Paste in the
   Select tool's bar or Ctrl/Cmd+V. Pictures keep their asset id, so nothing is uploaded twice. */
const Clip = {
  get(){ const c = LSget('inkwell.clip', null); return c && Array.isArray(c.items) && c.items.length && Array.isArray(c.b) ? c : null; },
  copy(){
    if(!sel || !cur) return;
    computeSel(); if(!sel) return;
    const items = sel.ids.map(id => cur.items.get(id)).filter(Boolean).map(ser);
    try { localStorage.setItem('inkwell.clip', JSON.stringify({at: Date.now(), page: cur.id, b: sel.b, items})); }
    catch { toast('Too much to copy at once'); return; }
    toast(items.length === 1 ? 'Copied' : 'Copied ' + items.length + ' items', 'Paste', () => Clip.paste());
    // (1.53) the system clipboard gets the typed text of the selection (or a short note), so Ctrl+V knows that the
    // newest copy is this one and other apps get something useful
    const txt = items.filter(it => it.t === 'x').map(it => htmlText(it.html)).join('\n').trim() || ('Inkwell: ' + (items.length === 1 ? '1 item' : items.length + ' items'));
    Paste.note(txt);
    try { navigator.clipboard.writeText(txt).catch(() => {}); } catch {}
    renderOpts();
  },
  paste(){
    const c = Clip.get();
    if(!cur || !c){ toast('Nothing copied yet'); return; }
    const b = c.b, bw = b[2] - b[0], bh = b[3] - b[1];
    const [vx0, vy0] = toWorld(0, 0), [vx1, vy1] = toWorld(W, H);
    const inView = (b[0] + b[2]) / 2 > vx0 && (b[0] + b[2]) / 2 < vx1 && (b[1] + b[3]) / 2 > vy0 && (b[1] + b[3]) / 2 < vy1;
    let dx, dy;
    if(c.page === cur.id && inView){ dx = dy = 24 / cam.z; }   // same spot is on screen: put the copy just beside it
    else { const [cx, cy] = toWorld(W / 2, H / 2); dx = cx - (b[0] + bw / 2); dy = cy - (b[1] + bh / 2); }
    if(prefs.leftEdge && b[0] + dx < 0) dx = -b[0];
    const gmap = new Map();
    const copies = c.items.map(deser).filter(it => it && it.t && it.id).map(it => {
      const o = transformItem(it, {dx, dy, s: 1, ax: 0, ay: 0});
      o.id = it.id[0] + newId() + Math.random().toString(36).slice(2, 5);
      if(it.g){ if(!gmap.has(it.g)) gmap.set(it.g, 'g' + newId()); o.g = gmap.get(it.g); }
      return o;
    });
    if(!copies.length){ toast('Nothing copied yet'); return; }
    if(prefs.tool !== 'lasso') setTool('lasso');
    addItems(copies);
    selectIds(copies.map(o => o.id));
  }
};
$('selCopy').addEventListener('click', () => Clip.copy());
/* (1.53) Paste from other apps: pictures (screenshots, photos) become a picture on the page, text a text box.
   Ctrl/Cmd+V (paste event; falls back to the async clipboard if the browser sends none) and the Paste button of the
   Select tool. Inkwell's own copy (Clip) wins when the system clipboard still holds what Clip.copy put there. */
const Paste = {
  note(t){ try { localStorage.setItem('inkwell.clipSys', JSON.stringify(t)); } catch {} },
  away: 0,   // last time Inkwell lost focus (another app may have put something on the clipboard since)
  sysAt: 0,  // (1.53.1) last copy to the system clipboard made inside Inkwell (page text, Copy as picture, text in a box)
  mark(){ this.sysAt = Date.now(); this.note(null); },
  noted(){ return LSget('inkwell.clipSys', null); },
  got: 0,
  async handle(images, text){
    if(!cur){ toast('Open a page first'); return; }
    text = (text || '').replace(/\r\n?/g, '\n');
    const mine = Clip.get(), n = this.noted();
    if(mine && (n !== null && text.trim() === String(n).trim() && !images.length || !images.length && !text.trim())){ Clip.paste(); return; }
    if(images.length){
      const ids = [];
      let at = null;
      for(const b of images){ const it = await this.image(b, at, null, true); if(it){ ids.push(it.id); at = [it.x, it.y + it.h + 16 / cam.z]; } }
      if(ids.length){ setTool('lasso'); selectIds(ids); toast(ids.length === 1 ? 'Picture pasted' : ids.length + ' pictures pasted'); }
      return;
    }
    if(text.trim()){
      const [cx, cy] = toWorld(W / 2, H / 2), w = Math.min(460, W * 0.6 / cam.z);
      const html = cleanHTML(text.replace(/\n+$/, '').split('\n').map(l => '<p>' + (esc(l) || '<br>') + '</p>').join(''));
      const it = {t: 'x', id: 'x' + newId(), x: cx - w / 2, y: cy - 40, w, fs: 1, html};
      addItems([it]); setTool('lasso'); selectIds([it.id]); toast('Text pasted');
      return;
    }
    toast('Nothing to paste');
  },
  // picture blob → picture item; at = top left (world), wWorld = width (world); default: centred, 70 % of the view
  async image(blob, at, wWorld, quiet){
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch { if(!quiet) toast('That picture could not be read'); return null; }
    let w0 = bmp.width, h0 = bmp.height, out = blob;
    const k = Math.min(1, 2400 / Math.max(w0, h0));
    if(k < 1 || blob.size > 4e6 || !/^image\/(png|jpeg)$/.test(blob.type)){
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
      out = blob.type === 'image/png' && c.width * c.height < 3e6 ? await new Promise(r => c.toBlob(r, 'image/png')) : await canvasBlob(c);
      c.width = c.height = 1;
    }
    if(bmp.close) bmp.close();
    const a = await saveAsset(out);
    const w = wWorld || Math.min(w0 / (window.devicePixelRatio > 1 ? 2 : 1), W * 0.7) / cam.z, h = w * h0 / w0;
    let x, y;
    if(at){ [x, y] = at; } else { const [cx, cy] = toWorld(W / 2, H / 2); x = cx - w / 2; y = cy - h / 2; }
    if(prefs.leftEdge && x < 0) x = 0;
    const it = {t: 'i', id: 'i' + newId(), x, y, w, h, a};
    addItems([it]);
    if(!quiet){ setTool('lasso'); selectIds([it.id]); }
    return it;
  },
  // Paste button / no paste event: read the clipboard (iPad shows its own small Paste bubble first)
  async read(){
    const mine = Clip.get();
    // copied in Inkwell and never left it since: paste that right away (no iPad Paste bubble, no clipboard read)
    if(mine && mine.at > this.away && mine.at > this.sysAt){ Clip.paste(); return; }
    if(!navigator.clipboard){ if(mine) Clip.paste(); else toast('Nothing to paste'); return; }
    const late = ms => new Promise((_, no) => setTimeout(() => no(new Error('clipboard timeout')), ms));
    try {
      if(navigator.clipboard.read){
        const items = await Promise.race([navigator.clipboard.read(), late(8000)]), imgs = []; let text = '';
        for(const ci of items){
          const it = ci.types.find(t => /^image\//.test(t));
          if(it) imgs.push(await ci.getType(it));
          else if(!text && ci.types.includes('text/plain')) text = await (await ci.getType('text/plain')).text();
        }
        return this.handle(imgs, text);
      }
      return this.handle([], await Promise.race([navigator.clipboard.readText(), late(8000)]));
    } catch(e){
      console.warn('paste', e);
      if(Clip.get()) Clip.paste(); else toast('Pasting was not allowed. Try again and tap Paste when the iPad asks.');
    }
  }
};
$('pasteBtn').addEventListener('click', () => Paste.read());
addEventListener('blur', () => { Paste.away = Date.now(); });
document.addEventListener('copy', () => Paste.mark(), true);
document.addEventListener('cut', () => Paste.mark(), true);
document.addEventListener('visibilitychange', () => { if(document.hidden) Paste.away = Date.now(); });
document.addEventListener('paste', e => {
  const t = e.target, ae = document.activeElement, catcher = $('pasteCatch');
  const caught = t === catcher || ae === catcher;
  if(caught) setTimeout(() => catcher.blur(), 0);
  const typing = !caught && ((t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) || (ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))));
  if(typing || editing || !cur) return;
  const dt = e.clipboardData; if(!dt) return;
  e.preventDefault(); Paste.got = Date.now();
  const imgs = [...(dt.files || [])].filter(f => /^image\//.test(f.type));
  if(!imgs.length) for(const i of dt.items || []) if(i.kind === 'file' && /^image\//.test(i.type)){ const f = i.getAsFile(); if(f) imgs.push(f); }
  Paste.handle(imgs, dt.getData('text/plain'));
});
$('selMenu').addEventListener('pointerdown', e => e.stopPropagation());

/* ---------- taps ---------- */
function tapAt(target, sx, sy){
  if(!cur) return;
  const cx = SR.left + sx, cy = SR.top + sy;
  const link = target && target.closest && target.closest('a.pl');
  if(link){ navGuard = Date.now(); followLink(link.dataset.page); return; }
  const itEl = target && target.closest && target.closest('.it');
  const id = itEl && itEl.dataset.id, it = id && cur.items.get(id);
  if(it){
    if(it.t === 'tp'){ itEl.classList.toggle('open'); return; }
    if(it.t === 'x'){
      const li = target.closest('ul.check > li');
      if(li && cx - li.getBoundingClientRect().left < 28 * cam.z * (it.fs || 1)){
        li.classList.toggle('done');
        const html = cleanHTML(itEl.innerHTML);
        itEl._html = html;
        apply([[id, Object.assign({}, it, {html})]], [[id, it]]);
        return;
      }
      startEditing(id, cx, cy);
      return;
    }
    if(it.t === 'm'){ openMath(it); return; }
  }
  const wasEditing = !!editing;
  if(editing) finishEditing();
  clearSel();
  closePops();
  // (1.44.1) with the Text or Formula tool a finger tap places a box too (before, only the Pencil could);
  // a tap that just closes the box being typed in does not start a new one
  if(!wasEditing && (prefs.tool === 'text' || prefs.tool === 'math')) placeAt({tool: prefs.tool, sx, sy, target, w0: toWorld(sx, sy)});
}

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

/* ---------- text boxes ---------- */
let editing = null, keepEditing = false;
// A text box that sits in the table cell or on the answer line at world point (wx, wy), or null (Snap text to lines)
function snapBoxAt(wx, wy, pf, id){
  if(!prefs.snapLines) return null;
  const cell = snapCellAt(wx, wy);
  const sn = !cell ? snapLineAt(wx, wy) : null;
  if(cell){
    // inside a table cell: one line filling the cell, text shrinks to fit as it is typed (fitCell)
    const ch = Math.round((cell.y2 - cell.y1 - 2) * 100) / 100, F = clamp(pf ? Math.min(pf, ch * 0.62) : ch * 0.62, 6, 28);
    return {t: 'x', id, x: cell.x1 - 3, y: cell.y1 - 1, w: Math.max(30, cell.x2 - cell.x1 + 6), fs: F / 17, fs0: F / 17, lh: ch, ch, html: ''};
  }
  if(sn){
    // sit on the answer line; every further line of text lands on the next ruled line
    const F = sn.f ? clamp(sn.f, 6, 60) : clamp(sn.d * 0.55, 8, 40);
    const lh = Math.round((sn.rep ? sn.d : Math.max(sn.d, F * 1.35)) * 100) / 100;
    // on a ruled line the letters sit just above it; on a dotted line they stand on the dots, like the printed words
    const base = sn.yb ? sn.yb : sn.y - 2 - F * 0.2;
    return {t: 'x', id, x: sn.x1 - 6 + (sn.yb ? F * 0.3 : 0), y: base - baselineOf(F, lh), w: Math.max(60, sn.x2 - sn.x1 + 12), fs: F / 17, lh, html: ''};
  }
  return null;
}
function placeAt(a){
  const id = hitItem(a.sx, a.sy, a.target), it = id && cur.items.get(id);
  if(a.tool === 'text'){
    if(it && it.t === 'x'){ startEditing(id, SR.left + a.sx, SR.top + a.sy); return; }
    if(it && it.t === 'm'){ openMath(it); return; }
    // (1.43) on an imported page, new text is as big as the page's printed text
    const pf = prefs.snapLines ? pageTextAt(a.w0[0], a.w0[1]) : 0;
    const fs = pf ? clamp(pf / 17, 0.25, 6) : clamp(1 / cam.z, 0.25, 6);
    let nt = {t: 'x', id: 'x' + newId(), x: a.w0[0] - 4 * fs, y: a.w0[1] - 16 * fs, w: clamp((W - a.sx - 16) / cam.z, 160 * fs, 460 * fs), fs, html: ''};
    const snapped = snapBoxAt(a.w0[0], a.w0[1], pf, nt.id);
    if(snapped) nt = snapped;
    cur.items.set(nt.id, nt); cur.lastId = nt.id;
    itemEl(nt); refreshPaper();
    startEditing(nt.id, null, null, true);
  } else if(a.tool === 'math'){
    if(it && it.t === 'm'){ openMath(it); return; }
    openMath(null, a.w0);
  }
}
function startEditing(id, cx, cy, isNew){
  if(editing && editing.id !== id) finishEditing();
  const el = elMap.get(id), it = cur.items.get(id);
  if(!el || !it) return;
  clearSel();
  if(!editing) editing = {id, before: it, isNew: !!isNew, since: Date.now()};
  el.contentEditable = 'true';
  el.focus({preventScroll: true});
  if(it.ch && !isNew){ fitCell(id); saveContentSoon(); }   // (1.44.1) a cell box squeezed by older versions is redone when tapped
  const s = getSelection();
  let r = null;
  if(cx != null){
    if(document.caretRangeFromPoint) r = document.caretRangeFromPoint(cx, cy);
    else if(document.caretPositionFromPoint){ const p = document.caretPositionFromPoint(cx, cy); if(p){ r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); } }
    if(r && !el.contains(r.startContainer)) r = null;
  }
  if(!r){ r = document.createRange(); r.selectNodeContents(el); r.collapse(false); }
  s.removeAllRanges(); s.addRange(r);
  Spell.set(el);
  renderFmt();
  stickColor();
  invalidate(0, 0, 1);
}
function syncEditingHTML(){
  if(!editing) return;
  const el = elMap.get(editing.id), it = cur && cur.items.get(editing.id);
  if(!el || !it) return;
  const html = el.innerHTML;
  if(html !== it.html){ cur.items.set(it.id, Object.assign({}, it, {html})); el._html = html; cur.lastId = it.id; }
}
function finishEditing(){
  if(!editing || !cur) { editing = null; return; }
  const ed = editing; editing = null;
  renderFmt(); tHandle.hidden = true; tMove.hidden = true; closePop('tcolorPop'); closePop('tsizePop');
  const el = elMap.get(ed.id);
  if(!el) return;
  el.removeAttribute('contenteditable');
  if(document.activeElement === el) el.blur();
  const it = cur.items.get(ed.id);
  if(!it) return;
  if(!ed.isNew && it === ed.before){ invalidate(0, 0, 1); return; }   // nothing typed, formatted or resized: not an edit
  const empty = !el.textContent.trim() && !el.querySelector('a.pl');
  if(empty){
    cur.items.delete(ed.id); dropEl(ed.id);
    if(!ed.isNew) commit([[ed.id, ed.before]], [[ed.id, null]]);
    changed(); return;
  }
  const html = cleanHTML(el.innerHTML);
  const nit = Object.assign({}, it, {html});
  cur.items.set(ed.id, nit); el._html = html; if(html !== it.html) cur.lastId = ed.id;
  prepTextEl(el);
  if(ed.isNew) commit([[ed.id, null]], [[ed.id, nit]]);
  else if(ed.before.html !== html || ed.before.w !== nit.w || ed.before.x !== nit.x || ed.before.y !== nit.y) commit([[ed.id, ed.before]], [[ed.id, nit]]);
  changed();
}
let typeColor = null;   // (1.58.6) colour picked with nothing selected, for the text typed next
function fixTypeColor(el){
  if(!typeColor || !el) return;
  let hit = false;
  el.querySelectorAll('[style],font[color]').forEach(n => {
    const v = (n.style.color || (n.tagName === 'FONT' ? n.getAttribute('color') : '') || '').replace(/\s/g, '').toLowerCase();
    if(v !== 'rgb(254,1,253)' && v !== '#fe01fd') return;
    if(n.tagName === 'FONT') n.removeAttribute('color');
    n.style.color = typeColor.c || '';
    if(!n.getAttribute('style')) n.removeAttribute('style');
    hit = true;
  });
  if(hit) typeColor = null;
}
worldFront.addEventListener('input', e => {
  if(!editing) return;
  fixTypeColor(elMap.get(editing.id));
  syncEditingHTML();
  fitCell(editing.id);
  lastLocalEdit = Date.now();
  saveContentSoon();
  invalidate(0, 0, 1);
});
worldFront.addEventListener('focusout', () => {
  setTimeout(() => {
    if(!editing || keepEditing || tmDrag) return;   // moving the box with its hand keeps it open
    const el = elMap.get(editing.id);
    if(el && (document.activeElement === el || el.contains(document.activeElement))) return;
    finishEditing();
  }, 120);
});
let navGuard = 0;
worldFront.addEventListener('click', e => {
  const a = e.target.closest('a.pl');
  if(a){ e.preventDefault(); if(Date.now() - navGuard > 700) followLink(a.dataset.page); return; }
  if(!editing || Date.now() - editing.since < 400) return;
  const li = e.target.closest('ul.check > li');
  if(li && e.clientX - li.getBoundingClientRect().left < 28 * cam.z){ li.classList.toggle('done'); syncEditingHTML(); saveContentSoon(); }
});
// (1.48) Tab in a text box types a tab (jumps to the next tab stop) instead of leaving the box; Shift+Tab removes
// the tab right before the cursor. The tab sits in a white-space:pre span, which cleanHTML keeps.
worldFront.addEventListener('keydown', e => {
  if(!editing || e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  if(e.shiftKey){
    const s = getSelection(); if(!s.rangeCount || !s.isCollapsed) return;
    const r = s.getRangeAt(0); let n = r.startContainer, o = r.startOffset;
    if(n.nodeType === 3 && o > 0 && n.data[o - 1] === '\t'){ document.execCommand('delete'); return; }
    if(n.nodeType === 3 && o === 0){ const sp = n.parentNode && n.parentNode.previousSibling; if(sp && sp.nodeType === 1 && sp.classList.contains('tab')){ sp.remove(); syncEditingHTML(); saveContentSoon(); invalidate(0, 0, 1); } }
    else if(n.nodeType === 1 && o > 0){ const sp = n.childNodes[o - 1]; if(sp && sp.nodeType === 1 && sp.classList.contains('tab')){ sp.remove(); syncEditingHTML(); saveContentSoon(); invalidate(0, 0, 1); } }
    return;
  }
  document.execCommand('insertHTML', false, '<span class="tab" style="white-space:pre">\t</span>');
});
worldFront.addEventListener('paste', e => {
  if(!editing) return;
  e.preventDefault();
  const t = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, t);
});
try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}

/* text width handle */
let thDrag = null;
tHandle.addEventListener('pointerdown', e => {
  if(!editing) return;
  e.preventDefault(); e.stopPropagation();
  const it = cur.items.get(editing.id);
  thDrag = {id: e.pointerId, x: e.clientX, w0: it.w};
  tHandle.setPointerCapture(e.pointerId);
});
tHandle.addEventListener('pointermove', e => {
  if(!thDrag || e.pointerId !== thDrag.id || !editing) return;
  const it = cur.items.get(editing.id);
  const w = Math.max(60, thDrag.w0 + (e.clientX - thDrag.x) / cam.z);
  const nit = Object.assign({}, it, {w});
  cur.items.set(it.id, nit);
  elMap.get(it.id).style.width = w + 'px';
  invalidate(0, 0, 1);
});
tHandle.addEventListener('pointerup', () => { thDrag = null; saveContentSoon(); });

/* text move grip (1.45): the box keeps being edited while it moves; finishEditing makes it one undo step */
// (1.58.1) Moving a text box by its hand. On the iPad, touch events drive the drag (finger and Pencil both send them):
// cancelling touchmove stops Scribble (iPadOS handwriting) from taking the Pencil near the focused box, and the
// move is tracked on the whole document, so it keeps going when the hand moves away from under the finger.
// Pointer events drive it for the mouse (and as a fallback when no touch events come).
let tmDrag = null;   // {src: 'touch'|'ptr', id, x, y, x0, y0}
function tmStart(src, id, cx, cy){
  if(!editing || !cur) return false;
  const it = cur.items.get(editing.id); if(!it) return false;
  tmDrag = {src, id, x: cx, y: cy, x0: it.x, y0: it.y};
  tMove.classList.add('on');
  return true;
}
function tmTo(cx, cy){
  if(!tmDrag || !editing || !cur) return;
  const it = cur.items.get(editing.id), el = elMap.get(editing.id);
  if(!it || !el) return;
  const nit = Object.assign({}, it, {x: tmDrag.x0 + (cx - tmDrag.x) / cam.z, y: tmDrag.y0 + (cy - tmDrag.y) / cam.z});
  cur.items.set(it.id, nit);
  el.style.left = nit.x + 'px'; el.style.top = nit.y + 'px'; frontXf(el);
  invalidate(0, 0, 1);
}
function tmStop(){
  if(!tmDrag) return;
  tmDrag = null; tMove.classList.remove('on'); saveContentSoon();
  if(editing){ const el = elMap.get(editing.id); if(el) el.focus({preventScroll: true}); }
}
const tmTouch = (e, id) => [...e.changedTouches].find(t => t.identifier === id);
tMove.addEventListener('touchstart', e => {
  e.preventDefault(); e.stopPropagation();   // keeps the keyboard and the box open, no mouse/click events afterwards
  const t = e.changedTouches[0]; if(!t) return;
  if(tmDrag && tmDrag.src === 'touch') return;
  if(tmDrag) tmDrag = null;   // the pointer path started first: touch takes over
  tmStart('touch', t.identifier, t.clientX, t.clientY);
}, {passive: false});
document.addEventListener('touchmove', e => {
  if(!tmDrag || tmDrag.src !== 'touch') return;
  const t = tmTouch(e, tmDrag.id); if(!t) return;
  e.preventDefault();   // no Scribble, no scrolling
  tmTo(t.clientX, t.clientY);
}, {passive: false, capture: true});
const tmTouchEnd = e => { if(tmDrag && tmDrag.src === 'touch' && tmTouch(e, tmDrag.id)) tmStop(); };
document.addEventListener('touchend', tmTouchEnd, true);
document.addEventListener('touchcancel', tmTouchEnd, true);
tMove.addEventListener('pointerdown', e => {
  if(!editing) return;
  e.preventDefault(); e.stopPropagation();
  if(tmDrag) return;   // a touch drag is already running
  if(tmStart('ptr', e.pointerId, e.clientX, e.clientY)){ try { tMove.setPointerCapture(e.pointerId); } catch {} }
});
document.addEventListener('pointermove', e => {
  if(!tmDrag || tmDrag.src !== 'ptr' || e.pointerId !== tmDrag.id) return;
  e.preventDefault();
  tmTo(e.clientX, e.clientY);
}, true);
const tmEnd = e => { if(tmDrag && tmDrag.src === 'ptr' && e.pointerId === tmDrag.id) tmStop(); };
document.addEventListener('pointerup', tmEnd, true);
document.addEventListener('pointercancel', tmEnd, true);

/* formatting bar */
const fmtBar = $('fmtBar');
fmtBar.addEventListener('pointerdown', e => { if(e.target.closest('button')) e.preventDefault(); });
fmtBar.addEventListener('mousedown', e => { if(e.target.closest('button')) e.preventDefault(); });
function selList(root){
  let n = getSelection().anchorNode;
  while(n && n !== root){ if(n.nodeName === 'UL' || n.nodeName === 'OL') return n; n = n.parentNode; }
  return null;
}
function inside(tag, root){
  let n = getSelection().anchorNode;
  while(n && n !== root){ if(n.nodeName === tag) return n; n = n.parentNode; }
  return null;
}
function applySentinelColor(kind, color, root){
  // execCommand writes literal colours; mark the selection with a sentinel colour and rewrite it.
  const SENT = 'rgb(254, 1, 253)';
  document.execCommand('styleWithCSS', false, true);
  document.execCommand(kind === 'mark' ? 'hiliteColor' : 'foreColor', false, SENT);
  document.execCommand('styleWithCSS', false, false);
  const prop = kind === 'mark' ? 'backgroundColor' : 'color';
  root.querySelectorAll('[style],font[color]').forEach(el => {
    const v = (el.style[prop] || (el.tagName === 'FONT' ? el.getAttribute('color') : '') || '').replace(/\s/g, '').toLowerCase();
    if(v !== 'rgb(254,1,253)' && v !== '#fe01fd') return;
    if(kind === 'mark'){
      el.style.backgroundColor = '';
      const m = document.createElement('mark');
      m.append(...el.childNodes); el.append(m);
    } else {
      if(el.tagName === 'FONT') el.removeAttribute('color');
      el.style.color = color || '';
    }
    if(!el.getAttribute('style')) el.removeAttribute('style');
    if((el.tagName === 'SPAN' || el.tagName === 'FONT') && !el.attributes.length) el.replaceWith(...el.childNodes);
  });
}
fmtBar.addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  if(!editing && pfFocus){ PFmt.click(b); return; }
  if(!editing) return;
  const el = elMap.get(editing.id); if(!el) return;
  if(document.activeElement !== el) el.focus({preventScroll: true});
  if(b.dataset.cmd) document.execCommand(b.dataset.cmd);
  else if(b.dataset.block) document.execCommand('formatBlock', false, '<' + b.dataset.block + '>');
  else if(b.dataset.act === 'bullet'){
    const ul = selList(el);
    if(ul && ul.classList.contains('check')) ul.classList.remove('check');
    else document.execCommand('insertUnorderedList');
  } else if(b.dataset.act === 'check'){
    let ul = selList(el);
    if(ul && ul.classList.contains('check')) document.execCommand('insertUnorderedList');
    else {
      if(!ul || ul.nodeName !== 'UL'){ document.execCommand('insertUnorderedList'); ul = selList(el); }
      if(ul && ul.nodeName === 'UL') ul.classList.add('check');
    }
  } else if(b.dataset.act === 'mark'){
    const m = inside('MARK', el);
    if(m) m.replaceWith(...m.childNodes);
    else if(!getSelection().isCollapsed) applySentinelColor('mark', null, el);
  } else if(b.dataset.act === 'tcolor'){
    openPop('tcolorPop', b); return;
  } else if(b.dataset.act === 'tsize'){
    TSize.open(b); return;
  } else if(b.dataset.act === 'link'){
    openLinkPicker(); return;
  } else if(b.dataset.act === 'spell'){
    Spell.toggle(el); return;
  } else if(b.dataset.act === 'done'){
    finishEditing(); return;
  }
  syncEditingHTML(); saveContentSoon(); invalidate(0, 0, 1);
});
const TEXT_COLORS = ['', '#1F4FCF', '#C2362B', '#167A3C', '#E07A10', '#7B3FBF', '#0E8C8C', '#8A97A4'];
$('tpalette').innerHTML = TEXT_COLORS.map(c => `<button data-tc="${c}" style="--c:${c || 'var(--fg)'}" aria-label="${c ? 'Colour ' + c : 'Default colour'}"></button>`).join('');
$('tcolorPop').addEventListener('pointerdown', e => e.preventDefault());
$('tcolorPop').addEventListener('click', e => {
  const b = e.target.closest('[data-tc]'); if(!b) return;
  pickTColor(b.dataset.tc || '');
});
function pickTColor(tc){
  if(!editing && pfFocus){ closePop('tcolorPop'); PFmt.set({c: tc}); return; }
  if(!editing) return;
  const el = elMap.get(editing.id);
  const b = {dataset: {tc}};
  // (1.58.7) the picked colour stays for all writing (also new boxes) until another one is picked (prefs textC)
  prefs.textC = b.dataset.tc || ''; savePrefs(); renderTColor();
  if(!getSelection().isCollapsed) applySentinelColor('color', b.dataset.tc, el);
  else {
    // (1.58.6) nothing selected: what is typed next gets the colour (typing style marked with the sentinel colour,
    // turned into the real colour on the next input)
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, 'rgb(254, 1, 253)');
    document.execCommand('styleWithCSS', false, false);
    typeColor = {c: b.dataset.tc};
  }
  closePop('tcolorPop');
  syncEditingHTML(); saveContentSoon();
}
// (1.58.9) Custom colour for text: the system colour picker takes the focus, so the text box (or PDF field) and its
// selection are kept and put back when a colour is chosen
let tcKeep = null;
$('tCustom').addEventListener('pointerdown', e => e.stopPropagation());
$('tcolorPop').querySelector('.custom-color').addEventListener('click', () => {
  const cur0 = prefs.textC || '';
  $('tCustom').value = /^#[0-9a-f]{6}$/i.test(cur0) ? cur0 : '#1f4fcf';
  if(editing){ const el = elMap.get(editing.id); tcKeep = {el, sel: TSize.offsets(el)}; keepEditing = true; }
  else if(pfFocus) tcKeep = {pf: pfFocus};
});
function tcBack(){
  const k = tcKeep; tcKeep = null; keepEditing = false;
  if(!k) return false;
  if(k.pf){ pfFocus = k.pf; if(k.pf.c.isConnected) k.pf.c.focus({preventScroll: true}); return true; }
  if(editing && k.el && k.el.isConnected){ k.el.focus({preventScroll: true}); TSize.restore(k.el, k.sel); return true; }
  return false;
}
$('tCustom').addEventListener('change', () => {
  const c = $('tCustom').value.toUpperCase();
  if(!tcBack()){ prefs.textC = c; savePrefs(); renderTColor(); return; }   // the box closed meanwhile: keep the colour for the next writing
  pickTColor(c);
});
$('tCustom').addEventListener('blur', () => setTimeout(() => { if(tcKeep && document.activeElement !== $('tCustom')){ tcBack(); } }, 300));

/* (1.54) text size dropdown in the formatting bar. Sizes are world px (17 = the normal size of a text box).
   Selected text gets <span style="font-size:Npx">; with nothing selected the whole box changes size;
   an empty box changes its own size (fs), so what is typed next comes out at that size.
   Plain inline styles: older app versions show them as they are, nothing new is stored. */
const TEXT_SIZES = [10, 12, 14, 17, 20, 24, 28, 32, 40, 48, 64];
const TSize = {
  // size (world px) at the cursor, or at the start of the selection
  at(el){
    const s = getSelection();
    let n = s.rangeCount && el.contains(s.anchorNode) ? s.anchorNode : el;
    if(s.rangeCount && !s.isCollapsed){
      // first character actually selected (the start often sits at the very end of the text before it)
      const r = s.getRangeAt(0), w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for(let t = w.nextNode(); t; t = w.nextNode()){
        if(!r.intersectsNode(t) || !t.length) continue;
        if(t === r.startContainer && r.startOffset >= t.length) continue;
        if(t === r.endContainer && r.endOffset === 0) continue;
        n = t; break;
      }
    }
    if(n.nodeType !== 1) n = n.parentNode;
    if(!n || !el.contains(n)) n = el;
    return Math.round(parseFloat(getComputedStyle(n).fontSize) || 17);
  },
  label(){
    if(!editing){ if(pfFocus) $('tsizeVal').textContent = PFmt.size(); return; }
    const el = elMap.get(editing.id); if(!el) return;
    $('tsizeVal').textContent = TSize.at(el);
  },
  open(b){
    const el = !editing && pfFocus ? null : elMap.get(editing.id);
    if(!el && !pfFocus) return;
    const now = el ? TSize.at(el) : PFmt.size();
    $('tsizeList').innerHTML = TEXT_SIZES.map(px => `<button data-px="${px}" class="${px === now ? 'on' : ''}"><span>${px}${px === 17 ? '<small>normal</small>' : ''}</span><span class="aa" style="font-size:${Math.min(px, 30)}px">Aa</span></button>`).join('');
    openPop('tsizePop', b);
    const on = $('tsizeList').querySelector('.on');
    if(on) on.scrollIntoView({block: 'nearest'});
  },
  // character offsets of the selection inside el (to put it back after the box is rewritten; the text itself never changes)
  offsets(el){
    const s = getSelection(); if(!s.rangeCount) return null;
    const r = s.getRangeAt(0); if(!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
    const at = (n, o) => { const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(n, o); return pre.toString().length; };
    return [at(r.startContainer, r.startOffset), at(r.endContainer, r.endOffset)];
  },
  restore(el, o){
    const s = getSelection(), r = document.createRange();
    const point = off => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let left = off, last = null;
      for(let t = w.nextNode(); t; t = w.nextNode()){ if(left <= t.length) return [t, left]; left -= t.length; last = t; }
      return last ? [last, last.length] : null;
    };
    const a = o && point(o[0]), b = o && point(o[1]);
    if(a && b){ r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); }
    else { r.selectNodeContents(el); r.collapse(false); }
    s.removeAllRanges(); s.addRange(r);
  },
  apply(px){
    if(!editing || !cur) return;
    const el = elMap.get(editing.id), it = cur.items.get(editing.id);
    if(!el || !it) return;
    if(document.activeElement !== el) el.focus({preventScroll: true});
    const s = getSelection();
    if(!el.textContent.trim() && !el.querySelector('a.pl')){
      // empty box: the box itself gets the size
      const fs = Math.round(px / 17 * 1000) / 1000;
      el.querySelectorAll('[style]').forEach(n => { n.style.fontSize = ''; if(!n.getAttribute('style')) n.removeAttribute('style'); });
      const html = el.innerHTML;
      cur.items.set(it.id, Object.assign({}, it, {fs, html}, it.ch ? {fs0: fs} : {}));
      el._html = html;
      el.style.fontSize = px + 'px';
      if(it.ch) fitCell(it.id);
      saveContentSoon(); invalidate(0, 0, 1); TSize.label();
      return;
    }
    const whole = !s.rangeCount || s.isCollapsed || !el.contains(s.anchorNode) || !el.contains(s.focusNode);
    const keep = TSize.offsets(el);
    if(whole){ const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }
    // execCommand only knows sizes 1..7: mark with size 7, then turn the new marks into a px size
    const before = new Map([...el.querySelectorAll('font[size]')].map(f => [f, f.getAttribute('size')]));
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    const marks = [...el.querySelectorAll('font[size="7"]')].filter(f => before.get(f) !== '7');
    for(const f of marks){
      // whatever was sized inside before takes the new size
      f.querySelectorAll('[style]').forEach(n => { n.style.fontSize = ''; if(!n.getAttribute('style')) n.removeAttribute('style'); });
      f.querySelectorAll('font[size]').forEach(n => n.removeAttribute('size'));
      f.removeAttribute('size');
      let n = f;
      if(f.attributes.length === 0 || (f.attributes.length === 1 && f.hasAttribute('style'))){
        n = document.createElement('span');
        if(f.getAttribute('style')) n.setAttribute('style', f.getAttribute('style'));
        n.append(...f.childNodes); f.replaceWith(n);
      }
      n.style.fontSize = px + 'px';
      // the mark fills an older size span completely: give that span the size instead of nesting
      for(let q = n.parentElement; q && q !== el && el.contains(q) && q.textContent === n.textContent; q = q.parentElement){
        if(!q.style.fontSize) continue;
        q.style.fontSize = px + 'px';
        if(n.tagName === 'SPAN' && n.style.length === 1){ n.replaceWith(...n.childNodes); }
        else { n.style.fontSize = ''; if(!n.getAttribute('style')) n.removeAttribute('style'); }
        break;
      }
    }
    // with the whole box picked, headings and list items keep no older inline size either
    if(whole) el.querySelectorAll('[style]').forEach(n => { if(n.parentNode && !n.closest('span[style*="font-size"],font[style*="font-size"]')) { n.style.fontSize = ''; if(!n.getAttribute('style')) n.removeAttribute('style'); } });
    // tidy: a size span directly inside another of the same size is merged away
    el.querySelectorAll('span[style]').forEach(n => {
      const p = n.parentElement && n.parentElement.closest('[style]');
      if(n.style.length === 1 && n.style.fontSize && p && el.contains(p) && p !== el && p.style.fontSize === n.style.fontSize) n.replaceWith(...n.childNodes);
    });
    TSize.restore(el, whole && keep ? [keep[1], keep[1]] : keep);
    syncEditingHTML(); fitCell(editing.id); saveContentSoon(); invalidate(0, 0, 1); TSize.label();
  }
};
$('tsizePop').addEventListener('pointerdown', e => { if(e.target.closest('button')) e.preventDefault(); });
$('tsizePop').addEventListener('mousedown', e => { if(e.target.closest('button')) e.preventDefault(); });
$('tsizePop').addEventListener('click', e => {
  const b = e.target.closest('[data-px]'); if(!b) return;
  closePop('tsizePop');
  if(!editing && pfFocus){ PFmt.set({s: +b.dataset.px}); return; }
  TSize.apply(+b.dataset.px);
});
document.addEventListener('selectionchange', () => { if(editing && !$('fmtBar').hidden){ TSize.label(); stickColor(); } });
// (1.55) the formatting bar sits in the tool bar: shown with the Text tool (greyed until a box is being typed in)
// (1.58.7) the line under A shows the colour that will be written
function renderTColor(){
  const a = fmtBar.querySelector('.tcolor-a'); if(a) a.style.setProperty('--tc', prefs.textC || 'var(--fg)');
}
const hexRgbStr = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if(!m) return ''; const n = parseInt(m[1], 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
// keep writing in the chosen colour: when the cursor sits in text of another colour, the next typed text gets it
function stickColor(){
  if(!editing || !prefs.textC) return;
  const el = elMap.get(editing.id), s = getSelection();
  if(!el || !s.rangeCount || !s.isCollapsed || !el.contains(s.anchorNode) || document.activeElement !== el) return;
  let n = s.anchorNode; if(n.nodeType !== 1) n = n.parentNode;
  const want = hexRgbStr(prefs.textC), now = getComputedStyle(n).color;
  if(!want || now === want || now === 'rgb(254, 1, 253)') return;
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('foreColor', false, 'rgb(254, 1, 253)');
  document.execCommand('styleWithCSS', false, false);
  typeColor = {c: prefs.textC};
}
function renderFmt(){
  renderTColor();
  const fld = !editing && !!pfFocus;
  const show = prefs.tool === 'text' || !!editing || fld;
  fmtBar.hidden = !show;
  fmtBar.classList.toggle('idle', !editing && !fld);
  fmtBar.classList.toggle('field', fld);
  if(editing || fld) TSize.label(); else $('tsizeVal').textContent = '17';
  const f = fld && PFmt.f();
  fmtBar.querySelectorAll('[data-cmd]').forEach(b => b.classList.toggle('on', !!f && !!f[{bold: 'b', italic: 'it', underline: 'u'}[b.dataset.cmd]]));
  Spell.render();
  barFade();
}
// (1.55) spell check while typing (prefs `spell`, missing = on, per device). Underlines come from the system:
// on the iPad its keyboard language(s) and Settings → General → Keyboard → Check Spelling decide what is marked
const Spell = {
  on(){ return prefs.spell !== false; },
  set(el){
    const on = Spell.on();
    el.spellcheck = on;
    el.setAttribute('autocorrect', on ? 'on' : 'off');
  },
  render(){ const b = fmtBar.querySelector('[data-act="spell"]'); if(b){ b.classList.toggle('on', Spell.on()); b.setAttribute('aria-pressed', Spell.on() ? 'true' : 'false'); } },
  toggle(el){
    prefs.spell = !Spell.on(); savePrefs();
    document.querySelectorAll('input.pf-tx, textarea.pf-tx').forEach(c => { c.spellcheck = Spell.on(); });
    if(el){
      Spell.set(el);
      // re-check the text with the new setting: browsers only redraw the marks after the box is focused again
      const keep = TSize.offsets(el);
      el.blur(); el.focus({preventScroll: true});
      TSize.restore(el, keep);
    }
    Spell.render();
    toast(Spell.on() ? 'Spell check on: misspelled words are underlined while you type' : 'Spell check off');
  }
};
// (1.56) the formatting bar on a PDF text field: bold, italic, underline, size and colour of the whole field
const PFmt = {
  item(){ return pfFocus && cur ? cur.items.get(pfFocus.id) : null; },
  f(){ const it = PFmt.item(); return it && it.f ? it.f[pfFocus.i] : null; },
  size(){ const it = PFmt.item(), f = PFmt.f(); return it && f ? Math.round(fieldFont(f, it)) : 17; },
  set(p){
    const it = PFmt.item(), f = PFmt.f(); if(!it || !f) return;
    const nf = Object.assign({}, f);
    if('s' in p) nf.s = Math.round(p.s / it.w * 1e7) / 1e7;
    for(const k of ['b', 'it', 'u']) if(k in p){ if(p[k]) nf[k] = 1; else delete nf[k]; }
    if('c' in p){ if(p.c) nf.c = p.c; else delete nf.c; }
    const list = it.f.slice(); list[pfFocus.i] = nf;
    const nit = Object.assign({}, it, {f: list});
    if(!pfEdit || pfEdit.id !== nit.id) pfEdit = {id: nit.id, before: it};
    setItems([[nit.id, nit]]);
    pfCommit();   // one undo step per change
    saveContentSoon();
    if(document.activeElement !== pfFocus.c && pfFocus.c.isConnected) pfFocus.c.focus({preventScroll: true});
    renderFmt();
  },
  click(b){
    const f = PFmt.f(); if(!f) return;
    if(b.dataset.cmd){ const k = {bold: 'b', italic: 'it', underline: 'u'}[b.dataset.cmd]; if(k) PFmt.set({[k]: !f[k]}); return; }
    const a = b.dataset.act;
    if(a === 'tsize') TSize.open(b);
    else if(a === 'tcolor') openPop('tcolorPop', b);
    else if(a === 'spell'){ Spell.toggle(null); const c = pfFocus.c; c.blur(); c.focus({preventScroll: true}); }
    else if(a === 'done') pfFocus.c.blur();
  }
};

/* ---------- formulas ---------- */
const MATH_KEYS = [
  ['\\frac{a}{b}', '\\frac{|}{}'], ['\\sqrt{x}', '\\sqrt{|}'], ['\\sqrt[n]{x}', '\\sqrt[|]{}'], ['x^{n}', '^{|}'], ['x_{n}', '_{|}'],
  ['\\cdot', '\\cdot '], ['\\pm', '\\pm '], ['\\le', '\\le '], ['\\ge', '\\ge '], ['\\ne', '\\ne '], ['\\approx', '\\approx '],
  ['\\Rightarrow', '\\Rightarrow '], ['\\pi', '\\pi '], ['\\infty', '\\infty '], ['\\alpha', '\\alpha '], ['\\Delta', '\\Delta '],
  ['\\omega', '\\omega '], ['^\\circ', '^\\circ '], ['\\vec{v}', '\\vec{|}'], ['\\sum', '\\sum_{|}^{}'], ['\\int', '\\int_{|}^{} \\, dx'],
  ['\\lim', '\\lim_{x \\to |}'], ['\\left( \\right)', '\\left(|\\right)'], ['\\text{m/s}', '\\,\\text{|}']
];
$('mathKeys').innerHTML = MATH_KEYS.map(([l], i) => {
  let label = esc(l);
  try { label = katex.renderToString(l, {throwOnError: false}); } catch {}
  return `<button type="button" data-k="${i}">${label}</button>`;
}).join('');
let mathEdit = null;
function openMath(it, pos){
  if(editing) finishEditing();
  mathEdit = {it, pos};
  $('mathIn').value = it ? it.tex : '';
  $('mathSize').value = Math.round(it ? it.fs : clamp(24 / cam.z, 14, 64));
  $('mathDel').hidden = !it;
  mathPreview();
  showModal('mathDlg');
  setTimeout(() => $('mathIn').focus(), 60);
}
function mathPreview(){
  const pv = $('mathPreview'), tex = $('mathIn').value;
  $('mathSizeVal').textContent = $('mathSize').value + ' px';
  pv.style.fontSize = Math.min(+$('mathSize').value, 40) + 'px';
  pv.classList.remove('err', 'empty');
  if(!tex.trim()){ pv.textContent = 'Preview'; pv.classList.add('empty'); return; }
  try { katex.render(tex, pv, {throwOnError: true, displayMode: true}); }
  catch(e){ pv.textContent = String(e.message || e).replace(/^KaTeX parse error: /, ''); pv.classList.add('err'); }
}
$('mathIn').addEventListener('input', mathPreview);
$('mathSize').addEventListener('input', mathPreview);
$('mathKeys').addEventListener('click', e => {
  const b = e.target.closest('[data-k]'); if(!b) return;
  const ins = MATH_KEYS[+b.dataset.k][1], ta = $('mathIn');
  const s = ta.selectionStart, en = ta.selectionEnd, before = ta.value.slice(0, s), sel2 = ta.value.slice(s, en), after = ta.value.slice(en);
  const i = ins.indexOf('|');
  const text = ins.replace('|', sel2);
  ta.value = before + text + after;
  const caret = before.length + (i >= 0 ? i + sel2.length : text.length);
  ta.focus(); ta.setSelectionRange(caret, caret);
  mathPreview();
});
$('mathOk').addEventListener('click', () => {
  const tex = $('mathIn').value.trim(), fs = +$('mathSize').value, m = mathEdit;
  hideModal('mathDlg'); mathEdit = null;
  if(!m || !cur) return;
  if(!tex){ if(m.it) removeItems([m.it.id]); return; }
  if(m.it) replaceItems([Object.assign({}, m.it, {tex, fs})]);
  else addItems([{t: 'm', id: 'm' + newId(), x: m.pos[0], y: m.pos[1] - fs * 0.8, tex, fs, c: 'auto'}]);
});
$('mathDel').addEventListener('click', () => { const m = mathEdit; hideModal('mathDlg'); mathEdit = null; if(m && m.it) removeItems([m.it.id]); });

/* ---------- overlays ---------- */
function positionOverlays(){
  TS.place();
  if(sel && cur){
    computeSel();
    if(sel){
      const b = sel.b, x = b[0] * cam.z + cam.ox - 8, y = b[1] * cam.z + cam.oy - 8;
      const w = (b[2] - b[0]) * cam.z + 16, h = (b[3] - b[1]) * cam.z + 16;
      Object.assign(selRect.style, {left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px'});
      const m = $('selMenu'), mw = m.offsetWidth || 260, mh = m.offsetHeight || 46;
      let my = y - mh - 10;
      if(my < 8) my = y + h + 22;
      if(my > H - mh - 8) my = clamp(y + 8, 8, H - mh - 8);
      m.style.left = clamp(x + w / 2 - mw / 2, 8, Math.max(8, W - mw - 8)) + 'px';
      m.style.top = my + 'px';
    }
  }
  if(editing){
    const el = elMap.get(editing.id);
    if(el){
      const r = el.getBoundingClientRect(), x = r.left - SR.left, y = r.top - SR.top;
      tHandle.hidden = false;
      tHandle.style.left = (x + r.width - 5) + 'px';
      tHandle.style.top = (y + Math.min(r.height / 2, 40) - 16) + 'px';
      tMove.hidden = false;
      tMove.style.left = (x - 40) + 'px';
      tMove.style.top = (y + Math.min(r.height / 2, 40) - 17) + 'px';
    }
  }
  if(prefs.ruler.on && rulerZ !== cam.z) renderRulerTicks();
}
