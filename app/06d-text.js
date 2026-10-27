/* Inkwell app: Text boxes, text size and colour, spelling, formulas, overlays.
   (1.64.1) split out of app/06-writing.js. All app/ files share one global scope and are run in order by app.js;
   code that runs while a file loads must not use a later file (tests/unit/load_order.test.js). */
'use strict';
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
    nt.lang = Spell.lang(null);   // (1.66) the box keeps the spelling language it was started in
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
  Spell.clear();
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
  Spell.typedAt = Date.now(); Spell.hide(); Spell.soon();
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
  if(b.dataset.act === 'spell'){ Spell.open(b); return; }   // (1.66) on/off and language
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
  fmtBar.classList.toggle('pf-mode', fld);
  if(editing || fld) TSize.label(); else $('tsizeVal').textContent = '17';
  const f = fld && PFmt.f();
  fmtBar.querySelectorAll('[data-cmd]').forEach(b => b.classList.toggle('on', !!f && !!f[{bold: 'b', italic: 'it', underline: 'u'}[b.dataset.cmd]]));
  Spell.render();
  barFade();
}
// (1.55) spell check while typing (prefs `spell`, missing = on, per device).
// (1.66) Inkwell's own checker: Hunspell with built-in word lists (lib/spell, run in a Web Worker), the same on the
// iPad and the PC and offline once a language was used. Wrong words in the box being typed in get a red wavy line
// (CSS Custom Highlight API, nothing is added to the text). Tapping such a word shows fixes and "Add to dictionary".
// Language: prefs.spellLang for new boxes, a box can have its own (item field `lang`; boxes without it use
// prefs.spellLang, so old notes keep working). Added words: prefs.spellWords (this device).
// PDF form fields keep the system's spell check. If a word list cannot be loaded, the system's check is used.
const SPELL_LANGS = [['de-CH', 'Deutsch (Schweiz)'], ['de-DE', 'Deutsch (Deutschland)'], ['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['pt-PT', 'Português (Portugal)'], ['pt-BR', 'Português (Brasil)']];
const SPELL_WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
// the words of a text box that are checked: [{n: text node, s, e, w}]. Not checked: links to pages, formulas,
// words touching digits (3x, km2), words with capitals inside (USA, iPad), web and mail addresses
function spellWords(el){
  const out = [];
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {acceptNode: n => n.parentElement && n.parentElement.closest('a.pl,.katex,code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  for(let n = tw.nextNode(); n; n = tw.nextNode()){
    const t = n.data;
    for(const m of t.matchAll(SPELL_WORD)){
      const w = m[0], s = m.index, e = s + w.length;
      if(w.length < 2 || w.length > 40) continue;
      if(/\d/.test(t[s - 1] || '') || /\d/.test(t[e] || '')) continue;
      if(/\p{Lu}/u.test(w.slice(1))) continue;
      let a = s, b = e;
      while(a > 0 && !/\s/.test(t[a - 1])) a--;
      while(b < t.length && !/\s/.test(t[b])) b++;
      if(/[/@]|\.\p{L}/u.test(t.slice(a, b))) continue;
      out.push({n, s, e, w: w.replace(/’/g, "'")});
    }
  }
  return out;
}
const Spell = {
  worker: null, seq: 0, wait: new Map(), known: new Map(), failed: new Set(), typedAt: 0, movedAt: 0, bad: [], at: null, timer: 0,
  on(){ return prefs.spell !== false; },
  // own checker in use (else the system's): on, and the box's language could be loaded
  active(lang){ return Spell.on() && typeof Worker !== 'undefined' && !Spell.failed.has(lang || Spell.lang(null)); },
  lang(it){
    const ok = l => SPELL_LANGS.some(x => x[0] === l);
    if(it && ok(it.lang)) return it.lang;
    if(ok(prefs.spellLang)) return prefs.spellLang;
    const n = (navigator.language || '').toLowerCase();
    return n === 'de-ch' ? 'de-CH' : n.startsWith('de') ? 'de-DE' : n === 'en-us' ? 'en-US' : n === 'pt-br' ? 'pt-BR' : n.startsWith('pt') ? 'pt-PT' : 'en-GB';
  },
  langName(l){ const x = SPELL_LANGS.find(x => x[0] === l); return x ? x[1] : l; },
  added(w){ const list = prefs.spellWords || []; return list.includes(w) || list.includes(w.toLowerCase()); },
  call(msg){
    if(!Spell.worker){
      Spell.worker = new Worker('lib/spell/worker.js');
      Spell.worker.onmessage = e => { const f = Spell.wait.get(e.data.id); if(f){ Spell.wait.delete(e.data.id); f(e.data); } };
      Spell.worker.onerror = e => { console.warn('spell worker', e.message); for(const f of Spell.wait.values()) f({error: e.message || 'worker'}); Spell.wait.clear(); };
    }
    return new Promise(res => { const id = ++Spell.seq; Spell.wait.set(id, res); Spell.worker.postMessage(Object.assign({id}, msg)); });
  },
  fail(lang, err){
    if(Spell.failed.has(lang)) return;
    Spell.failed.add(lang); console.warn('spell', lang, err);
    toast(navigator.onLine === false ? `Spell check (${Spell.langName(lang)}) needs the internet once to download its word list. Until then the iPad's own check is used.` : `Spell check (${Spell.langName(lang)}) could not be loaded. The iPad's own check is used.`);
    if(editing){ const el = elMap.get(editing.id); if(el) Spell.set(el); }
  },
  // the box being typed in: system marks only when our checker is not in use
  set(el){
    const it = editing && cur ? cur.items.get(editing.id) : null, lang = Spell.lang(it);
    el.spellcheck = Spell.on() && !Spell.active(lang);
    el.setAttribute('autocorrect', Spell.on() ? 'on' : 'off');
    el.setAttribute('lang', lang);
    Spell.soon(0);
  },
  soon(ms){ clearTimeout(Spell.timer); Spell.timer = setTimeout(() => Spell.check(), ms == null ? 350 : ms); },
  async check(){
    const el = editing && elMap.get(editing.id), it = el && cur.items.get(editing.id), lang = Spell.lang(it);
    if(!el || !Spell.active(lang)){ Spell.clear(); return; }
    const known = Spell.known.get(lang) || new Map(); Spell.known.set(lang, known);
    const ask = [...new Set(spellWords(el).map(x => x.w).filter(w => !known.has(w)))];
    if(ask.length){
      const r = await Spell.call({op: 'check', lang, words: ask});
      if(r.error){ Spell.fail(lang, r.error); Spell.clear(); return; }
      const bad = new Set(r.bad);
      for(const w of ask) known.set(w, !bad.has(w));
      if(known.size > 20000) Spell.known.set(lang, new Map());
    }
    if(!editing || elMap.get(editing.id) !== el) return;
    // the word being typed is not marked until the cursor leaves it
    const g = getSelection(), typing = Spell.typedAt >= Spell.movedAt;
    Spell.bad = spellWords(el).filter(x => known.get(x.w) === false && !Spell.added(x.w)
      && !(typing && g.isCollapsed && g.anchorNode === x.n && g.anchorOffset >= x.s && g.anchorOffset <= x.e));
    Spell.paint();
  },
  paint(){
    if(!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
    if(!Spell.bad.length){ CSS.highlights.delete('inkspell'); return; }
    CSS.highlights.set('inkspell', new Highlight(...Spell.bad.map(x => { const r = document.createRange(); r.setStart(x.n, x.s); r.setEnd(x.n, x.e); return r; })));
  },
  clear(){ Spell.bad = []; if(window.CSS && CSS.highlights) CSS.highlights.delete('inkspell'); Spell.hide(); },
  // the wrong word the cursor is in (after a tap), or null
  atCaret(){
    const g = getSelection();
    if(!editing || !g.rangeCount || !g.isCollapsed) return null;
    return Spell.bad.find(x => x.n === g.anchorNode && g.anchorOffset >= x.s && g.anchorOffset <= x.e && x.n.isConnected && x.n.data.slice(x.s, x.e).replace(/’/g, "'") === x.w) || null;
  },
  async show(x){
    const bar = $('spellBar');
    if(Spell.at === x && !bar.hidden) return;
    Spell.at = x;
    const lang = Spell.lang(cur.items.get(editing.id));
    bar.innerHTML = '<span class="spell-wait">…</span><button class="spell-add" data-add>Add to dictionary</button>';
    bar.hidden = false; Spell.place();
    const r = await Spell.call({op: 'suggest', lang, word: x.w});
    if(Spell.at !== x) return;
    const list = (r.list || []).slice(0, 4);
    bar.innerHTML = (list.length ? list.map(w => `<button data-fix="${esc(w)}">${esc(w)}</button>`).join('') : '<span class="spell-none">No suggestions</span>')
      + '<button class="spell-add" data-add>Add to dictionary</button>';
    Spell.place();
  },
  place(){
    const bar = $('spellBar'), x = Spell.at;
    if(bar.hidden || !x) return;
    if(!x.n.isConnected){ Spell.hide(); return; }
    const r = document.createRange(); r.setStart(x.n, x.s); r.setEnd(x.n, x.e);
    const q = r.getBoundingClientRect(), bw = bar.offsetWidth, bh = bar.offsetHeight;
    let y = q.bottom + 8; if(y + bh > innerHeight - 8) y = Math.max(8, q.top - bh - 8);
    bar.style.left = clamp(q.left + q.width / 2 - bw / 2, 8, Math.max(8, innerWidth - bw - 8)) + 'px';
    bar.style.top = y + 'px';
  },
  hide(){ Spell.at = null; const bar = $('spellBar'); if(bar) bar.hidden = true; },
  fix(word){
    const x = Spell.at, el = editing && elMap.get(editing.id);
    Spell.hide();
    if(!x || !el || !x.n.isConnected) return;
    if(document.activeElement !== el) el.focus({preventScroll: true});
    const r = document.createRange(); r.setStart(x.n, x.s); r.setEnd(x.n, x.e);
    const g = getSelection(); g.removeAllRanges(); g.addRange(r);
    document.execCommand('insertText', false, word);   // keeps the formatting of the word, undo works
  },
  add(){
    const x = Spell.at; Spell.hide(); if(!x) return;
    prefs.spellWords = [...new Set([...(prefs.spellWords || []), x.w])].slice(-2000); savePrefs();
    toast(`"${x.w}" added to the dictionary`);
    Spell.check(); Spell.renderPop();
  },
  render(){ const b = fmtBar.querySelector('[data-act="spell"]'); if(b){ b.classList.toggle('on', Spell.on()); b.setAttribute('aria-pressed', Spell.on() ? 'true' : 'false'); } },
  setOn(on){
    prefs.spell = !!on; savePrefs();
    document.querySelectorAll('input.pf-tx, textarea.pf-tx').forEach(c => { c.spellcheck = Spell.on(); });
    if(editing){
      const el = elMap.get(editing.id);
      if(el){
        Spell.set(el);
        // browsers only redraw the system's marks after the box is focused again
        const keep = TSize.offsets(el);
        el.blur(); el.focus({preventScroll: true});
        TSize.restore(el, keep);
      }
    }
    if(!Spell.on()) Spell.clear();
    Spell.render(); Spell.renderPop();
  },
  toggle(){ Spell.setOn(!Spell.on()); toast(Spell.on() ? 'Spell check on: misspelled words are underlined while you type' : 'Spell check off'); },
  // picking a language: for the box being typed in, and for new boxes from now on
  setLang(l){
    if(!SPELL_LANGS.some(x => x[0] === l)) return;
    prefs.spellLang = l; savePrefs();
    if(editing && cur){
      const it = cur.items.get(editing.id);
      if(it && it.lang !== l){ cur.items.set(it.id, Object.assign({}, it, {lang: l})); saveContentSoon(); }
      const el = elMap.get(editing.id); if(el) Spell.set(el);
    }
    Spell.failed.delete(l);
    Spell.renderPop();
  },
  renderPop(){
    const p = $('spellPop'); if(!p || p.hidden) return;
    const it = editing && cur ? cur.items.get(editing.id) : null, l = Spell.lang(it), on = Spell.on();
    p.querySelectorAll('[data-spell]').forEach(b => b.classList.toggle('on', (b.dataset.spell === 'on') === on));
    $('spellLangs').innerHTML = SPELL_LANGS.map(([c, n]) => `<button class="menu-item${c === l ? ' on' : ''}" data-lang="${c}"${on ? '' : ' disabled'}>${esc(n)}</button>`).join('');
    $('spellNote').textContent = editing ? 'For this text box and new ones.' : 'For new text boxes.';
    const n = (prefs.spellWords || []).length;
    $('spellForget').hidden = !n; $('spellForget').textContent = `Forget ${n} added word${n === 1 ? '' : 's'}`;
  },
  open(b){ Spell.hide(); openPop('spellPop', b); Spell.renderPop(); },
  // load the usual language soon after start, so the first box is checked right away (and it is stored for offline)
  warm(){ if(Spell.active()) Spell.call({op: 'load', lang: Spell.lang(null)}).then(r => { if(r.error) Spell.failed.add(Spell.lang(null)); }); }
};
$('spellPop').addEventListener('pointerdown', e => { if(e.target.closest('button')) e.preventDefault(); });
$('spellPop').addEventListener('mousedown', e => { if(e.target.closest('button')) e.preventDefault(); });
$('spellPop').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  if(b.dataset.spell) Spell.setOn(b.dataset.spell === 'on');
  else if(b.dataset.lang) Spell.setLang(b.dataset.lang);
  else if(b.id === 'spellForget'){ prefs.spellWords = []; savePrefs(); Spell.check(); Spell.renderPop(); toast('Added words forgotten'); }
});
$('spellBar').addEventListener('pointerdown', e => e.preventDefault());
$('spellBar').addEventListener('mousedown', e => e.preventDefault());
$('spellBar').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  if(b.dataset.fix != null) Spell.fix(b.dataset.fix);
  else if(b.hasAttribute('data-add')) Spell.add();
});
document.addEventListener('selectionchange', () => {
  if(!editing) return;
  if(Date.now() - Spell.typedAt > 150) Spell.movedAt = Date.now();
  clearTimeout(Spell.selTimer);
  Spell.selTimer = setTimeout(() => {
    if(!editing) return;
    const x = Spell.atCaret();
    if(x && Spell.movedAt > Spell.typedAt) Spell.show(x); else Spell.hide();
    if(Spell.movedAt > Spell.typedAt) Spell.soon(0);   // the word just left gets checked
  }, 250);
});
setTimeout(() => Spell.warm(), 5000);
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
    else if(a === 'spell'){ Spell.toggle(); const c = pfFocus.c; c.blur(); c.focus({preventScroll: true}); }
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
  Spell.place();
}
