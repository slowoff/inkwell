/* Inkwell app: Selection: lasso, box, tap, groups, copy and paste, taps.
   (1.64.1) split out of app/06-writing.js. All app/ files share one global scope and are run in order by app.js;
   code that runs while a file loads must not use a later file (tests/unit/load_order.test.js). */
'use strict';
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
