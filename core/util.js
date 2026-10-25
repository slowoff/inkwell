/* Inkwell core: Small helpers with no dependencies: ids, escaping, numbers, dates, server times, debounce.
   Plain script (no build step): in the app it defines window.InkUtil (loaded before app.js);
   in Node (tests/unit) it is a CommonJS module. Moved unchanged out of app.js in 1.61.3. */
(function(root, make){
  const api = make(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.InkUtil = api;
})(typeof self !== 'undefined' ? self : this, function(root){
'use strict';

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MM = 96 / 25.4;            // CSS px per millimetre
const A4W = 794, A4H = 1123;     // A4 at 96 dpi
const pad2 = x => String(x).padStart(2, '0');
// (1.60.2) server times ("2026-10-25T15:15:45.181416+00:00") compared safely: Safari's Date.parse may not take
// six decimals, and two copies of one time may be written differently
const tsMs = s => Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));
function tsKey(s){
  if(!s) return '';
  const ms = tsMs(s);
  if(isNaN(ms)) return String(s);
  const m = /\.(\d+)/.exec(s);
  return String(Math.floor(ms / 1000)).padStart(12, '0') + ((m ? m[1] : '') + '000000').slice(0, 6);
}
const tsEq = (a, b) => !!a && !!b && (a === b || tsKey(a) === tsKey(b));
const hhmm = ts => { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
function fmtDate(ts){
  if(!ts || ts < 1e11) return '';
  const d = new Date(ts), n = new Date();
  if(d.toDateString() === n.toDateString()) return hhmm(ts);
  return `${pad2(d.getDate())}.${pad2(d.getMonth()+1)}.${d.getFullYear()}`;
}
function debounce(fn, ms){
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.flush = () => { if(t){ clearTimeout(t); t = null; return fn(); } };
  d.pending = () => !!t;
  return d;
}

return {newId, esc, clamp, MM, A4W, A4H, pad2, tsMs, tsKey, tsEq, hhmm, fmtDate, debounce};
});
