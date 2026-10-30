/* Inkwell app, part 1 of 13: Basics, preferences and UI state.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
/* Inkwell — notes with typed text and Apple Pencil ink on an infinite page. */
// (1.61.3) pure code with no dependencies on the page lives in core/*.js (loaded before app.js; also run by the
// fast tests in tests/unit with Node). Same names as before, so the rest of app.js is unchanged.
const {newId, esc, clamp, MM, A4W, A4H, pad2, tsMs, tsKey, tsEq, hhmm, fmtDate, debounce} = InkUtil;
const {hexEdges, ser, opOf, deser, r1, shapePoint, strokeShape, inkPass, strokePath, inkOutline, strokeBox} = InkGeo;
const {stable, mergeKeys, mergeContent} = InkMerge;
const {calcEval, parseFn, texPlain} = InkText;

/* =====================================================================
   Basics
   ===================================================================== */
const $ = id => document.getElementById(id);
const CFG = window.INKWELL_CONFIG || {};
const TABS = 6;
const LSget = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const PULL_OVERLAP = 60000, PULL_LIST = 1000;

let toastTimer;
function toast(msg, btnLabel, onBtn){
  const t = $('toast'), b = $('toastBtn');
  $('toastText').textContent = msg;
  if(btnLabel){ b.hidden = false; b.textContent = btnLabel; b.onclick = () => { t.hidden = true; onBtn(); }; }
  else b.hidden = true;
  const was = !t.hidden;
  t.hidden = false;
  if(was){ t.classList.remove('pop-in'); void t.offsetWidth; }   // a new message pops in again
  t.classList.add('pop-in');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, btnLabel ? 9000 : 3800);
  noteHide();   // the bigger message is the one to read now
}
/* (1.72) A short, small message at the bottom when a switch or setting is changed ("Finger draws on"). Its own
   element, so it never pushes away a message with a button (Undo, Reload, Stop); it sits just above such a message. */
let noteTimer;
function note(msg){
  const n = $('note'); if(!n) return;
  const t = $('toast'), up = t && !t.hidden ? t.offsetHeight + 8 : 0;
  n.style.setProperty('--up', up + 'px');
  n.textContent = msg;
  const was = !n.hidden;
  n.hidden = false;
  if(was){ n.classList.remove('pop-in'); void n.offsetWidth; }
  n.classList.add('pop-in');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(noteHide, 1800);
}
function noteHide(){ clearTimeout(noteTimer); const n = $('note'); if(n) n.hidden = true; }
const onOff = (name, on) => name + (on ? ' on' : ' off');

/* =====================================================================
   Preferences and UI state (per device)
   ===================================================================== */
const DEFAULT_PREFS = {
  tool: 'pen',
  pen: {c: 'auto', s: 40}, hl: {c: '#F5C400', s: 40}, eraser: {s: 30, mode: 'stroke'}, mark: {s: 40},
  wheel: 'right',
  hwSearch: true,  // Claude reads handwriting in the background so search finds it (true = handwriting + imported pages, 'docs' = imported pages only (1.44), false = off)  // Pencil menu on press and hold: 'right' (opens left of the pen), 'left', or 'off'
  penFavs: ['auto', '#1F4FCF', '#C2362B', '#167A3C', '#E07A10', '#7B3FBF'],
  hlFavs: ['#F5C400', '#4CC26B', '#FF6FA3', '#3BA5F0'],
  finger: false,
  autoText: false,   // Write to text: pen writing becomes a typed text box (needs sign-in)
  snapLines: true,
  lassoMode: 'free', // (1.53) Select tool: 'free' loop or 'box' rectangle; (1.63) 'tap' = tap things to select them
  refLine: false,   // Reference line (1.42): faint line under the handwriting line being written
  ruler: {on: false, cx: null, cy: null, a: 0},
  bg: {type: 'grid', sx: 5 * MM, sy: 5 * MM},
  theme: 'auto',   // 'auto' follows the iPad, or 'light' / 'dark'
  snapHold: 550,   // ms the pen must rest before a stroke is straightened; 0 = off
  leftEdge: false, // true: the page stops at its left edge (endless only up, down and right)
  zMax: 8,         // highest zoom (1 = 100 %); set from Settings with "Use current zoom" or (1.70) by holding the zoom %
  zLock: false,    // (1.70) double-tap the zoom %: pinch, Ctrl+wheel, Fit and the 100 % tap stop changing the zoom
  askMode: 'tutor',
  askModel: 'auto', // 'auto' (cheap model decides), 'fast' (Haiku) or 'smart' (Sonnet)
  focus: false, open: {}
};
const prefs = Object.assign({}, DEFAULT_PREFS, LSget('inkwell.prefs', {}));
const Z_TOP = 8, Z_MIN = 0.1;
const zMax = () => { const m = +prefs.zMax; return m >= 0.5 && m <= Z_TOP ? m : Z_TOP; };
for(const k of ['pen', 'hl', 'eraser', 'mark', 'ruler', 'bg']) prefs[k] = Object.assign({}, DEFAULT_PREFS[k], prefs[k] || {});
const savePrefs = debounce(() => LSset('inkwell.prefs', prefs), 300);
// 1.41 had prefs.assist {level, space}; 1.42 keeps only the reference line (on if levelling was on)
if(prefs.assist){ if(prefs.assist.level && !LSget('inkwell.prefs', {}).hasOwnProperty('refLine')) prefs.refLine = true; delete prefs.assist; savePrefs(); }
const ui = Object.assign({nb: null, sec: null, page: null}, LSget('inkwell.ui', {}));
const saveUi = () => LSset('inkwell.ui', ui);
