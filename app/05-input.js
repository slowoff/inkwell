/* Inkwell app, part 5 of 13: Pointer input: Pencil, fingers, mouse.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
/* =====================================================================
   Pointer input: Pencil writes, fingers move and zoom
   ===================================================================== */
let act = null;            // current tool action
let gesture = null;        // finger or mouse gesture
const touches = new Map();
let penDown = false, spaceDown = false, selDrag = null, penAt = -1e9;

const penWidth = () => 0.6 * Math.pow(25, prefs.pen.s / 100);
const hlWidth = () => 6 + prefs.hl.s * 0.44;
const eraserRadius = () => 4 + prefs.eraser.s * 0.5;
const markWidth = () => 6 + prefs.mark.s * 0.44;
const MARK_C = '#8B5CF6';   // "mark for later" strokes: violet highlighter, flagged with mk:1

stage.addEventListener('pointerdown', onDown);
stage.addEventListener('pointermove', onMove);
stage.addEventListener('pointerup', onUp);
stage.addEventListener('pointercancel', onCancel);
stage.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('gesturestart', e => e.preventDefault());

function onDown(e){
  if(!cur) return;
  if(e.target.closest('.sel-menu,.fmt,.sel-rect,#tHandle,#tMove')) return;
  if(e.target.closest('.pf') && getComputedStyle(e.target.closest('.pf')).pointerEvents !== 'none') return;
  const editEl = editing && elMap.get(editing.id);
  const inEdit = !!(editEl && editEl.contains(e.target));
  const [sx, sy] = pt(e);
  if(e.pointerType === 'touch'){
    if(inEdit || penDown) return;
    touches.set(e.pointerId, {x: sx, y: sy, sx, sy, t: performance.now(), target: e.target});
    try { stage.setPointerCapture(e.pointerId); } catch {}
    if(touches.size === 1){
      if(pick || prefs.tool === 'space'){ startTool(e, sx, sy, 0.55); if(act) act.touch = true; return; }
      if(prefs.ruler.on && onRuler(sx, sy)){ gesture = startRulerGesture(); return; }
      if(prefs.finger){ startTool(e, sx, sy, 0.55); if(act) act.touch = true; return; }
      gesture = {kind: 'pending', start: {...cam}};
    } else if(touches.size === 2){
      if(act && act.touch) cancelAct();
      if(gesture && gesture.kind === 'ruler'){ gesture = startRulerGesture(); return; }
      gesture = startPinch();
    }
    return;
  }
  if(e.pointerType === 'mouse'){
    if(e.button === 1 || (e.button === 0 && spaceDown)){
      e.preventDefault();
      gesture = {kind: 'mousepan', x: sx, y: sy, id: e.pointerId, oy0: cam.oy};
      stage.setPointerCapture(e.pointerId); stage.classList.add('panning');
      return;
    }
    if(e.button === 2 && !inEdit && !act){ e.preventDefault(); openWheel(e.clientX, e.clientY, null); return; }
    if(e.button !== 0 || inEdit) return;
    if(prefs.ruler.on && onRuler(sx, sy) && !rulerEdge(sx, sy)){
      gesture = {kind: 'mouseruler', x: sx, y: sy, id: e.pointerId, r: {...prefs.ruler}};
      stage.setPointerCapture(e.pointerId);
      return;
    }
  }
  if(e.pointerType === 'pen'){
    if(inEdit && !['pen', 'hl', 'eraser'].includes(prefs.tool)) return;
    penDown = true; penAt = performance.now(); sleepSlider(); Scribe.hold();
    if(gesture && gesture.start){ Object.assign(cam, gesture.start); invalidate(); }  // a resting palm had started to move the page
    gesture = null; touches.clear(); stage.classList.remove('panning');
  }
  if(act) return;
  e.preventDefault();
  try { stage.setPointerCapture(e.pointerId); } catch {}
  startTool(e, sx, sy, e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.55);
}

function onMove(e){
  const [sx, sy] = pt(e);
  if(e.pointerType === 'touch' && touches.has(e.pointerId)){
    const t = touches.get(e.pointerId); t.x = sx; t.y = sy;
    if(act && act.touch && act.id === e.pointerId){ toolMove(e); return; }
    if(!gesture) return;
    if(gesture.kind === 'pending'){
      if(Math.hypot(sx - t.sx, sy - t.sy) < 7) return;
      gesture = {kind: 'pan', start: gesture.start, lx: t.sx, ly: t.sy, x0: t.sx, y0: t.sy};
      stage.classList.add('panning');
    }
    if(gesture.kind === 'pan'){
      cam.ox += sx - gesture.lx; cam.oy += sy - gesture.ly; gesture.lx = sx; gesture.ly = sy; invalidate();
      if(gesture.x0 != null && panWakes(gesture.x0, sy - gesture.y0, sx - gesture.x0)) wakeSlider();
    }
    else if(gesture.kind === 'pinch') pinchMove();
    else if(gesture.kind === 'ruler') rulerMove();
    return;
  }
  if(gesture && gesture.kind === 'mousepan' && e.pointerId === gesture.id){
    cam.ox += sx - gesture.x; cam.oy += sy - gesture.y; gesture.x = sx; gesture.y = sy; invalidate(); if(Math.abs(cam.oy - gesture.oy0) > 40) wakeSlider(); return;
  }
  if(gesture && gesture.kind === 'mouseruler' && e.pointerId === gesture.id){
    prefs.ruler.cx = gesture.r.cx + sx - gesture.x; prefs.ruler.cy = gesture.r.cy + sy - gesture.y; renderRuler(); return;
  }
  if(act && act.id === e.pointerId) toolMove(e);
}

function onUp(e){
  const [sx, sy] = pt(e);
  if(e.pointerType === 'touch' && touches.has(e.pointerId)){
    const t = touches.get(e.pointerId);
    touches.delete(e.pointerId);
    if(act && act.touch && act.id === e.pointerId){ endTool(e); return; }
    if(!gesture) return;
    if(gesture.kind === 'pending'){
      gesture = null;
      if(performance.now() - t.t < 500){ if(tapPick()) tapSelect(sx, sy, t.target); else tapAt(t.target, sx, sy); }   // (1.63) Tap mode: a finger tap selects too
    } else if(touches.size === 1 && gesture.kind === 'pinch'){
      const o = [...touches.values()][0];
      gesture = {kind: 'pan', lx: o.x, ly: o.y};
    } else if(touches.size >= 1 && gesture.kind === 'ruler'){
      gesture = startRulerGesture();
    }
    if(!touches.size){
      if(gesture && gesture.kind === 'ruler') savePrefs();
      gesture = null; stage.classList.remove('panning'); saveCamSoon();
    }
    return;
  }
  if(gesture && (gesture.kind === 'mousepan' || gesture.kind === 'mouseruler') && e.pointerId === gesture.id){
    gesture = null; stage.classList.remove('panning'); saveCamSoon(); savePrefs(); return;
  }
  if(e.pointerType === 'pen'){ penDown = false; penAt = performance.now(); }
  if(act && act.id === e.pointerId) endTool(e);
}
function onCancel(e){
  if(e.pointerType === 'touch'){
    touches.delete(e.pointerId);
    if(!touches.size){ gesture = null; stage.classList.remove('panning'); }
  }
  if(e.pointerType === 'pen'){ penDown = false; penAt = performance.now(); }
  if(act && act.id === e.pointerId){
    // (1.48.1) iPadOS can cancel a Pencil stroke (system gesture, Scribble); keep whatever was drawn.
    // A cancelled finger stroke is only kept with 2+ points (a resting palm is often cancelled)
    if(act.kind === 'stroke' && act.pts.length >= (e.pointerType === 'pen' ? 3 : 6)) endTool(e); else cancelAct();
  }
}
function cancelAct(){
  if(!act) return;
  clearTimeout(act.hold); clearTimeout(act.wheelT);
  if(act.kind === 'space' && act.orig.length) setItems(act.orig.map(it => [it.id, it]));
  if(act.kind === 'erase'){
    const back = [...act.added.keys()].map(id => [id, null]).concat(act.removed.map(it => [it.id, it]));
    if(back.length) setItems(back);
  }
  act = null; clearLive();
}

function startPinch(){
  const [a, b] = [...touches.values()];
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  return {kind: 'pinch', d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: cam.z, wc: toWorld(cx, cy), start: gesture && gesture.start ? gesture.start : {...cam}};
}
function pinchMove(){
  const [a, b] = [...touches.values()];
  if(!b) return;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const z = clamp(gesture.z0 * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0, Z_MIN, zMax());
  cam.z = z; cam.ox = cx - gesture.wc[0] * z; cam.oy = cy - gesture.wc[1] * z;
  invalidate();
}
function zoomAt(sx, sy, z){
  z = clamp(z, Z_MIN, zMax());
  const [wx, wy] = toWorld(sx, sy);
  cam.z = z; cam.ox = sx - wx * z; cam.oy = sy - wy * z;
  invalidate(); saveCamSoon();
}
const ZOOM_STEP = 1.04;   // 4 % per mouse-wheel click
stage.addEventListener('wheel', e => {
  e.preventDefault();
  if(!cur) return;
  const [sx, sy] = pt(e);
  if(prefs.ruler.on && onRuler(sx, sy) && e.shiftKey){ prefs.ruler.a += (e.deltaY > 0 ? 1 : -1) * Math.PI / 180; renderRuler(); savePrefs(); return; }
  // line/page based wheels (some mice and trackpad drivers) report small units
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
  let dx = e.deltaX * k, dy = e.deltaY * k;
  // trackpad drivers and mice that send sideways scrolling as Shift + wheel
  if(e.shiftKey && !dx){ dx = dy; dy = 0; }
  if(e.ctrlKey || e.metaKey){
    // a mouse wheel click (about 100 px or a few lines) zooms a small fixed step;
    // trackpad pinches send many tiny deltas and keep the smooth curve
    const raw = Math.abs(e.deltaY), notch = e.deltaMode !== 0 || raw >= 50;
    if(notch){
      const n = Math.min(3, Math.max(1, Math.round(raw / (e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100))));
      zoomAt(sx, sy, cam.z * Math.pow(ZOOM_STEP, -Math.sign(e.deltaY) * n));
    } else zoomAt(sx, sy, cam.z * Math.exp(-dy * 0.0085));
  }
  else { cam.ox -= dx; cam.oy -= dy; invalidate(); saveCamSoon(); if(Math.abs(dy) > Math.abs(dx)) wakeSlider(); }
}, {passive: false});
let gz0 = 1;
stage.addEventListener('gesturestart', e => { gz0 = cam.z; e.preventDefault(); });
stage.addEventListener('gesturechange', e => { e.preventDefault(); if(touches.size || !cur) return; const [sx, sy] = pt(e); zoomAt(sx, sy, gz0 * e.scale); });
const saveCamSoon = debounce(() => { if(cur) LSset('inkwell.cam.' + cur.id, {ox: cam.ox, oy: cam.oy, z: cam.z}); }, 600);

/* ---------- tools ---------- */
function startTool(e, sx, sy, pr){
  if(editing){ const el = elMap.get(editing.id); if(!el || !el.contains(e.target)) finishEditing(); }
  closePops();
  const [wx, wy] = toWorld(sx, sy);
  const tool = prefs.tool;
  act = {tool, id: e.pointerId, sx, sy, moved: false, target: e.target, anchor: [sx, sy]};
  TS.clear();
  if(pick){
    clearSel(); act.kind = 'pick'; act.w0 = [wx, wy]; act.w1 = null;
  } else if(tool === 'pen' || tool === 'hl' || tool === 'mark'){
    clearSel();
    act.kind = 'stroke';
    if(tool === 'mark'){ act.c = MARK_C; act.w = markWidth(); act.hl = 1; act.mk = 1; }
    else { act.c = prefs[tool].c; act.w = tool === 'hl' ? hlWidth() : penWidth(); act.hl = tool === 'hl' ? 1 : 0; }
    act.edge = prefs.ruler.on ? rulerEdge(sx, sy) : null;
    let X = sx, Y = sy;
    if(act.edge) [X, Y] = projectEdge(act.edge, sx, sy, act.w);
    act.pts = [...toWorld(X, Y), pr];
    act.last = [X, Y];
    armHold();
  } else if(tool === 'space'){
    // insert or remove vertical space: everything that starts below the line moves with the pen
    clearSel(); act.kind = 'space'; act.y0 = wy; act.dy = 0;
    act.orig = [...cur.items.values()].filter(it => itemBox(it)[1] >= wy - 0.5);
  } else if(tool === 'eraser'){
    clearSel(); act.kind = 'erase'; act.mode = prefs.eraser.mode === 'area' ? 'area' : 'stroke';
    act.removed = []; act.added = new Map(); act.cursor = [sx, sy]; act.lastW = null; eraseAt(sx, sy);
  } else if(tool === 'lasso'){
    act.kind = 'lasso'; act.poly = [sx, sy]; act.box = prefs.lassoMode === 'box'; act.tap = prefs.lassoMode === 'tap';
  } else if(tool === 'tape'){
    clearSel(); act.kind = 'tape'; act.w0 = [wx, wy]; act.w1 = [wx, wy];
  } else {
    act.kind = 'place'; act.w0 = [wx, wy];
  }
  // Pencil pressed down and held still: open the Pencil menu instead
  if(e.pointerType === 'pen' && !pick && prefs.wheel !== 'off'){
    const a = act, cx = e.clientX, cy = e.clientY;
    a.wheelT = setTimeout(() => { if(act === a && !a.far){ cancelAct(); openWheel(cx, cy, a.id); } }, WHEEL_HOLD);
  }
  drawLive();
}
function armHold(){
  clearTimeout(act.hold);
  const a = act;
  const ms = +prefs.snapHold;
  if(!(ms > 0)) return;   // straightening switched off in the settings
  a.hold = setTimeout(() => { if(act === a && a.kind === 'stroke' && a.far && !a.edge && !a.snapped) trySnap(a); }, ms);
}
function toolMove(e){
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
  const list = evs && evs.length ? evs : [e];
  for(const ev of list){
    const [sx, sy] = pt(ev);
    const pr = ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.55;
    if(!act.moved && Math.hypot(sx - act.sx, sy - act.sy) > 4) act.moved = true;
    if(!act.far && Math.hypot(sx - act.sx, sy - act.sy) > 9){ act.far = true; clearTimeout(act.wheelT); }
    // (1.48.1) a small letter written slowly stays within 9 px of where it started; once the Pencil has really
    // drawn something (8 px of path), holding still no longer opens the Pencil menu (it used to drop the letter)
    // (steps under 1.5 px are hand tremor while holding still and do not count)
    if(!act.lp) act.lp = [act.sx, act.sy];
    const st = Math.hypot(sx - act.lp[0], sy - act.lp[1]);
    if(st >= 1.5){ act.trav = (act.trav || 0) + st; act.lp = [sx, sy]; if(act.trav > 8) clearTimeout(act.wheelT); }
    if(act.kind === 'stroke'){
      if(act.snapped){
        if(act.snapped === 'line'){ act.pts = densify([act.lineStart, toWorld(sx, sy)], false); }
        continue;
      }
      let X = sx, Y = sy;
      if(act.edge) [X, Y] = projectEdge(act.edge, sx, sy, act.w);
      if(Math.hypot(X - act.last[0], Y - act.last[1]) < 0.8) continue;
      act.last = [X, Y];
      act.pts.push(...toWorld(X, Y), pr);
      act.lastEv = [ev, sx, sy];
      if(Math.hypot(sx - act.anchor[0], sy - act.anchor[1]) > 3){ act.anchor = [sx, sy]; armHold(); }
    } else if(act.kind === 'erase'){ act.cursor = [sx, sy]; eraseAt(sx, sy); }
    else if(act.kind === 'space'){ moveSpace(toWorld(sx, sy)[1] - act.y0); }
    else if(act.kind === 'lasso'){ if(act.box){ act.poly = boxPoly(act.sx, act.sy, sx, sy); act.b1 = [sx, sy]; } else act.poly.push(sx, sy); }
    else if(act.kind === 'tape' || act.kind === 'place' || act.kind === 'pick'){ act.w1 = toWorld(sx, sy); if(act.kind === 'pick') compassTrack(act); }
  }
  // (1.61) draw a little ahead of the Pencil (preview only)
  if(act && act.kind === 'stroke' && act.lastEv){ const [ev, sx, sy] = act.lastEv; act.lastEv = null; Live.predict(act, ev === list[list.length - 1] ? e : ev, sx, sy); }
  drawLiveSoon();
}
/* (1.60) Highlighter "Stick to text" (prefs.hlSnap, switch #hlSnap next to the highlighter's colours).
   When on, a finished highlighter stroke is replaced by straight bands that sit exactly on the lines of text it was
   drawn over, as tall as the text: lines of imported pages (their page text, ptxt: PDFs from 1.52 on know where each
   line starts and ends; older imports and scans count as full-width rows) and lines of typed text boxes (measured on
   screen). Left and right the band follows where the highlighter went, cut to the line. A stroke drawn down across
   several lines marks each of them. With no text under it, a mostly level stroke becomes one straight band at its
   height; anything else (a circle, a tick) stays as drawn. The result is ordinary highlighter strokes (no new data). */
const HLS = {
  // lines of text near the stroke: {b: [x0, y0, x1, y1] world, segs: [[x0, x1], ...] words (pictures only) or null}
  lines(b, ym){
    const out = [];
    for(const it of cur.items.values()){
      if(it.t === 'i' && it.a){
        if(it.x > b[2] || it.x + it.w < b[0] || it.y > b[3] || it.y + it.h < b[1]) continue;
        // (1.60.1) measure the letters in the page picture itself; the read-out page text only knows roughly where
        // a line is (Claude-read pages and older imports have no line ends and only a guessed height)
        const px = this.picLines(it, b);
        if(px){ out.push(...px); continue; }
        const d = ptxtOf(it.a); if(!d || !Array.isArray(d.l)) continue;
        const L = d.l.filter(l => l && l[0] >= 0 && typeof l[1] === 'string').slice().sort((p, q) => p[0] - q[0]);
        const gaps = []; for(let i = 1; i < L.length; i++){ const g = L[i][0] - L[i-1][0]; if(g > 0.004) gaps.push(g); }
        gaps.sort((p, q) => p - q);
        const gap0 = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.02;
        for(let i = 0; i < L.length; i++){
          const l = L[i], hasX = l.length >= 4 && l[3] > l[2];
          const hf = l[4] > 0 ? l[4] : Math.min(gap0, i + 1 < L.length && L[i+1][0] > l[0] ? L[i+1][0] - l[0] : gap0) * 0.8;
          out.push({b: [it.x + (hasX ? l[2] : 0) * it.w, it.y + l[0] * it.h, it.x + (hasX ? l[3] : 1) * it.w, it.y + (l[0] + hf) * it.h], segs: null});
        }
      } else if(it.t === 'x'){
        const el = elMap.get(it.id); if(!el) continue;
        const q = itemBox(it); if(q[0] > b[2] || q[2] < b[0] || q[1] > b[3] || q[3] < b[1]) continue;
        for(const r of this.boxLines(el)) out.push({b: r, segs: null});
      }
    }
    return out;
  },
  // (1.60.1) text rows and words of a page picture inside box b (world), found from its dark pixels.
  // null when the picture is not loaded (then the page text is used).
  picLines(it, b){
    const el = elMap.get(it.id), img = el && el._img;
    if(!img || !img.complete || !img.naturalWidth) return null;
    const X0 = clamp(b[0], it.x, it.x + it.w), X1 = clamp(b[2], it.x, it.x + it.w);
    const Y0 = clamp(b[1], it.y, it.y + it.h), Y1 = clamp(b[3], it.y, it.y + it.h);
    if(X1 - X0 < 2 || Y1 - Y0 < 2) return [];
    const k = img.naturalWidth / it.w, kh = img.naturalHeight / it.h;
    const s = Math.min(3, k, 1400 / (X1 - X0), 1400 / (Y1 - Y0));   // canvas pixels per world unit
    const cw = Math.max(1, Math.round((X1 - X0) * s)), ch = Math.max(1, Math.round((Y1 - Y0) * s));
    const cv = this.cv || (this.cv = document.createElement('canvas'));
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d', {willReadFrequently: true});
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    let data;
    try {
      ctx.drawImage(img, (X0 - it.x) * k, (Y0 - it.y) * kh, (X1 - X0) * k, (Y1 - Y0) * kh, 0, 0, cw, ch);
      data = ctx.getImageData(0, 0, cw, ch).data;
    } catch(e){ return null; }
    finally { cv.width = cv.height = 1; }
    // ink = clearly darker than the paper (paper = a bright percentile, so grey scans work too)
    const lum = new Uint8Array(cw * ch);
    for(let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (data[i] * 299 + data[i+1] * 587 + data[i+2] * 114) / 1000;
    const hist = new Uint32Array(256); for(let j = 0; j < lum.length; j += 7) hist[lum[j]]++;
    let tot = 0, cnt = 0; for(const v of hist) tot += v;
    let bg = 255; for(let v = 255; v >= 0; v--){ cnt += hist[v]; if(cnt >= tot * 0.3){ bg = v; break; } }
    const thr = bg - Math.max(45, bg * 0.25);
    const rows = new Uint32Array(ch);
    for(let y = 0; y < ch; y++){ let n = 0; const o = y * cw; for(let x = 0; x < cw; x++) if(lum[o + x] < thr) n++; rows[y] = n; }
    const minRow = Math.max(1, cw * 0.002);
    let groups = [];
    for(let y = 0; y < ch; y++){
      if(rows[y] < minRow) continue;
      const g = groups[groups.length - 1];
      if(g && y - g[1] <= 1) g[1] = y; else groups.push([y, y]);
    }
    if(!groups.length) return [];
    // dots, accents and umlaut points join the row of letters next to them
    const hs = groups.map(g => g[1] - g[0] + 1).sort((p, q) => p - q), hMed = hs[Math.floor(hs.length * 0.75)] || 1;
    let changed = true;
    while(changed){
      changed = false;
      for(let i = 0; i < groups.length; i++){
        const g = groups[i], gh = g[1] - g[0] + 1;
        if(gh >= hMed * 0.45) continue;
        const up = groups[i-1], dn = groups[i+1];
        const du = up ? g[0] - up[1] : Infinity, dd = dn ? dn[0] - g[1] : Infinity;
        const tgt = du <= dd ? up : dn, gap = Math.min(du, dd);
        if(!tgt || gap > Math.max(2, (tgt[1] - tgt[0] + 1) * 0.5)) continue;
        tgt[0] = Math.min(tgt[0], g[0]); tgt[1] = Math.max(tgt[1], g[1]);
        groups.splice(i, 1); changed = true; break;
      }
    }
    const out = [];
    for(const g of groups){
      const gh = g[1] - g[0] + 1;
      if(gh < 3) continue;
      // words: runs of ink columns, split where the gap is wider than a letter gap
      const col = new Uint8Array(cw);
      for(let y = g[0]; y <= g[1]; y++){ const o = y * cw; for(let x = 0; x < cw; x++) if(lum[o + x] < thr) col[x] = 1; }
      const wgap = Math.max(2, gh * 0.2), segs = [];
      let st = -1, last = -1;
      for(let x = 0; x < cw; x++){
        if(!col[x]) continue;
        if(st < 0){ st = x; } else if(x - last > wgap){ segs.push([st, last]); st = x; }
        last = x;
      }
      if(st >= 0) segs.push([st, last]);
      if(!segs.length) continue;
      const wx = c => X0 + c / s, wy = r => Y0 + r / s;
      out.push({b: [wx(segs[0][0]), wy(g[0]), wx(segs[segs.length - 1][1] + 1), wy(g[1] + 1)], segs: segs.map(q => [wx(q[0]), wx(q[1] + 1)]),
        cut: g[0] === 0 || g[1] === ch - 1});
    }
    return out;
  },
  // rows of a typed text box in world units, from the on-screen rectangles of its text
  boxLines(el){
    const sr = stage.getBoundingClientRect(), rows = [];
    const toW = (x, y) => [(x - sr.left - cam.ox) / cam.z, (y - sr.top - cam.oy) / cam.z];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const rg = document.createRange();
    for(let n = walk.nextNode(); n; n = walk.nextNode()){
      if(!n.nodeValue.trim()) continue;
      rg.selectNodeContents(n);
      for(const r of rg.getClientRects()){
        if(r.width < 1 || r.height < 1) continue;
        const [x0, y0] = toW(r.left, r.top), [x1, y1] = toW(r.right, r.bottom);
        const row = rows.find(w => Math.min(w[3], y1) - Math.max(w[1], y0) > 0.5 * Math.min(w[3] - w[1], y1 - y0));
        if(row){ row[0] = Math.min(row[0], x0); row[1] = Math.min(row[1], y0); row[2] = Math.max(row[2], x1); row[3] = Math.max(row[3], y1); }
        else rows.push([x0, y0, x1, y1]);
      }
    }
    return rows;
  },
  // a straight band from x0 to x1 covering y0..y1 (round ends kept inside)
  band(x0, x1, y0, y1){
    const h = y1 - y0, r = h / 2, cy = (y0 + y1) / 2;
    let a = x0 + r * 0.6, e = x1 - r * 0.6;
    if(e < a){ a = e = (x0 + x1) / 2; }
    const p = [];
    for(let k = 0; k < 4; k++) p.push(a + (e - a) * k / 3, cy, 0.5);
    return {w: h, p};
  },
  // where the band goes left to right on one line: whole words the stroke touched, or the stroke cut to the line
  span(l, bx0, bx1){
    if(!l.segs) return [Math.max(l.b[0], bx0), Math.min(l.b[2], bx1)];
    const h = l.b[3] - l.b[1], tol = Math.min(h * 0.15, 4);
    const hit = l.segs.filter(q => Math.min(q[1], bx1) - Math.max(q[0], bx0) > tol);
    if(!hit.length) return null;
    return [hit[0][0], hit[hit.length - 1][1]];
  },
  snap(pts, w){
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const ys = [];
    for(let i = 0; i < pts.length; i += 3){ bx0 = Math.min(bx0, pts[i]); bx1 = Math.max(bx1, pts[i]); by0 = Math.min(by0, pts[i+1]); by1 = Math.max(by1, pts[i+1]); ys.push(pts[i+1]); }
    ys.sort((p, q) => p - q);
    const ym = ys[Math.floor(ys.length / 2)];
    const r = w / 2;
    // look around the stroke; a bigger area if a line of text runs past its edge (big headings)
    let all = [];
    for(let R = Math.max(3 * w, 50), k = 0; k < 4; k++, R *= 2){
      all = this.lines([bx0 - R, Math.min(by0, ym) - R, bx1 + R, Math.max(by1, ym) + R], ym)
        .filter(l => Math.min(l.b[2], bx1) - Math.max(l.b[0], bx0) > 1);
      if(!all.some(l => l.cut && l.b[1] - 2 <= ym && l.b[3] + 2 >= ym)) break;
    }
    all = all.filter(l => !l.cut || (l.b[1] <= ym && l.b[3] >= ym));
    let pick = [];
    if(all.length){
      const near = all.filter(l => l.b[1] - Math.max(r, 2) <= by1 && l.b[3] + Math.max(r, 2) >= by0);
      const hs = (near.length ? near : all).map(l => l.b[3] - l.b[1]).sort((p, q) => p - q), h = hs[Math.floor(hs.length / 2)];
      if(by1 - by0 < h * 0.9){
        // one swipe along a line: the line holding the stroke's middle height (or the nearest one)
        let best = null, bd = Infinity;
        for(const l of all){
          const lh = l.b[3] - l.b[1], d = ym < l.b[1] ? l.b[1] - ym : ym > l.b[3] ? ym - l.b[3] : 0;
          const dc = Math.abs((l.b[1] + l.b[3]) / 2 - ym);
          if(d > Math.max(lh * 0.6, r)) continue;
          if(d * 1000 + dc < bd){ bd = d * 1000 + dc; best = l; }
        }
        if(best) pick = [best];
      } else {
        pick = all.filter(l => { const c = (l.b[1] + l.b[3]) / 2; return c >= by0 - (l.b[3] - l.b[1]) * 0.25 && c <= by1 + (l.b[3] - l.b[1]) * 0.25; });
      }
    }
    const res = [];
    for(const l of pick.sort((p, q) => p.b[1] - q.b[1])){
      const sp = this.span(l, bx0, bx1); if(!sp || sp[1] - sp[0] < 1) continue;
      const h = l.b[3] - l.b[1], pad = l.segs ? h * 0.08 : 0;
      res.push(this.band(sp[0] - pad, sp[1] + pad, l.b[1] - pad, l.b[3] + pad));
    }
    if(res.length) return res;
    // no text under it: a mostly level stroke becomes one straight band at its height
    if(bx1 - bx0 > 2 * (by1 - by0) && bx1 - bx0 > w) return [this.band(bx0 - r, bx1 + r, ym - r, ym + r)];
    return [];
  }
};
function endTool(e){
  const a = act; act = null;
  clearTimeout(a.hold); clearTimeout(a.wheelT);
  clearLive();
  if(a.kind === 'stroke'){
    Scribe.release();
    if(a.pts.length < 3) return;
    const it = {t: 's', id: 's' + newId(), c: a.c, w: a.w, hl: a.hl, p: a.pts};
    if(a.mk){ it.mk = 1; it.at = Date.now(); }
    const handwriting = a.tool === 'pen' && !a.snapped && !a.hl && !a.mk && !a.edge;
    // (1.60) highlighter "Stick to text": the stroke becomes straight bands on the text lines under it
    if(a.tool === 'hl' && prefs.hlSnap && !a.snapped && !a.edge){
      const list = HLS.snap(a.pts, a.w).map(b => Object.assign({}, it, {id: 's' + newId(), w: b.w, p: b.p}));
      if(list.length){ addItems(list); return; }
    }
    addItems([it]);
    if(handwriting) WA.stroke(it);   // reference line: notes which line is being written (never moves ink)
    if(handwriting) Scribe.add(it);
  } else if(a.kind === 'erase'){
    finishTextErase(a);
    // one undo step: originals that were cut back in, pieces left over out
    const was = new Set(a.removed.map(it => it.id));
    const before = a.removed.map(it => [it.id, it]).concat([...a.added.keys()].filter(id => !was.has(id)).map(id => [id, null]));
    const after = a.removed.filter(it => !a.added.has(it.id)).map(it => [it.id, null]).concat([...a.added.values()].map(it => [it.id, it]));
    if(before.length) commit(before, after);
    if(eraseOnce){ const back = eraseOnce; setTool(back); }
  } else if(a.kind === 'lasso'){
    finishLasso(a);
  } else if(a.kind === 'tape'){
    const [x0, y0] = a.w0, [x1, y1] = a.w1 || a.w0;
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if(w * cam.z < 14 || h * cam.z < 8){ tapAt(a.target, a.sx, a.sy); return; }
    addItems([{t: 'tp', id: 'p' + newId(), x: Math.min(x0, x1), y: Math.min(y0, y1), w, h}]);
  } else if(a.kind === 'place'){
    placeAt(a);
  } else if(a.kind === 'pick'){
    finishPick(a);
  } else if(a.kind === 'space'){
    if(a.orig.length && Math.abs(a.dy) > 0.5) commit(a.orig.map(it => [it.id, it]), a.orig.map(it => [it.id, cur.items.get(it.id)]));
    else if(a.orig.length) setItems(a.orig.map(it => [it.id, it]));
  }
}

/* live preview layer */
let liveRaf = 0;
function drawLiveSoon(){ if(!liveRaf) liveRaf = requestAnimationFrame(() => { liveRaf = 0; drawLive(); }); }
function clearLive(){ liveCtx.setTransform(1, 0, 0, 1, 0, 0); liveCtx.clearRect(0, 0, liveCv.width, liveCv.height); if(!act && liveCv.style.opacity){ liveCv.style.opacity = ''; liveCv.classList.remove('hl-mul'); } }
/* (1.61) The stroke being written. Preview only: what is saved and drawn after lifting the pen is unchanged.
   - A long stroke (from LIVE_MIN points) is no longer rebuilt from its first point every frame: the part that can no
     longer change is drawn once into Live.bake and only the end is rebuilt. The shape comes from the same
     strokeShape (it only looks a few points to each side), so it is the same outline, drawn in pieces that overlap
     by two recorded points (no seams, also in tight bends).
   - Drawing slightly ahead of the Pencil: the preview runs a few milliseconds ahead along the Pencil's current
     direction (the system's predicted points where the browser gives them), so the line keeps up with the tip.
     Never stored; dropped when the Pencil slows, turns sharply, stops or lifts. */
const LIVE_MIN = 120, LIVE_CHUNK = 60, LIVE_CTX = 6, LIVE_END = 6;
const PRED_MS = 10, PRED_MAX = 12, PRED_LIFE = 45;
const Live = {
  bake: null, bctx: null, upto: 0, key: '',
  // outline of samples s0..s1 of a strokeShape result, with round ends only where asked
  part(sh, s0, s1, capA, capB){ return inkOutline(sh.xs, sh.ys, sh.rs, sh.n, s0, s1, capA, capB, false); },
  reset(){ this.upto = 0; this.key = ''; if(this.bctx){ this.bctx.setTransform(1, 0, 0, 1, 0, 0); this.bctx.clearRect(0, 0, this.bake.width, this.bake.height); } },
  // shape of recorded points from..to (inclusive), with enough neighbours that the middle comes out exactly as in the whole stroke
  win(a, from, to, extra){
    const w0 = Math.max(0, from - LIVE_CTX), m = a.pts.length / 3;
    const end = Math.min(m - 1, to + LIVE_END);
    let p = a.pts.slice(w0 * 3, (end + 1) * 3);
    if(extra) p = p.concat(extra);
    return {sh: strokeShape({w: a.w, hl: a.hl, p}), w0};
  },
  // fill style for the whole stroke; the highlighter's see-through look comes from the canvas opacity
  draw(a, fill){
    const m = a.pts.length / 3;
    const tr = [dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy];
    const pred = a.pred && performance.now() - a.predAt < PRED_LIFE ? a.pred : null;
    if(m < LIVE_MIN || a.snapped || a.edge){
      if(this.upto) this.reset();
      liveCtx.setTransform(...tr); liveCtx.fillStyle = fill;
      const p = pred && !a.snapped && !a.edge ? a.pts.concat(pred) : a.pts;
      liveCtx.fill(strokePath({t: 's', c: a.c, w: a.w, hl: a.hl, p}, false));
      return;
    }
    if(!this.bake){ this.bake = document.createElement('canvas'); this.bctx = this.bake.getContext('2d'); }
    if(this.bake.width !== liveCv.width || this.bake.height !== liveCv.height){ this.bake.width = liveCv.width; this.bake.height = liveCv.height; this.reset(); }
    const key = [a.id, tr.join(','), fill, a.w, a.hl ? 1 : 0].join('|');
    if(key !== this.key || this.upto > m - 1){ this.reset(); this.key = key; }
    // draw into the bake whatever can no longer change (everything but the last few points)
    const ctx = this.bctx;
    while(m - 1 - this.upto > LIVE_CHUNK + LIVE_END + 2){
      const A = this.upto, B = m - 1 - LIVE_END - 2;
      const {sh, w0} = this.win(a, A, B);
      const s0 = A ? Math.max(0, sh.at[A - 2 - w0]) : 0, s1 = sh.at[B - w0];
      ctx.setTransform(...tr); ctx.fillStyle = fill;
      ctx.fill(this.part(sh, s0, s1, A === 0, false));
      this.upto = B;
    }
    liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    if(this.upto) liveCtx.drawImage(this.bake, 0, 0);
    const A = this.upto, {sh, w0} = this.win(a, A, m - 1, pred);
    const s0 = A ? Math.max(0, sh.at[A - 2 - w0]) : 0;
    liveCtx.setTransform(...tr); liveCtx.fillStyle = fill;
    if(sh.n - 1 > s0) liveCtx.fill(this.part(sh, s0, sh.n - 1, A === 0, true));
  },
  // where the Pencil will be a moment from now (screen px), or null
  predict(a, e, sx, sy){
    a.pred = null;
    if(e.pointerType !== 'pen' || a.snapped || a.edge) return;
    const t = e.timeStamp || performance.now();
    const h = a.ph || (a.ph = []);
    h.push([sx, sy, t]); while(h.length > 5 || (h.length > 3 && t - h[0][2] > 36)) h.shift();
    let px = null, py = null;
    const pe = e.getPredictedEvents ? e.getPredictedEvents() : null;
    if(pe && pe.length){ const q = pt(pe[pe.length - 1]); px = q[0] - sx; py = q[1] - sy; }
    else {
      // (1.61.2) follow the curve: speed and turning rate from the older and the newer half of the recent samples,
      // so on a curve the lead bends with it (1.61 went straight on, up to ~9 px off a curve, then snapped back)
      if(h.length < 3) return;
      const o = h[0], mid = h[Math.floor(h.length / 2)], dt1 = mid[2] - o[2], dt2 = t - mid[2];
      if(dt1 < 3 || dt2 < 3 || t - o[2] > 40) return;
      const vx = (mid[0] - o[0]) / dt1, vy = (mid[1] - o[1]) / dt1, ux = (sx - mid[0]) / dt2, uy = (sy - mid[1]) / dt2;
      const sv = Math.hypot(vx, vy), su = Math.hypot(ux, uy);
      if(sv < 0.08 || su < 0.08) return;                          // slow or stopping: no lead
      if(su < 0.6 * sv) return;                                   // slowing down hard
      let turn = Math.atan2(uy, ux) - Math.atan2(vy, vx);
      if(turn > Math.PI) turn -= 2 * Math.PI; else if(turn < -Math.PI) turn += 2 * Math.PI;
      const w = turn / ((t - o[2]) / 2);                            // turning rate (rad per ms)
      const ahead = (t - (mid[2] + t) / 2) + PRED_MS;              // from the newer half's middle to the end of the lead
      if(Math.abs(turn) > 1.0 || Math.abs(w * ahead) > 0.9) return;   // turning too hard to guess
      // the guess must agree with the Pencil's latest step (a corner is not a curve that keeps turning)
      const pv = h[h.length - 2], lx = sx - pv[0], ly = sy - pv[1];
      if(Math.hypot(lx, ly) > 0.5){
        let dd = Math.atan2(ly, lx) - (Math.atan2(uy, ux) + w * ((pv[2] + t) / 2 - (mid[2] + t) / 2));
        dd = Math.atan2(Math.sin(dd), Math.cos(dd));
        if(Math.abs(dd) > 0.12) return;
      }
      const head = Math.atan2(uy, ux) + w * ((t - (mid[2] + t) / 2) + PRED_MS / 2);
      px = Math.cos(head) * su * PRED_MS; py = Math.sin(head) * su * PRED_MS;
    }
    const d = Math.hypot(px, py);
    if(!(d > 0.5)) return;
    if(d > PRED_MAX){ px *= PRED_MAX / d; py *= PRED_MAX / d; }
    const pr = a.pts[a.pts.length - 1];
    a.pred = [...toWorld(sx + px, sy + py), pr];
    a.predAt = performance.now();
    clearTimeout(a.predT); a.predT = setTimeout(drawLiveSoon, PRED_LIFE + 5);   // take the lead away if the Pencil stops
  }
};
function drawLive(){
  clearLive();
  const hlA = act && act.kind === 'stroke' && act.hl ? String(isDark() && !onPaperAt(paperRects(), act.pts[0], act.pts[1]) ? 0.34 : 0.4) : '';
  if(liveCv.style.opacity !== hlA) liveCv.style.opacity = hlA;
  // (1.62) the highlight being drawn blends into the page like the finished one
  liveCv.classList.toggle('hl-mul', !!hlA && hlMultiply(onPaperAt(paperRects(), act.pts[0], act.pts[1]), [act.pts[0], act.pts[1], act.pts[0], act.pts[1]], []));
  if(!act){ WA.drawAfter(); return; }
  if(act.kind === 'stroke'){
    const paper = onPaperAt(paperRects(), act.pts[0], act.pts[1]);
    Live.draw(act, inkColor(act.c, false, paper));
    liveCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
    if(act.tool === 'pen' && !act.hl && !act.mk) WA.guide(act);
  } else if(act.kind === 'lasso'){
    const p = act.poly;
    liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    liveCtx.beginPath(); liveCtx.moveTo(p[0], p[1]);
    for(let i = 2; i < p.length; i += 2) liveCtx.lineTo(p[i], p[i+1]);
    if(act.box) liveCtx.closePath();
    liveCtx.setLineDash([6, 5]); liveCtx.lineWidth = 1.5; liveCtx.strokeStyle = tokens.accent; liveCtx.stroke(); liveCtx.setLineDash([]);
  } else if(act.kind === 'tape' && act.w1){
    liveCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
    liveCtx.globalAlpha = 0.6; liveCtx.fillStyle = tokens.tape;
    liveCtx.fillRect(Math.min(act.w0[0], act.w1[0]), Math.min(act.w0[1], act.w1[1]), Math.abs(act.w1[0] - act.w0[0]), Math.abs(act.w1[1] - act.w0[1]));
    liveCtx.globalAlpha = 1;
  } else if(act.kind === 'space'){
    liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const y0 = act.y0 * cam.z + cam.oy, y1 = (act.y0 + act.dy) * cam.z + cam.oy;
    liveCtx.globalAlpha = 0.1; liveCtx.fillStyle = tokens.accent; liveCtx.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0)); liveCtx.globalAlpha = 1;
    liveCtx.strokeStyle = tokens.accent; liveCtx.lineWidth = 1.5; liveCtx.setLineDash([8, 6]);
    liveCtx.beginPath(); liveCtx.moveTo(0, y0); liveCtx.lineTo(W, y0); liveCtx.moveTo(0, y1); liveCtx.lineTo(W, y1); liveCtx.stroke(); liveCtx.setLineDash([]);
  } else if(act.kind === 'pick' && act.w1){
    drawPickPreview(act);
  } else if(act.kind === 'erase' && act.cursor){
    liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    liveCtx.beginPath(); liveCtx.arc(act.cursor[0], act.cursor[1], eraserRadius(), 0, Math.PI * 2);
    liveCtx.lineWidth = 1.5; liveCtx.strokeStyle = tokens.muted; liveCtx.stroke();
  }
}
