/* Inkwell core: Ink geometry: stored point format, stroke shape (smooth curves) and outlines for screen, print and PDF.
   Plain script (no build step): in the app it defines window.InkGeo (loaded before app.js);
   in Node (tests/unit) it is a CommonJS module. Moved unchanged out of app.js in 1.61.3. */
(function(root, make){
  const api = make(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.InkGeo = api;
})(typeof self !== 'undefined' ? self : this, function(root){
'use strict';
  const {clamp} = typeof module === 'object' && module.exports ? require('./util.js') : root.InkUtil;

function encPts(p){
  const out = []; let px = 0, py = 0;
  for(let i = 0; i < p.length; i += 3){
    const X = Math.round(p[i] * 4), Y = Math.round(p[i+1] * 4), P = Math.round(clamp(p[i+2], 0, 1) * 31);
    out.push((X - px).toString(36), (Y - py).toString(36), P.toString(36));
    px = X; py = Y;
  }
  return out.join(',');
}
function decPts(str){
  if(Array.isArray(str)) return str.slice();
  if(!str) return [];
  const a = String(str).split(','), p = []; let X = 0, Y = 0;
  for(let i = 0; i + 2 < a.length; i += 3){
    X += parseInt(a[i], 36); Y += parseInt(a[i+1], 36);
    p.push(X / 4, Y / 4, parseInt(a[i+2], 36) / 31);
  }
  return p;
}
const ser = it => it.t === 's' ? Object.assign({}, it, {p: encPts(it.p)}) : it;
// optional fade on any item (1.40): o between 0.1 and 1, missing = fully visible (older versions just ignore it)
const opOf = it => it && it.o > 0 && it.o < 1 ? it.o : 1;
const deser = it => it && it.t === 's' ? Object.assign({}, it, {p: decPts(it.p)}) : it;
const r1 = v => Math.round(v * 10) / 10;
// where recorded point i of a stroke really lies on the drawn centre line (after the light 1-2-1 smoothing below);
// the smooth curve passes exactly through it. (1.72) also used by the ink self-check, which looked at the raw point
function shapePoint(p, i){
  const m = p.length / 3;
  if(!(i > 0 && i < m - 1)) return [p[i*3], p[i*3+1]];
  const d = (Math.hypot(p[i*3] - p[i*3-3], p[i*3+1] - p[i*3-2]) + Math.hypot(p[i*3+3] - p[i*3], p[i*3+4] - p[i*3+1])) / 2;
  const f = d <= 3 ? 1 : d >= 8 ? 0 : (8 - d) / 5;
  if(!f) return [p[i*3], p[i*3+1]];
  return [p[i*3] + f * ((p[i*3-3] + 2*p[i*3] + p[i*3+3]) / 4 - p[i*3]), p[i*3+1] + f * ((p[i*3-2] + 2*p[i*3+1] + p[i*3+4]) / 4 - p[i*3+1])];
}
function strokeShape(it){
  const p = it.p, m = p.length / 3, base = it.w / 2;
  // light smoothing of the recorded points (1-2-1) against jitter, ends kept where the pen touched down and lifted.
  // (1.47) only where points are close together: far apart (fast writing) it would shrink loops, and the curve below
  // already rounds those.
  const X = new Array(m), Y = new Array(m), Rr = new Array(m);
  for(let i = 0; i < m; i++){
    const mid = i > 0 && i < m - 1;
    [X[i], Y[i]] = shapePoint(p, i);
    const pr = mid ? (p[i*3-1] + 2*p[i*3+2] + p[i*3+5]) / 4 : p[i*3+2];
    Rr[i] = it.hl ? base : Math.max(0.3, base * (0.3 + pr));
  }
  if(m < 3) return {xs: X, ys: Y, rs: Rr, n: m, at: X.map((_, i) => i)};
  // (1.47) smooth curves: between recorded points the line follows a centripetal Catmull-Rom curve instead of a
  // straight piece, so fast writing (points far apart) gives round letters instead of corners. Rendering only;
  // the stored points are unchanged, so older strokes get it too and the data format stays the same.
  const step = Math.max(0.6, base * 0.5);
  const xs = [X[0]], ys = [Y[0]], rs = [Rr[0]], at = [0];   // at[i] = index in xs of recorded point i
  for(let i = 0; i < m - 1; i++){
    const len = Math.hypot(X[i+1] - X[i], Y[i+1] - Y[i]);
    const k = Math.min(16, Math.floor(len / step));
    if(k >= 2){
      const a = i > 0 ? i - 1 : i, d = i + 2 < m ? i + 2 : i + 1;
      const P = [[X[a], Y[a]], [X[i], Y[i]], [X[i+1], Y[i+1]], [X[d], Y[d]]];
      if(a === i) P[0] = [2*X[i] - X[i+1], 2*Y[i] - Y[i+1]];
      if(d === i + 1) P[3] = [2*X[i+1] - X[i], 2*Y[i+1] - Y[i]];
      const tj = (q, r) => Math.max(1e-4, Math.sqrt(Math.hypot(r[0] - q[0], r[1] - q[1])));
      const t1 = tj(P[0], P[1]), t2 = t1 + tj(P[1], P[2]), t3 = t2 + tj(P[2], P[3]);
      for(let j = 1; j < k; j++){
        const t = t1 + (t2 - t1) * j / k;
        const out = [0, 1].map(c => {
          const A1 = ((t1 - t) * P[0][c] + t * P[1][c]) / t1;
          const A2 = ((t2 - t) * P[1][c] + (t - t1) * P[2][c]) / (t2 - t1);
          const A3 = ((t3 - t) * P[2][c] + (t - t2) * P[3][c]) / (t3 - t2);
          const B1 = ((t2 - t) * A1 + t * A2) / t2;
          const B2 = ((t3 - t) * A2 + (t - t1) * A3) / (t3 - t1);
          return ((t2 - t) * B1 + (t - t1) * B2) / (t2 - t1);
        });
        if(!isFinite(out[0]) || !isFinite(out[1])) continue;
        xs.push(out[0]); ys.push(out[1]); rs.push(Rr[i] + (Rr[i+1] - Rr[i]) * j / k);
      }
    }
    xs.push(X[i+1]); ys.push(Y[i+1]); rs.push(Rr[i+1]); at.push(xs.length - 1);
  }
  return {xs, ys, rs, n: xs.length, at};
}
// Filled outline of a variable-width stroke, as a Path2D or an SVG path string.
// (1.57) a filled stroke (fl:1, e.g. a graph's solid background): its points are the outline, filled as is
function fillPath(it, svg){
  const p = it.p, n = p.length / 3;
  if(n < 3) return svg ? '' : new Path2D();
  if(svg){ let d = `M${r1(p[0])} ${r1(p[1])}`; for(let i = 3; i < p.length; i += 3) d += `L${r1(p[i])} ${r1(p[i+1])}`; return d + 'Z'; }
  const P = new Path2D(); P.moveTo(p[0], p[1]); for(let i = 3; i < p.length; i += 3) P.lineTo(p[i], p[i+1]); P.closePath(); return P;
}
// drawing order: fills first, then highlighter, then pen ink on top
const inkPass = it => it.fl ? 2 : it.hl ? 1 : 0;
function strokePath(it, svg){
  if(it.fl) return fillPath(it, svg);
  const {xs, ys, rs, n} = strokeShape(it);
  if(!n) return svg ? '' : new Path2D();
  let single = n === 1;
  if(!single){ let span = 0; for(let i = 1; i < n; i++) span = Math.max(span, Math.abs(xs[i]-xs[0]) + Math.abs(ys[i]-ys[0])); single = span < 0.6; }
  if(single){
    const r = rs[0];
    if(svg) return `M${r1(xs[0]-r)} ${r1(ys[0])}a${r1(r)} ${r1(r)} 0 1 0 ${r1(2*r)} 0a${r1(r)} ${r1(r)} 0 1 0 ${r1(-2*r)} 0Z`;
    const P = new Path2D(); P.arc(xs[0], ys[0], r, 0, Math.PI * 2); return P;
  }
  return inkOutline(xs, ys, rs, n, 0, n - 1, true, true, svg);
}
/* Outline of samples s0..s1 of a stroke shape (strokePath and the live preview's pieces use it).
   Normally one outline along both edges with round ends. (1.61.1) Where a wide stroke turns back sharply
   (scribbling with the highlighter) that outline folds over itself and the folds cancel out, leaving holes;
   such strokes are filled instead as overlapping pieces: a band per step plus a round piece at each bend, all
   turning the same way so they only add up. Everything the pen passed over is then ink. */
function inkOutline(xs, ys, rs, n, s0, s1, capA, capB, svg){
  const L = [], R = [], A = [];
  let lnx = 0, lny = -1;
  for(let i = s0; i <= s1; i++){
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    let dx = xs[i1] - xs[i0], dy = ys[i1] - ys[i0];
    const len = Math.hypot(dx, dy);
    let nx, ny;
    if(len < 1e-6){ nx = lnx; ny = lny; } else { dx /= len; dy /= len; nx = -dy; ny = dx; }
    lnx = nx; lny = ny;
    A.push(Math.atan2(ny, nx));
    L.push([xs[i] + nx * rs[i], ys[i] + ny * rs[i]]);
    R.push([xs[i] - nx * rs[i], ys[i] - ny * rs[i]]);
  }
  const k = L.length;
  // does an edge run backwards anywhere (the outline folds)?
  let fold = false;
  for(let j = 0; j + 1 < k && !fold; j++){
    const cx = xs[s0 + j + 1] - xs[s0 + j], cy = ys[s0 + j + 1] - ys[s0 + j];
    if(Math.abs(cx) + Math.abs(cy) < 1e-6) continue;
    if((L[j+1][0] - L[j][0]) * cx + (L[j+1][1] - L[j][1]) * cy < 0 || (R[j+1][0] - R[j][0]) * cx + (R[j+1][1] - R[j][1]) * cy < 0) fold = true;
  }
  strokePath.lastMode = fold ? 'pieces' : 'outline';
  if(fold) return inkPieces(xs, ys, rs, s0, s1, svg);
  if(svg){
    let d = `M${r1(L[0][0])} ${r1(L[0][1])}`;
    for(let i = 1; i < k; i++) d += `L${r1(L[i][0])} ${r1(L[i][1])}`;
    if(capB){ const re = rs[s1]; d += `A${r1(re)} ${r1(re)} 0 0 0 ${r1(R[k-1][0])} ${r1(R[k-1][1])}`; } else d += `L${r1(R[k-1][0])} ${r1(R[k-1][1])}`;
    for(let i = k - 2; i >= 0; i--) d += `L${r1(R[i][0])} ${r1(R[i][1])}`;
    if(capA) d += `A${r1(rs[s0])} ${r1(rs[s0])} 0 0 0 ${r1(L[0][0])} ${r1(L[0][1])}`;
    return d + 'Z';
  }
  const P = new Path2D();
  P.moveTo(L[0][0], L[0][1]);
  for(let i = 1; i < k; i++) P.lineTo(L[i][0], L[i][1]);
  if(capB) P.arc(xs[s1], ys[s1], rs[s1], A[k-1], A[k-1] - Math.PI, true); else P.lineTo(R[k-1][0], R[k-1][1]);
  for(let i = k - 2; i >= 0; i--) P.lineTo(R[i][0], R[i][1]);
  if(capA) P.arc(xs[s0], ys[s0], rs[s0], A[0] + Math.PI, A[0], true);
  P.closePath();
  return P;
}
// (1.61.1) a stroke as overlapping pieces: one band per step (its own direction, so it never twists) and a disc
// wherever two steps meet at an angle, plus both ends. All pieces wind the same way, so with the normal fill rule
// overlaps add up and never cancel (no holes).
function inkPieces(xs, ys, rs, s0, s1, svg){
  const P = svg ? null : new Path2D();
  let d = '';
  const disc = (x, y, r) => {
    if(svg) d += `M${r1(x + r)} ${r1(y)}a${r1(r)} ${r1(r)} 0 1 0 ${r1(-2 * r)} 0a${r1(r)} ${r1(r)} 0 1 0 ${r1(2 * r)} 0Z`;
    else { P.moveTo(x + r, y); P.arc(x, y, r, 0, Math.PI * 2, true); }
  };
  let pdx = 0, pdy = 0, have = false;
  disc(xs[s0], ys[s0], rs[s0]);
  for(let i = s0; i < s1; i++){
    let dx = xs[i+1] - xs[i], dy = ys[i+1] - ys[i];
    const len = Math.hypot(dx, dy);
    if(len < 1e-6) continue;
    dx /= len; dy /= len;
    // a disc at this point if the path bends here (keeps the outer side of the bend filled)
    if(have && (pdx * dx + pdy * dy) < 0.9995 && rs[i] * Math.acos(Math.max(-1, Math.min(1, pdx * dx + pdy * dy))) > 0.05) disc(xs[i], ys[i], rs[i]);
    const nx = -dy, ny = dx, a = rs[i], b = rs[i+1];
    const q = [[xs[i] + nx * a, ys[i] + ny * a], [xs[i+1] + nx * b, ys[i+1] + ny * b], [xs[i+1] - nx * b, ys[i+1] - ny * b], [xs[i] - nx * a, ys[i] - ny * a]];
    if(svg) d += `M${r1(q[0][0])} ${r1(q[0][1])}L${r1(q[1][0])} ${r1(q[1][1])}L${r1(q[2][0])} ${r1(q[2][1])}L${r1(q[3][0])} ${r1(q[3][1])}Z`;
    else { P.moveTo(q[0][0], q[0][1]); P.lineTo(q[1][0], q[1][1]); P.lineTo(q[2][0], q[2][1]); P.lineTo(q[3][0], q[3][1]); }   // no closePath: filling closes each piece anyway, and closePath made Chrome's Path2D ~100x slower here
    pdx = dx; pdy = dy; have = true;
  }
  disc(xs[s1], ys[s1], rs[s1]);
  return svg ? d : P;
}
function strokeBox(it){
  const p = it.p; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for(let i = 0; i < p.length; i += 3){ const x = p[i], y = p[i+1]; if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; }
  const m = it.w / 2 + 1;
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}

return {encPts, decPts, ser, opOf, deser, r1, shapePoint, strokeShape, fillPath, inkPass, strokePath, inkOutline, inkPieces, strokeBox};
});
