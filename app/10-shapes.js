/* Inkwell app, part 10 of 13: Box picking, shapes, graphs, Word documents.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
/* =====================================================================
   Box picking: draw a box on the page to place a shape or scan a question
   ===================================================================== */
let pick = null;   // {kind: 'shape', shape} | {kind: 'scan'}
function startPick(p, msg){
  if(!cur){ toast('Open a page first'); return; }
  clearSel(); pick = p; stage.classList.add('picking');
  if(p.kind === 'scan'){
    // the Claude panel steps aside so the whole page is visible; a bar at the bottom says what to do
    $('askPanel').classList.add('away'); document.body.classList.add('scanning');
    $('scanBarText').textContent = msg || 'Drag a box around the question';
    $('scanBar').hidden = false; $('toast').hidden = true;
  } else if(msg) toast(msg);
}
function endPick(){
  pick = null; stage.classList.remove('picking');
  $('askPanel').classList.remove('away'); document.body.classList.remove('scanning'); $('scanBar').hidden = true;
}
function pickBox(a){
  const [x0, y0] = a.w0, [x1, y1] = a.w1 || a.w0;
  return {x0, y0, x1, y1, tap: Math.abs(x1 - x0) * cam.z < 10 && Math.abs(y1 - y0) * cam.z < 10, a0: a.cmp ? a.cmp.a0 : null, sweep: a.cmp ? a.cmp.sweep : 0};
}
// Compass: once the pointer is a little away from the centre, add up how far it has gone around (radians, either way)
function compassTrack(a){
  if(!pick || pick.shape !== 'compass' || !a.w1) return;
  const dx = a.w1[0] - a.w0[0], dy = a.w1[1] - a.w0[1];
  if(Math.hypot(dx, dy) * cam.z < 14) return;
  const ang = Math.atan2(dy, dx);
  if(!a.cmp){ a.cmp = {a0: ang, prev: ang, sweep: 0}; return; }
  let d = ang - a.cmp.prev;
  if(d > Math.PI) d -= 2 * Math.PI; else if(d < -Math.PI) d += 2 * Math.PI;
  a.cmp.sweep += d; a.cmp.prev = ang;
}
// [cx, cy, r, start angle, sweep]; a sweep under 15° or past 345° is a full circle
function compassGeo(b){
  if(b.tap || b.a0 == null) return [b.x0, b.y0, b.tap ? 60 / cam.z : Math.hypot(b.x1 - b.x0, b.y1 - b.y0), 0, 2 * Math.PI];
  const r = Math.hypot(b.x1 - b.x0, b.y1 - b.y0), s = Math.abs(b.sweep);
  if(s < Math.PI / 12 || s > Math.PI * 23 / 12) return [b.x0, b.y0, r, b.a0, 2 * Math.PI];
  return [b.x0, b.y0, r, b.a0, b.sweep];
}
function moveSpace(dy){
  act.dy = dy;
  if(act.orig.length) setItems(act.orig.map(it => [it.id, dy ? transformItem(it, {ax: 0, ay: 0, s: 1, dx: 0, dy}) : it]));
}
function finishPick(a){
  const p = pick; endPick();
  if(!p) return;
  const b = pickBox(a);
  if(p.kind === 'shape') insertShape(p.shape, b);
  else if(p.kind === 'scan'){
    if(b.tap){ startPick(p, 'Drag a box, not just a tap, around the question'); return; }
    Ask.scan(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
  }
}
function drawPickPreview(a){
  liveCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
  if(pick && pick.kind === 'shape'){
    const b = pickBox(a);
    liveCtx.fillStyle = inkColor(prefs.pen.c, false, false);
    for(const it of shapeItems(pick.shape, b)) liveCtx.fill(strokePath(it, false));
    if(pick.shape === 'compass'){
      // needle point, dashed radius line and the radius in cm (paper scale, as on the ruler)
      const [cx, cy, r] = compassGeo(b), ex = b.x1, ey = b.y1;
      liveCtx.strokeStyle = tokens.accent; liveCtx.fillStyle = tokens.accent; liveCtx.lineWidth = 1.5 / cam.z;
      liveCtx.setLineDash([6 / cam.z, 5 / cam.z]); liveCtx.beginPath(); liveCtx.moveTo(cx, cy); liveCtx.lineTo(ex, ey); liveCtx.stroke(); liveCtx.setLineDash([]);
      liveCtx.beginPath(); liveCtx.arc(cx, cy, 3.5 / cam.z, 0, Math.PI * 2); liveCtx.fill();
      liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sx = ex * cam.z + cam.ox, sy = ey * cam.z + cam.oy, txt = 'r = ' + (r / MM / 10).toFixed(1).replace('.', ',') + ' cm';
      liveCtx.font = '600 13px system-ui, sans-serif'; const tw = liveCtx.measureText(txt).width;
      // outside the circle, past the pointer, so it never sits on the line or under the hand
      const d = Math.hypot(ex - cx, ey - cy) || 1;
      const lx = clamp(sx + (ex - cx) / d * (tw / 2 + 26), tw / 2 + 10, W - tw / 2 - 10), ly = clamp(sy + (ey - cy) / d * 30, 16, H - 16);
      liveCtx.fillStyle = tokens.accent; liveCtx.fillRect(lx - tw / 2 - 6, ly - 11, tw + 12, 22);
      liveCtx.fillStyle = '#fff'; liveCtx.fillText(txt, lx - tw / 2, ly + 5);
    }
  } else {
    const x = Math.min(a.w0[0], a.w1[0]), y = Math.min(a.w0[1], a.w1[1]), w = Math.abs(a.w1[0] - a.w0[0]), h = Math.abs(a.w1[1] - a.w0[1]);
    liveCtx.globalAlpha = 0.08; liveCtx.fillStyle = tokens.accent; liveCtx.fillRect(x, y, w, h); liveCtx.globalAlpha = 1;
    liveCtx.setLineDash([6 / cam.z, 5 / cam.z]); liveCtx.lineWidth = 1.5 / cam.z; liveCtx.strokeStyle = tokens.accent; liveCtx.strokeRect(x, y, w, h); liveCtx.setLineDash([]);
  }
}

/* =====================================================================
   Shapes (inserted as ink strokes, so lasso, recolour, eraser and sync all just work)
   ===================================================================== */
function polyPts(V, closed, step = 2.5){
  const out = [], pts = closed ? V.concat([V[0]]) : V;
  for(let i = 0; i < pts.length - 1; i++){
    const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(dist(a, b) / step));
    for(let k = 0; k < n; k++) out.push(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, 0.55);
  }
  const l = pts[pts.length - 1]; out.push(l[0], l[1], 0.55);
  return out;
}
function arrowHead(from, tip, size){
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]), s = 0.45;
  return [[tip[0] - size * Math.cos(ang - s), tip[1] - size * Math.sin(ang - s)], tip, [tip[0] - size * Math.cos(ang + s), tip[1] - size * Math.sin(ang + s)]];
}
const LINE_SHAPES = ['line', 'arrow', 'darrow', 'spring', 'dline'];
// Returns the polylines of a shape: [[points, closed], ...]
function shapePolys(shape, b, w){
  if(shape === 'compass'){
    const [cx, cy, r, a0, sw] = compassGeo(b), full = Math.abs(sw) >= 2 * Math.PI - 1e-9;
    if(r * cam.z < 2) return [];
    const n = Math.max(24, Math.ceil(Math.abs(sw) * r / 2.5)), V = [];
    for(let i = 0; i < (full ? n : n + 1); i++){ const t = a0 + sw * i / n; V.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
    return [[V, full]];
  }
  if(shape === 'grid'){
    // (1.69) outer frame + inner row and column lines; a tap makes cells of 56 × 36 screen px around the tap
    const [nr, nc] = gridRC();
    let L, T, R, B;
    if(b.tap){ const cw = 56 / cam.z, ch = 36 / cam.z; L = b.x0 - cw * nc / 2; T = b.y0 - ch * nr / 2; R = L + cw * nc; B = T + ch * nr; }
    else { L = Math.min(b.x0, b.x1); T = Math.min(b.y0, b.y1); R = Math.max(b.x0, b.x1); B = Math.max(b.y0, b.y1); }
    if((R - L) * cam.z < 4 || (B - T) * cam.z < 4) return [];
    const out = [[[[L, T], [R, T], [R, B], [L, B]], true]];
    for(let i = 1; i < nr; i++){ const y = T + (B - T) * i / nr; out.push([[[L, y], [R, y]], false]); }
    for(let j = 1; j < nc; j++){ const x = L + (R - L) * j / nc; out.push([[[x, T], [x, B]], false]); }
    return out;
  }
  let {x0, y0, x1, y1} = b;
  const line = LINE_SHAPES.includes(shape);
  if(b.tap){
    const d = 120 / cam.z;
    if(line){ x0 -= d / 2; x1 = x0 + d; y1 = y0; } else { x0 -= d / 2; y0 -= d / 2; x1 = x0 + d; y1 = y0 + d * (shape === 'rect' ? 0.66 : 1); }
  }
  if(line){
    // snap the angle to 15° steps when close
    let len = Math.hypot(x1 - x0, y1 - y0), ang = Math.atan2(y1 - y0, x1 - x0);
    const sn = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
    if(prefs.angleSnap !== false && Math.abs(sn - ang) < 0.06){ ang = sn; x1 = x0 + len * Math.cos(ang); y1 = y0 + len * Math.sin(ang); }
    const p0 = [x0, y0], p1 = [x1, y1], hs = clamp(Math.max(10, w * 5), 0, len * 0.45);
    if(shape === 'line') return [[[p0, p1], false]];
    if(shape === 'arrow') return [[[p0, p1], false], [arrowHead(p0, p1, hs), false]];
    if(shape === 'darrow') return [[[p0, p1], false], [arrowHead(p0, p1, hs), false], [arrowHead(p1, p0, hs), false]];
    if(shape === 'dline'){
      const out = [], dash = Math.max(6, w * 4), gap = dash * 0.7;
      for(let t = 0; t < len; t += dash + gap){ const e = Math.min(len, t + dash); out.push([[[x0 + Math.cos(ang) * t, y0 + Math.sin(ang) * t], [x0 + Math.cos(ang) * e, y0 + Math.sin(ang) * e]], false]); }
      return out;
    }
    // spring: straight ends, zigzag middle
    const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux, amp = clamp(len * 0.07, 5, 18), lead = len * 0.12, coils = Math.max(4, Math.round((len - 2 * lead) / (amp * 1.1)));
    const P = [p0, [x0 + ux * lead, y0 + uy * lead]];
    for(let i = 0; i < coils; i++){ const t = lead + (len - 2 * lead) * (i + 0.5) / coils, sgn = i % 2 ? -1 : 1; P.push([x0 + ux * t + nx * amp * sgn, y0 + uy * t + ny * amp * sgn]); }
    P.push([x1 - ux * lead, y1 - uy * lead], p1);
    return [[P, false]];
  }
  let L = Math.min(x0, x1), T = Math.min(y0, y1), R = Math.max(x0, x1), B = Math.max(y0, y1);
  let bw = R - L, bh = B - T;
  if(Math.abs(bw - bh) < 0.08 * Math.max(bw, bh)){ const m = Math.max(bw, bh); bw = bh = m; if(x1 < x0) L = R - m; else R = L + m; if(y1 < y0) T = B - m; else B = T + m; }
  const cx = (L + R) / 2, cy = (T + B) / 2;
  if(shape === 'rect') return [[[[L, T], [R, T], [R, B], [L, B]], true]];
  if(shape === 'ellipse'){ const V = []; for(let i = 0; i < 96; i++){ const t = i / 96 * Math.PI * 2; V.push([cx + bw / 2 * Math.cos(t), cy + bh / 2 * Math.sin(t)]); } return [[V, true]]; }
  if(shape === 'triangle') return [[[[cx, T], [R, B], [L, B]], true]];
  if(shape === 'rtri') return [[[[L, T], [L, B], [R, B]], true]];
  if(shape === 'diamond') return [[[[cx, T], [R, cy], [cx, B], [L, cy]], true]];
  if(shape === 'hexagon') return [[[[L + bw * 0.25, T], [R - bw * 0.25, T], [R, cy], [R - bw * 0.25, B], [L + bw * 0.25, B], [L, cy]], true]];
  if(shape === 'star'){
    const V = [];
    for(let i = 0; i < 10; i++){ const r = i % 2 ? 0.4 : 1, t = -Math.PI / 2 + i * Math.PI / 5; V.push([cx + bw / 2 * r * Math.cos(t), cy + bh / 2 * r * Math.sin(t) + bh * 0.05]); }
    return [[V, true]];
  }
  return [];
}
function shapeItems(shape, b){
  const w = penWidth(), polys = shapePolys(shape, b, w), g = polys.length > 1 ? 'g' + newId() : null;
  return polys.map(([V, closed]) => { const it = {t: 's', id: 's' + newId() + Math.random().toString(36).slice(2, 5), c: prefs.pen.c, w, hl: 0, p: polyPts(V, closed)}; if(g) it.g = g; return it; });
}
function insertShape(shape, b){
  const items = shapeItems(shape, b);
  if(!items.length) return;
  addItems(items);
  setTool('lasso'); selectIds(items.map(it => it.id));
}
// (1.69) Grid maker: rows × columns remembered per device in prefs.grid = {r, c} (1–30 each, default 3 × 4)
const GRID_MAX = 30;
function gridRC(){
  const g = prefs.grid && typeof prefs.grid === 'object' ? prefs.grid : {};
  const f = (v, d) => { v = Math.round(+v); return v >= 1 && v <= GRID_MAX ? v : d; };
  return [f(g.r, 3), f(g.c, 4)];
}
function renderGrid(){
  const [r, c] = gridRC();
  $('gridR').textContent = r; $('gridC').textContent = c; $('gridSize').textContent = r + ' × ' + c;
  for(const st of $('gridSteps').querySelectorAll('.stepper')){
    const v = st.dataset.k === 'r' ? r : c;
    st.querySelector('[data-d="-1"]').disabled = v <= 1; st.querySelector('[data-d="1"]').disabled = v >= GRID_MAX;
  }
}
$('gridSteps').addEventListener('click', e => {
  const bt = e.target.closest('button[data-d]'); if(!bt || bt.disabled) return;
  const [r, c] = gridRC(), k = bt.closest('.stepper').dataset.k, d = +bt.dataset.d;
  prefs.grid = {r: k === 'r' ? clamp(r + d, 1, GRID_MAX) : r, c: k === 'c' ? clamp(c + d, 1, GRID_MAX) : c};
  savePrefs(); renderGrid();
});
// (1.69.1) the rows/columns only show after pressing Grid (Rafael: "make me press grid before the size option appear");
// Draw grid then starts drawing. Folded again each time the Shapes menu opens.
function showGridPanel(on){
  $('gridPanel').hidden = !on; $('gridOpen').classList.toggle('on', on); $('gridOpen').setAttribute('aria-expanded', on ? 'true' : 'false');
}
$('gridOpen').addEventListener('click', () => {
  showGridPanel($('gridPanel').hidden);
  if(!$('shapePop').hidden) openPopAgain('shapePop', $('shapeBtn'));   // re-place: the menu got taller or shorter
});
$('gridDraw').addEventListener('click', () => {
  closePops();
  const [r, c] = gridRC();
  startPick({kind: 'shape', shape: 'grid'}, `Drag a box on the page for a grid of ${r} × ${c}. Tap for a standard size.`);
});
renderGrid();
$('shapeBtn').addEventListener('click', e => { if(!cur){ toast('Open a page first'); return; } renderSnapShapes(); renderGrid(); showGridPanel(false); openPop('shapePop', e.currentTarget); });
$('shapeGrid').addEventListener('click', e => {
  const b = e.target.closest('button[data-shape]'); if(!b) return;
  closePops();
  startPick({kind: 'shape', shape: b.dataset.shape}, 'Drag on the page to draw the ' + (b.title || 'shape').toLowerCase());
});
$('compassOpen').addEventListener('click', () => {
  closePops();
  startPick({kind: 'shape', shape: 'compass'}, 'Put the point on the centre, drag out to the radius, then go around for an arc. Let go without going around for a full circle.');
});

/* =====================================================================
   Graphs: axes with ticks, numbers, grid and an optional plotted function
   ===================================================================== */
function labelTex(s){
  s = String(s || '').trim();
  if(!s) return '';
  if(/[\\^_{}]/.test(s) || /^[a-zA-Z](\s*\(\s*[a-zA-Z]\s*\))?$/.test(s)) return s;
  // "v in m/s" -> italic variable + upright rest
  const m = /^([a-zA-Z])(\s+.*|\s*[\[(].*)$/.exec(s);
  const txt = t => '\\text{' + t.replace(/[\\{}$&#%~^_]/g, '') + '}';
  return m ? m[1] + '\\ ' + txt(m[2].trim()) : txt(s);
}
const fmtNum = v => { const r = Math.round(v * 1e6) / 1e6; return String(r).replace('-', '-'); };
// Look (1.40), o.look: size (scale), axC (axes + labels colour), fnC / fnW / fnS (curve colour, width factor,
// 'solid' | 'dash' | 'dot'), gridO / allO (fade in %, 10–100), arrows. Missing = the look from before 1.40.
const GRAPH_LOOK = {size: 1, axC: 'auto', fnC: '#1F4FCF', fnW: 1.15, fnS: 'solid', gridO: 100, allO: 100, arrows: true};
// cuts a polyline into dashes along its length: [[points], …]
function dashPolys(V, dash, gap){
  const out = []; let cur = [V[0]], on = true, left = dash;
  for(let i = 1; i < V.length; i++){
    let a = V[i - 1]; const b = V[i]; let d = dist(a, b);
    while(d > left){
      const t = left / d, m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if(on){ cur.push(m); out.push(cur); } else cur = [m];
      on = !on; d -= left; a = m; left = on ? dash : gap;
    }
    left -= d; if(on) cur.push(b);
  }
  if(on && cur.length > 1) out.push(cur);
  return out;
}
// size of a formula item as it is drawn (box incl. its padding), measured once per text and size
const texBoxes = new Map();
function texBox(tex, fs){
  const k = fs + '|' + tex;
  if(texBoxes.has(k)) return texBoxes.get(k);
  let r = [String(tex).replace(/\\/g, '').length * fs * 0.55 + 12, fs * 1.25 + 8];
  try {
    const el = document.createElement('div');
    el.className = 'it it-math';
    el.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;font-size:${fs}px`;
    katex.render(tex, el, {throwOnError: true, displayMode: true});
    worldFront.appendChild(el);
    if(el.offsetWidth) r = [el.offsetWidth, el.offsetHeight];
    el.remove();
  } catch(e){}
  texBoxes.set(k, r);
  return r;
}
function buildGraph(o, gx, gy){
  const L = Object.assign({}, GRAPH_LOOK, o.look || {}), S = L.size > 0 ? L.size : 1;
  const items = [], w = penWidth(), axisC = L.axC || 'auto', id = p => p + newId() + Math.random().toString(36).slice(2, 5);
  const grp = 'g' + newId();
  const stroke = (V, c = axisC, ww = w, op = 1) => { const it = {t: 's', id: id('s'), c, w: ww, hl: 0, p: polyPts(V, false)}; if(op < 1) it.o = op; items.push(it); };
  const formula = (tex, x, y, fs) => { if(tex) items.push({t: 'm', id: id('m'), x, y, tex, fs, c: axisC}); };
  const hs = Math.max(10, w * 5);
  const arrow = (from, tip) => { if(L.arrows !== false) stroke(arrowHead(from, tip, hs)); };
  const finish = () => {
    if(L.bg){
      // (1.57) solid background in the page colour under the whole graph (grid, axes, numbers, labels)
      let b = null;
      for(const it of items){
        const q = it.t === 's' ? strokeBox(it) : [it.x, it.y, it.x + Math.max(1, texPlain(it.tex).length) * it.fs * 0.62, it.y + it.fs * 1.45];
        b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q;
      }
      if(b){
        const m = 10 * S, x0 = b[0] - m, y0 = b[1] - m, x1 = b[2] + m, y1 = b[3] + m;
        items.unshift({t: 's', id: id('s'), c: 'paper', w: 1, hl: 0, fl: 1, p: polyPts([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, Math.max(8, (x1 - x0) / 16))});
      }
    }
    const all = clamp((+L.allO || 100) / 100, 0.1, 1);
    items.forEach(it => { it.g = grp; it.ne = 1; if(all < 1){ const v = Math.round(opOf(it) * all * 100) / 100; it.o = Math.max(0.05, v); } });
    return items;
  };
  if(o.type === '3d'){
    const Ox = gx + 120 * S, Oy = gy + 200 * S, Ln = 210 * S;
    const ends = {y: [Ox + Ln, Oy], z: [Ox, Oy - Ln], x: [Ox - Ln * 0.55, Oy + Ln * 0.55]};
    for(const k of ['x', 'y', 'z']){
      const e = ends[k];
      stroke([[Ox, Oy], e]); arrow([Ox, Oy], e);
      for(let i = 1; i <= 4; i++){
        const t = i / 5, px = Ox + (e[0] - Ox) * t, py = Oy + (e[1] - Oy) * t;
        if(k === 'z') stroke([[px - 4, py], [px + 4, py]]); else stroke([[px, py - 4], [px, py + 4]]);
      }
    }
    formula(labelTex(o.ly), ends.y[0] + 6, ends.y[1] + 4, 18);
    formula(labelTex(o.lz), ends.z[0] + 10, ends.z[1] - 6, 18);
    formula(labelTex(o.lx), ends.x[0] - 26, ends.x[1] - 6, 18);
    return finish();
  }
  const GW = 380 * S, GH = 270 * S;
  let {x0, x1, xs, y0, y1, ys} = o;
  const X = v => gx + (v - x0) / (x1 - x0) * GW, Y = v => gy + GH - (v - y0) / (y1 - y0) * GH;
  const ax = X(clamp(0, x0, x1)), ay = Y(clamp(0, y0, y1));
  const ticks = (a, b, st) => { const out = []; if(!(st > 0)) return out; const n0 = Math.ceil(a / st - 1e-9), n1 = Math.floor(b / st + 1e-9); if(n1 - n0 > 200) return out; for(let n = n0; n <= n1; n++) out.push(n * st); return out; };
  const tx = ticks(x0, x1, xs), ty = ticks(y0, y1, ys);
  if(o.grid){
    const go = clamp((+L.gridO || 100) / 100, 0.1, 1);
    for(const v of tx) if(Math.abs(X(v) - ax) > 0.5) stroke([[X(v), Y(y0)], [X(v), Y(y1)]], '#8A97A4', w * 0.45, go);
    for(const v of ty) if(Math.abs(Y(v) - ay) > 0.5) stroke([[X(x0), Y(v)], [X(x1), Y(v)]], '#8A97A4', w * 0.45, go);
  }
  const xe = [X(x1) + 22, ay], ye = [ax, Y(y1) - 22];
  // (1.58) the two axis lines remember the graph's ranges (ga), so formulas can be added later (Add formula);
  // the mapping is read from their current points, so it still fits after the graph is moved, resized or turned
  const gid = 'gr' + newId(), fw0 = w * (L.fnW > 0 ? L.fnW : 1.15);
  stroke([[X(x0), ay], xe]); items[items.length - 1].ga = {id: gid, k: 'x', v0: x0, v1: x1, f: GW / (GW + 22), c: clamp(0, y0, y1), w: fw0, len: GW + 22, s: L.fnS || 'solid'};
  arrow([X(x0), ay], xe);
  stroke([[ax, Y(y0)], ye]); items[items.length - 1].ga = {id: gid, k: 'y', v0: y0, v1: y1, f: GH / (GH + 22), c: clamp(0, x0, x1)};
  arrow([ax, Y(y0)], ye);
  const every = arr => Math.max(1, Math.ceil(arr.length / Math.max(4, Math.round(12 * S))));
  const ex = every(tx), ey = every(ty);
  // (1.58.4) numbers measured and centred: under their tick on the x axis, level with it left of the y axis;
  // a number that would touch one already placed is left out (0 first, then the x axis, then the y axis)
  const placed = [];
  const num = (t, x, y) => {
    const [bw, bh] = texBox(t, 12), g = [x + 6 - 2, y + 4 - 1, x + bw - 6 + 2, y + bh - 4 + 1];   // glyphs (box minus padding) + a little air
    if(placed.some(q => g[0] < q[2] && g[2] > q[0] && g[1] < q[3] && g[3] > q[1])) return;
    placed.push(g); formula(t, x, y, 12);
  };
  if(o.nums && x0 <= 0 && x1 >= 0 && y0 <= 0 && y1 >= 0){ const [bw] = texBox('0', 12); num('0', ax - 4 - bw, ay + 3); }
  tx.forEach((v, i) => {
    if(Math.abs(X(v) - ax) < 0.5) return;
    stroke([[X(v), ay - 4], [X(v), ay + 4]]);
    if(o.nums && i % ex === 0){ const t = fmtNum(v), [bw] = texBox(t, 12); num(t, X(v) - bw / 2, ay + 3); }
  });
  ty.forEach((v, i) => {
    if(Math.abs(Y(v) - ay) < 0.5) return;
    stroke([[ax - 4, Y(v)], [ax + 4, Y(v)]]);
    if(o.nums && i % ey === 0){ const t = fmtNum(v), [bw, bh] = texBox(t, 12); num(t, ax - 4 - bw, Y(v) - bh / 2); }
  });
  formula(labelTex(o.lx), xe[0] - 4, ay + 10, 18);
  formula(labelTex(o.ly), ax + 10, ye[1] - 8, 18);
  if(o.fn){
    const N = 600, segs = []; let seg = [];
    for(let i = 0; i <= N; i++){
      const xv = x0 + (x1 - x0) * i / N, yv = o.fn(xv);
      if(isFinite(yv) && yv >= y0 - (y1 - y0) * 1e-3 && yv <= y1 + (y1 - y0) * 1e-3) seg.push([X(xv), Y(clamp(yv, y0, y1))]);
      else { if(seg.length > 1) segs.push(seg); seg = []; }
    }
    if(seg.length > 1) segs.push(seg);
    const fw = w * (L.fnW > 0 ? L.fnW : 1.15), fc = L.fnC || '#1F4FCF';
    for(const sg of segs){
      const pieces = L.fnS === 'dash' ? dashPolys(sg, Math.max(8, fw * 4), Math.max(6, fw * 3))
        : L.fnS === 'dot' ? dashPolys(sg, Math.max(0.6, fw * 0.3), Math.max(5, fw * 2.6)) : [sg];
      for(const pc of pieces){
        // thin out points that lie on a straight line
        const V = pc.length > 2 ? rdp(pc, 0.25) : pc;
        items.push({t: 's', id: id('s'), c: fc, w: fw, hl: 0, p: polyPts(V, false)});
      }
    }
  }
  return finish();
}
const GRAPH_DEFAULTS = {q1: {x0: 0, x1: 10, xs: 1, y0: 0, y1: 10, ys: 1}, q4: {x0: -5, x1: 5, xs: 1, y0: -5, y1: 5, ys: 1}};
let graphType = 'q1';
// the dialog's look choices are remembered per device (prefs.graph); grid lines start half faded
const gLook = () => { if(!prefs.graph || typeof prefs.graph !== 'object') prefs.graph = {}; return Object.assign({}, GRAPH_LOOK, {gridO: 50, bg: true}, prefs.graph); };
function setGLook(k, v){ if(!prefs.graph || typeof prefs.graph !== 'object') prefs.graph = {}; prefs.graph[k] = v; savePrefs(); renderGLook(); }
function renderGLook(){
  const L = gLook();
  const seg = (box, v) => $(box).querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === +v || b.dataset.v === String(v)));
  seg('gSize', L.size); seg('gFnW', L.fnW); seg('gFnS', L.fnS);
  const sw = (box, list, v) => { $(box).innerHTML = list.map(c => `<button class="swatch${c === v ? ' on' : ''}" data-c="${c}" aria-label="${c === 'auto' ? 'Automatic (black or white)' : c}"><span style="--c:${c === 'auto' ? 'var(--fg)' : c}"></span></button>`).join(''); };
  const favs = [...new Set(['auto', ...prefs.penFavs, '#8A97A4'])];
  sw('gAxC', favs, L.axC);
  sw('gFnC', [...new Set(['#1F4FCF', ...prefs.penFavs])], L.fnC);
  $('gGridO').value = L.gridO; $('gGridOv').textContent = L.gridO + ' %';
  $('gAllO').value = L.allO; $('gAllOv').textContent = L.allO + ' %';
  $('gArrows').checked = L.arrows !== false;
  $('gBg').checked = L.bg !== false;
  drawGraphPreview();
}
function setGraphType(t){
  graphType = t;
  $('gType').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === t));
  document.querySelectorAll('#graphDlg .g2d').forEach(el => el.hidden = t === '3d');
  document.querySelectorAll('#graphDlg .g3').forEach(el => el.hidden = t !== '3d');
  const d = GRAPH_DEFAULTS[t];
  if(d) for(const [k, v] of Object.entries({gX0: d.x0, gX1: d.x1, gXs: d.xs, gY0: d.y0, gY1: d.y1, gYs: d.ys})) $(k).value = v;
  drawGraphPreview();
}
// reads the dialog: {o} or {err}
function readGraph(){
  const num = id => { const v = parseFloat(String($(id).value).replace(',', '.')); return isFinite(v) ? v : NaN; };
  const o = {type: graphType, lx: $('gLx').value, ly: $('gLy').value, lz: $('gLz').value, nums: $('gNums').checked, grid: $('gGrid').checked, look: gLook()};
  if(graphType !== '3d'){
    Object.assign(o, {x0: num('gX0'), x1: num('gX1'), xs: Math.abs(num('gXs')), y0: num('gY0'), y1: num('gY1'), ys: Math.abs(num('gYs'))});
    if(!(o.x1 > o.x0) || !(o.y1 > o.y0)) return {err: 'Each "to" must be bigger than its "from".'};
    try { o.fn = parseFn($('gFn').value); } catch(err){ return {err: err.message}; }
  }
  return {o};
}
// small picture of the graph in the dialog; formulas drawn as plain text
function drawGraphPreview(){
  const cv = $('gPrev'); if(!cv || $('graphDlg').hidden) return;
  const r = cv.getBoundingClientRect(); if(!r.width) return;
  const d = Math.min(2, devicePixelRatio || 1), CW = Math.round(r.width * d), CH = Math.round(r.height * d);
  if(cv.width !== CW || cv.height !== CH){ cv.width = CW; cv.height = CH; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, CW, CH);
  const g = readGraph(); if(g.err) return;
  const items = buildGraph(g.o, 0, 0);
  const tw = it => texPlain(it.tex).length * it.fs * 0.55;
  let b = null;
  for(const it of items){
    const q = it.t === 's' ? strokeBox(it) : [it.x, it.y, it.x + tw(it), it.y + it.fs * 1.3];
    b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q;
  }
  if(!b) return;
  const kk = Math.min(1.6 * d, (CW - 24 * d) / (b[2] - b[0]), (CH - 16 * d) / (b[3] - b[1]));
  ctx.setTransform(kk, 0, 0, kk, CW / 2 - (b[0] + b[2]) / 2 * kk, CH / 2 - (b[1] + b[3]) / 2 * kk);
  for(const it of items){
    ctx.globalAlpha = opOf(it);
    if(it.t === 's'){ ctx.fillStyle = inkColor(it.c, false); ctx.fill(strokePath(it, false)); }
    else { ctx.fillStyle = it.c && it.c !== 'auto' ? inkColor(it.c) : tokens.fg; ctx.font = `italic ${it.fs * 0.9}px "Times New Roman", serif`; ctx.fillText(texPlain(it.tex), it.x, it.y + it.fs); }
  }
  ctx.globalAlpha = 1;
}
/* (1.65) The graph window remembers what was typed in it (labels, ranges, steps, function, numbers, grid, type) on
   this device (prefs.graphForm), so it is filled in the next time, also after closing the app. Picking another type
   still puts that type's usual ranges in. */
const G_FIELDS = ['gLx', 'gLy', 'gLz', 'gX0', 'gX1', 'gXs', 'gY0', 'gY1', 'gYs', 'gFn'];
const saveGraphForm = debounce(() => {
  const v = {}; for(const id of G_FIELDS) v[id] = $(id).value;
  prefs.graphForm = {type: graphType, v, nums: $('gNums').checked, grid: $('gGrid').checked};
  savePrefs();
}, 400);
function restoreGraphForm(){
  const f = prefs.graphForm;
  if(!f || typeof f !== 'object' || !f.v || !GRAPH_DEFAULTS[f.type] && f.type !== '3d') return false;
  setGraphType(f.type);
  for(const id of G_FIELDS) if(typeof f.v[id] === 'string') $(id).value = f.v[id];
  $('gNums').checked = !!f.nums; $('gGrid').checked = !!f.grid;
  drawGraphPreview();
  return true;
}
$('graphOpen').addEventListener('click', () => {
  closePops();
  if(!$('gX1').value && !$('gLx').value) restoreGraphForm();   // first time since the app started: the last values
  if(!$('gLx').value) $('gLx').value = 'x';
  if(!$('gLy').value) $('gLy').value = 'y';
  if(!$('gLz').value) $('gLz').value = 'z';
  if(!$('gX1').value){ $('gNums').checked = true; setGraphType('q1'); }
  $('gFnMsg').textContent = '';
  showModal('graphDlg');
  renderGLook();
});
$('gType').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if(b){ setGraphType(b.dataset.v); saveGraphForm(); } });
$('gFn').addEventListener('input', () => {
  try { parseFn($('gFn').value); $('gFnMsg').textContent = ''; } catch(err){ $('gFnMsg').textContent = err.message; }
});
$('graphDlg').addEventListener('input', e => { if(e.target.id !== 'gGridO' && e.target.id !== 'gAllO'){ drawGraphPreview(); if(G_FIELDS.includes(e.target.id)) saveGraphForm(); } });
$('graphDlg').addEventListener('change', e => { if(e.target.matches('input[type=checkbox]') && e.target.id !== 'gArrows' && e.target.id !== 'gBg'){ drawGraphPreview(); saveGraphForm(); } });
for(const [box, key, num] of [['gSize', 'size', 1], ['gFnW', 'fnW', 1], ['gFnS', 'fnS', 0]])
  $(box).addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if(b) setGLook(key, num ? +b.dataset.v : b.dataset.v); });
for(const [box, key] of [['gAxC', 'axC'], ['gFnC', 'fnC']])
  $(box).addEventListener('click', e => { const b = e.target.closest('[data-c]'); if(b) setGLook(key, b.dataset.c); });
for(const [inp, key] of [['gGridO', 'gridO'], ['gAllO', 'allO']])
  $(inp).addEventListener('input', () => setGLook(key, clamp(+$(inp).value || 100, 10, 100)));
$('gArrows').addEventListener('change', () => setGLook('arrows', $('gArrows').checked));
$('gBg').addEventListener('change', () => setGLook('bg', $('gBg').checked));
$('gInsert').addEventListener('click', () => {
  if(!cur) return;
  const g = readGraph();
  if(g.err){ $('gFnMsg').textContent = g.err; return; }
  const S = g.o.look.size || 1;
  const [gx, gy] = toWorld(Math.max(40, W / 2 - 240 * S * cam.z), Math.max(40, H / 2 - 170 * S * cam.z));
  const items = buildGraph(g.o, gx, gy);
  saveGraphForm(); saveGraphForm.flush();
  hideModal('graphDlg');
  addItems(items);
  setTool('lasso'); setTimeout(() => selectIds(items.map(it => it.id)), 60);
});

/* (1.58) Add formula: draw another function on a graph that is selected */
const GAdd = {
  g: null,   // {x: x-axis item, y: y-axis item}
  // a graph in the selection: both axis lines of the same graph
  find(its){
    const xs = its.filter(it => it.t === 's' && it.ga && it.ga.k === 'x');
    for(const xa of xs){ const ya = its.find(it => it.t === 's' && it.ga && it.ga.k === 'y' && it.ga.id === xa.ga.id); if(ya) return {x: xa, y: ya}; }
    return null;
  },
  // world point of data value (xv, yv) on graph g, from the axes' current points
  map(g){
    const A = g.x.ga, B = g.y.ga, p = g.x.p, q = g.y.p;
    const P0 = [p[0], p[1]], ux = [(p[p.length - 3] - p[0]) * A.f, (p[p.length - 2] - p[1]) * A.f];
    const uy = [(q[q.length - 3] - q[0]) * B.f, (q[q.length - 2] - q[1]) * B.f];
    return (xv, yv) => { const a = (xv - A.v0) / (A.v1 - A.v0), b = (yv - A.c) / (B.v1 - B.v0); return [P0[0] + ux[0] * a + uy[0] * b, P0[1] + ux[1] * a + uy[1] * b]; };
  },
  open(){
    const its = sel ? sel.ids.map(id => cur.items.get(id)).filter(Boolean) : [];
    GAdd.g = GAdd.find(its); if(!GAdd.g) return;
    const L = gLook(), used = new Set([...cur.items.values()].filter(it => it.t === 's' && it.g && it.g === GAdd.g.x.g && it.c !== 'paper').map(it => it.c));
    const cols = [...new Set(['#1F4FCF', '#C2362B', '#167A3C', '#E07A10', '#7B3FBF', ...prefs.penFavs.filter(c => c !== 'auto')])];
    GAdd.c = cols.find(c => !used.has(c)) || L.fnC || '#1F4FCF';
    GAdd.s = 'solid';
    $('gaC').innerHTML = cols.map(c => `<button class="swatch" data-c="${c}" aria-label="Colour ${c}"><span style="--c:${c}"></span></button>`).join('');
    GAdd.render();
    $('gaFn').value = ''; $('gaMsg').textContent = '';
    if(prefs.gaLbl === undefined) prefs.gaLbl = true;
    $('gaLbl').checked = !!prefs.gaLbl;
    showModal('gAddDlg');
    setTimeout(() => $('gaFn').focus(), 60);
  },
  render(){
    $('gaC').querySelectorAll('[data-c]').forEach(b => b.classList.toggle('on', b.dataset.c === GAdd.c));
    $('gaS').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === GAdd.s));
  },
  // the typed function as a formula for the label
  tex(src){
    let t = String(src).trim().replace(/^\s*[yf]\s*(\(\s*x\s*\))?\s*=\s*/i, '');
    t = t.replace(/\*/g, '\\cdot ').replace(/\bsqrt\b/g, '\\sqrt').replace(/\bpi\b/g, '\\pi ').replace(/\b(sin|cos|tan|ln|log|exp)\b/g, '\\$1');
    t = t.replace(/\\sqrt\s*\(([^()]*)\)/g, '\\sqrt{$1}').replace(/\^\(([^()]*)\)/g, '^{$1}').replace(/\^(-?[\d.]+)/g, '^{$1}');
    return 'y = ' + t;
  },
  add(){
    const g = GAdd.g; if(!g || !cur) return;
    // the graph may have changed since the window opened (undo, another device): use the current axes
    const gx = cur.items.get(g.x.id), gy = cur.items.get(g.y.id);
    if(!gx || !gy){ hideModal('gAddDlg'); toast('That graph is no longer on the page'); return; }
    g.x = gx; g.y = gy;
    let fn;
    try { fn = parseFn($('gaFn').value); } catch(err){ $('gaMsg').textContent = err.message; return; }
    if(!fn){ $('gaMsg').textContent = 'Type a function, for example 2x+1'; return; }
    const A = gx.ga, B = gy.ga, P = GAdd.map(g);
    const p = gx.p, len = Math.hypot(p[p.length - 3] - p[0], p[p.length - 2] - p[1]), k = A.len > 0 ? len / A.len : 1;
    const fw = (A.w || penWidth() * 1.15) * k, o = opOf(gx);
    const N = 600, segs = []; let seg = [], last = null;
    for(let i = 0; i <= N; i++){
      const xv = A.v0 + (A.v1 - A.v0) * i / N, yv = fn(xv);
      if(isFinite(yv) && yv >= B.v0 - (B.v1 - B.v0) * 1e-3 && yv <= B.v1 + (B.v1 - B.v0) * 1e-3){ seg.push(P(xv, clamp(yv, B.v0, B.v1))); last = [xv, clamp(yv, B.v0, B.v1)]; }
      else { if(seg.length > 1) segs.push(seg); seg = []; }
    }
    if(seg.length > 1) segs.push(seg);
    if(!segs.length){ $('gaMsg').textContent = 'This function never shows inside the graph\'s range (' + fmtNum(A.v0) + ' to ' + fmtNum(A.v1) + ' across, ' + fmtNum(B.v0) + ' to ' + fmtNum(B.v1) + ' up).'; return; }
    const id = pre => pre + newId() + Math.random().toString(36).slice(2, 5);
    const items = [];
    for(const sg of segs){
      const pieces = GAdd.s === 'dash' ? dashPolys(sg, Math.max(8, fw * 4), Math.max(6, fw * 3)) : GAdd.s === 'dot' ? dashPolys(sg, Math.max(0.6, fw * 0.3), Math.max(5, fw * 2.6)) : [sg];
      for(const pc of pieces){ const V = pc.length > 2 ? rdp(pc, 0.25) : pc; items.push({t: 's', id: id('s'), c: GAdd.c, w: fw, hl: 0, p: polyPts(V, false)}); }
    }
    if($('gaLbl').checked && last){
      const fs = Math.max(10, 16 * k), at = P(last[0], last[1]);
      items.push({t: 'm', id: id('m'), x: at[0] + 6 * k, y: at[1] - fs * 1.6, tex: GAdd.tex($('gaFn').value), fs, c: GAdd.c});
    }
    for(const it of items){ it.ne = 1; if(gx.g) it.g = gx.g; if(o < 1) it.o = o; }
    const keep = sel ? sel.ids.slice() : [];
    hideModal('gAddDlg');
    addItems(items);
    setTool('lasso'); setTimeout(() => selectIds(keep.filter(i => cur.items.has(i)).concat(items.map(it => it.id))), 60);
  }
};
$('selGraph').addEventListener('click', () => GAdd.open());
$('gaC').addEventListener('click', e => { const b = e.target.closest('[data-c]'); if(!b) return; GAdd.c = b.dataset.c; GAdd.render(); });
$('gaS').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if(!b) return; GAdd.s = b.dataset.v; GAdd.render(); });
$('gaLbl').addEventListener('change', () => { prefs.gaLbl = $('gaLbl').checked; savePrefs(); });
$('gaAdd').addEventListener('click', () => GAdd.add());
$('gaFn').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); GAdd.add(); } });
$('gaFn').addEventListener('input', () => { $('gaMsg').textContent = ''; });

/* =====================================================================
   Word documents: rendered to page images, like a PDF
   ===================================================================== */
// (1.67.4) one promise per library: a second call while it is still loading waits for it (before, it went on at once
// and failed with "PDFLib is not defined"); a failed load (offline) is forgotten, so the next try loads it again
// (before, the failed script tag counted as loaded and the feature broke until Inkwell restarted)
const scriptLoads = new Map();
function loadScript(src){
  if(scriptLoads.has(src)) return scriptLoads.get(src);
  const p = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.dataset.src = src;
    s.onload = () => res();
    s.onerror = () => { s.remove(); scriptLoads.delete(src); rej(new Error('Could not load ' + src + ' (offline?)')); };
    document.head.appendChild(s);
  });
  scriptLoads.set(src, p);
  return p;
}
async function wordLibs(){
  if(!window.JSZip) await loadScript('lib/docx/jszip.min.js');
  if(!window.docx || !window.docx.renderAsync) await loadScript('lib/docx/docx-preview.min.js');
  if(!window.html2canvas) await loadScript('lib/docx/html2canvas.min.js');
}
// Opens a .docx for page-by-page rendering (1.46). The Word layout itself is quick; turning each page into a picture
// (html2canvas, about 2 px per CSS px) is the slow part, so it happens one page at a time through `next()`, which the
// import calls after the dialog has closed. Long sections without page breaks are cut into page-sized pieces at blank
// rows between lines of text. Returns {est (estimated page count), next() -> {canvas, w, h} | null, close()}.
async function openDocx(file){
  await wordLibs();
  const box = document.createElement('div');
  box.className = 'docx-render';
  box.style.cssText = 'position:absolute;left:0;top:0;z-index:-5;background:#fff;color:#000;color-scheme:light;width:max-content;pointer-events:none';
  document.body.appendChild(box);
  let sections;
  try {
    // (1.67.1, security) renderAltChunks off: Word files can carry raw web pages (altChunk) that docx-preview shows in an
    // iframe without a sandbox, where their scripts would run inside Inkwell. They are left out of the import.
    await window.docx.renderAsync(await file.arrayBuffer(), box, box, {inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, ignoreWidth: false, ignoreHeight: false, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true, experimental: true, renderAltChunks: false});
    if(document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise(r => setTimeout(r, 60));
    sections = [...box.querySelectorAll('section.docx')];
    if(!sections.length) throw new Error('No pages found in this Word file');
  } catch(e){ box.remove(); throw e; }
  const measure = sec => {
    sections.forEach(o => { o.style.display = o === sec ? '' : 'none'; });
    const cs = getComputedStyle(sec);
    const pw = sec.offsetWidth, padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
    const ph = Math.max(parseFloat(cs.minHeight) || 0, 100) || pw * 1.414;
    return {pw, padT, padB, ph, total: sec.scrollHeight};
  };
  let est = 0;
  for(const sec of sections){ const m = measure(sec); est += 1 + Math.max(0, Math.ceil((m.total - m.ph) / Math.max(50, m.ph - m.padT - m.padB))); }
  const scale = 2;
  let closed = false, si = -1, m = null, srcY = 0, first = true, count = 0;
  const close = () => { closed = true; box.remove(); };
  async function next(){
    if(closed) return null;
    // move on to the next section once this one is used up
    while(!m || !(srcY < m.total - m.padB - 2 || first)){
      if(++si >= sections.length || count >= 300){ close(); return null; }
      m = measure(sections[si]); srcY = 0; first = true;
    }
    const sec = sections[si];
    sections.forEach(o => { o.style.display = o === sec ? '' : 'none'; });
    const {pw, padT, padB, ph, total} = m;
    const r = sec.getBoundingClientRect(), top = r.top + scrollY, left = r.left + scrollX;
    const avail = Math.max(50, first ? ph - padB : ph - padT - padB);
    const take = Math.min(avail, total - srcY);
    const cv = await html2canvas(sec, {scale, backgroundColor: '#ffffff', logging: false, useCORS: true,
      x: left, y: top + srcY, width: pw, height: take, scrollX: 0, scrollY: 0, windowWidth: Math.max(pw + 40, innerWidth),
      ignoreElements: el => el !== document.body && el !== document.documentElement && el.tagName !== 'HEAD' && !box.contains(el) && !el.contains(box)});
    if(closed){ cv.width = cv.height = 1; return null; }
    let cut = take;
    if(srcY + take < total - padB - 2){
      // find a blank row in the lowest quarter so no line of text is cut in half
      const ctx = cv.getContext('2d'), y0 = Math.floor(cv.height * 0.72), data = ctx.getImageData(0, y0, cv.width, cv.height - y0).data, rowW = cv.width * 4;
      for(let y = cv.height - y0 - 1; y >= 0; y--){
        let blank = true;
        for(let x = 0; x < rowW; x += 16){ if(data[y * rowW + x] < 235 || data[y * rowW + x + 1] < 235 || data[y * rowW + x + 2] < 235){ blank = false; break; } }
        if(blank){ cut = (y0 + y) / scale; break; }
      }
    }
    const page = document.createElement('canvas');
    page.width = Math.round(pw * scale); page.height = Math.round(ph * scale);
    const pc = page.getContext('2d');
    pc.fillStyle = '#fff'; pc.fillRect(0, 0, page.width, page.height);
    pc.drawImage(cv, 0, 0, cv.width, Math.round(cut * scale), 0, Math.round((first ? 0 : padT) * scale), cv.width, Math.round(cut * scale));
    cv.width = cv.height = 1;
    srcY += Math.max(cut, 20); first = false; count++;
    return {canvas: page, w: pw, h: ph};
  }
  return {est, next, close};
}
// every page at once (kept for scripts and tests)
async function renderDocx(file, onStatus){
  const d = await openDocx(file), pages = [];
  try { for(let pg; onStatus && onStatus(`Reading page ${pages.length + 1}`), (pg = await d.next());) pages.push(pg); }
  finally { d.close(); }
  return pages;
}
