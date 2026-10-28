/* Inkwell app, part 7 of 13: Pages, binder, toolbar, Later, Pencil menu, popovers.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
/* =====================================================================
   Pages: open, create, delete, links
   ===================================================================== */
const navStack = [];
function normBg(bg){
  const b = Object.assign({}, prefs.bg, bg || {});
  if(!['blank', 'lined', 'grid', 'dots'].includes(b.type)) b.type = 'grid';
  b.sx = clamp(+b.sx || 5 * MM, 2 * MM, 30 * MM); b.sy = clamp(+b.sy || 5 * MM, 2 * MM, 30 * MM);
  return b;
}
async function openPage(id, opts = {}){
  if(cur && cur.id === id){ if(width() === 'narrow') app.dataset.view = 'editor'; return; }
  await closeCurrent();
  const page = getDoc(id);
  if(!page){ showEmpty(); return; }
  if(!opts.keepStack) navStack.length = 0;
  updBack();
  const crec = await IDB.get('docs', 'c_' + id);
  const ok = crec && !crec.deleted && crec.data;
  const data = ok ? crec.data : {bg: Object.assign({}, prefs.bg), items: []};
  cur = {id, crec: ok ? crec : null, bg: normBg(data.bg), items: new Map(), undo: [], redo: [], lastId: typeof data.last === 'string' ? data.last : null};
  { const c = cur; versionsOf(id).then(l => { c.verAt = l[0] ? l[0].data.at : 0; }).catch(() => { c.verAt = 0; }); }
  for(const s of data.items || []){ const it = deser(s); if(it && it.id) cur.items.set(it.id, it); }
  ui.page = id; ui.sec = page.data.sec;
  const sec = getDoc(page.data.sec); if(sec) ui.nb = sec.data.nb;
  saveUi();
  $('title').value = page.data.title || '';
  $('stageEmpty').hidden = true;
  worldBack.innerHTML = ''; worldFront.innerHTML = ''; elMap.clear(); geo.clear();
  for(const it of cur.items.values()) if(it.t !== 's') itemEl(it);
  refreshPaper();
  const saved = LSget('inkwell.cam.' + id, null);
  if(saved && isFinite(saved.z)) Object.assign(cam, saved);
  else { cam.z = 1; cam.ox = W > 900 ? 56 : 20; cam.oy = 28; }
  slPages = null;
  clearSel(); updUndo(); renderRuler(); invalidate();
  markActivePage(); markBadgeSoon();
  if(width() === 'narrow') app.dataset.view = 'editor';
  if(Ask.histOpen && !$('askPanel').hidden) Ask.showHistory();   // (1.68) the chat filter follows the open page
}
async function closeCurrent(){
  closeWheel();
  if(!cur) return;
  finishEditing();
  if(act) cancelAct();
  await flushSaves();
  clearTimeout(hwPageT);
  if(HW.on()){ HW.enqueue(cur.id); HW.kick(); }
  cur = null; clearSel();
}
function showEmpty(){
  cur = null; slPages = null;
  worldBack.innerHTML = ''; worldFront.innerHTML = ''; elMap.clear(); geo.clear();
  $('stageEmpty').hidden = false; $('title').value = '';
  clearSel(); updUndo(); renderRuler(); invalidate();
}
async function newPage(tmplId){
  let sec = ui.sec && getDoc(ui.sec);
  if(!sec){
    let nb = ui.nb && getDoc(ui.nb);
    if(!nb) nb = notebooks()[0] || await newDoc('nb', {name: 'Notebook', color: 1, order: 0});
    sec = sectionsOf(nb.id)[0] || await newDoc('sec', {nb: nb.id, name: 'Notes', color: nb.data.color, order: 0});
    ui.nb = nb.id; ui.sec = sec.id;
  }
  const pages = pagesOf(sec.id);
  const order = (pages.length ? Math.min(...pages.map(p => p.data.order || 0)) : 0) - 1;
  let content = {bg: Object.assign({}, prefs.bg), items: []}, title = '';
  if(tmplId){
    const t = getDoc(tmplId);
    if(t){ content = {bg: Object.assign({}, t.data.bg), items: (t.data.items || []).map(s => Object.assign({}, s, {id: (s.id || 'k')[0] + newId()}))}; title = t.data.name || ''; }
  }
  const page = await newDoc('page', {sec: sec.id, title, order, snippet: ''});
  await writeDoc({id: 'c_' + page.id, kind: 'content', data: content, deleted: false});
  renderNav(); renderList();
  await openPage(page.id);
}
async function deletePage(id){
  await closeCurrent();
  const page = getDoc(id); if(!page) return;
  const secId = page.data.sec, list = pagesOf(secId), idx = list.findIndex(p => p.id === id);
  await removeDoc(id, 'page'); await removeDoc('c_' + id, 'content', id);
  localStorage.removeItem('inkwell.cam.' + id);
  renderNav(); renderList();
  const rest = pagesOf(secId), next = rest[Math.min(idx, rest.length - 1)];
  if(next && width() !== 'narrow') openPage(next.id); else { showEmpty(); if(width() === 'narrow') app.dataset.view = 'list'; }
  toast('Page deleted');
}
function followLink(pid){
  if(!getDoc(pid)){ toast('That page was deleted'); return; }
  if(cur && cur.id === pid) return;
  if(cur) navStack.push(cur.id);
  const p = getDoc(pid), sec = getDoc(p.data.sec);
  ui.sec = p.data.sec; if(sec) ui.nb = sec.data.nb;
  openPage(pid, {keepStack: true}).then(() => { renderNav(); renderList(); updBack(); });
}
function updBack(){
  const b = $('backLink');
  const prev = navStack.length && getDoc(navStack[navStack.length - 1]);
  b.hidden = !prev;
  $('backLinkName').textContent = prev ? (prev.data.title || 'Back') : '';
}
$('backLink').addEventListener('click', () => {
  while(navStack.length){ const id = navStack.pop(); if(getDoc(id)){ const p = getDoc(id); ui.sec = p.data.sec; openPage(id, {keepStack: true}).then(() => { renderNav(); renderList(); updBack(); }); return; } }
  updBack();
});

/* title */
const saveTitleSoon = debounce(async () => {
  if(!cur) return;
  const page = getDoc(cur.id);
  if(page && page.data.title !== $('title').value){ await patchDoc(page, {title: $('title').value}); refreshPageItem(cur.id); }
}, 500);
$('title').addEventListener('input', () => saveTitleSoon());
$('title').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); $('title').blur(); } });

/* =====================================================================
   Binder (notebooks, sections, pages, search)
   ===================================================================== */
const app = $('app');
let editState = null; // {kind:'nb'|'sec', id, color, armed}
const width = () => innerWidth <= 700 ? 'narrow' : innerWidth <= 1100 ? 'medium' : 'wide';
function showLeft(which){ app.dataset.left = which; if(width() === 'narrow') app.dataset.view = which; }

function editFormHTML(name, color, what){
  const sw = Array.from({length: TABS}, (_, i) => `<button type="button" class="${i === color % TABS ? 'on' : ''}" data-col="${i}" style="--c:var(--t${i})" aria-label="Colour ${i + 1}"></button>`).join('');
  return `<form class="edit-form"><input id="editName" value="${esc(name)}" aria-label="Name" maxlength="60" autocomplete="off"><div class="tabsw">${sw}</div><div class="edit-actions"><button type="button" class="btn danger" data-del>Delete ${what}</button><button type="submit" class="btn primary">Done</button></div></form>`;
}
function wireEditForm(root){
  const form = root.querySelector('.edit-form'); if(!form) return;
  const input = form.querySelector('#editName');
  setTimeout(() => { input.focus(); input.select(); }, 40);
  form.addEventListener('submit', e => { e.preventDefault(); commitEdit(input.value); });
  form.querySelectorAll('[data-col]').forEach(b => b.addEventListener('click', () => {
    editState.color = +b.dataset.col;
    form.querySelectorAll('[data-col]').forEach(x => x.classList.toggle('on', x === b));
  }));
  const del = form.querySelector('[data-del]'), label = del.textContent;
  del.addEventListener('click', () => {
    if(!editState.armed){
      editState.armed = true; del.classList.add('armed'); del.textContent = 'Tap again to delete';
      setTimeout(() => { if(editState){ editState.armed = false; del.classList.remove('armed'); del.textContent = label; } }, 3500);
      return;
    }
    deleteContainer();
  });
}
async function commitEdit(name){
  name = name.trim();
  const st = editState; editState = null;
  if(!st) return;
  const d = getDoc(st.id);
  if(d) await patchDoc(d, {name: name || d.data.name, color: st.color});
  renderNav(); renderList();
}
async function deleteContainer(){
  const st = editState; editState = null;
  const secs = st.kind === 'nb' ? sectionsOf(st.id) : [getDoc(st.id)].filter(Boolean);
  for(const s of secs){
    for(const p of pagesOf(s.id)){
      if(cur && cur.id === p.id){ await closeCurrent(); showEmpty(); }
      await removeDoc(p.id, 'page', st.id); await removeDoc('c_' + p.id, 'content', st.id);
    }
    await removeDoc(s.id, 'sec', st.id);
  }
  if(st.kind === 'nb') await removeDoc(st.id, 'nb', st.id);
  ensureUi(); renderNav(); renderList();
  toast(st.kind === 'nb' ? 'Notebook deleted' : 'Section deleted');
}
function ensureUi(){
  const nbs = notebooks();
  if(!nbs.length){ ui.nb = ui.sec = null; saveUi(); return; }
  if(!getDoc(ui.nb)) ui.nb = nbs[0].id;
  const secs = sectionsOf(ui.nb);
  const s = getDoc(ui.sec);
  if(!s || s.data.nb !== ui.nb) ui.sec = secs[0] ? secs[0].id : null;
  if(prefs.open[ui.nb] === undefined) prefs.open[ui.nb] = true;
  saveUi();
}
function renderNav(){
  const q = $('search').value.trim();
  const html = notebooks().map(nb => {
    const open = !!prefs.open[nb.id];
    const secs = sectionsOf(nb.id);
    const n = secs.reduce((a, s) => a + pagesOf(s.id).length, 0);
    let h = `<div class="nb ${open ? 'open' : ''}">`;
    if(editState && editState.kind === 'nb' && editState.id === nb.id) h += editFormHTML(nb.data.name, nb.data.color || 0, 'notebook');
    else h += `<div class="nb-row"><button class="nb-main" data-nb="${nb.id}" aria-expanded="${open}"><svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg><span class="nb-sw" style="--c:var(--t${(nb.data.color || 0) % TABS})"></span><span class="nb-name">${esc(nb.data.name)}</span><span class="count">${n}</span></button>${open ? `<button class="icon-btn" data-editnb="${nb.id}" aria-label="Rename notebook" title="Rename notebook"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg></button>` : ''}</div>`;
    if(open){
      h += '<div class="secs">' + secs.map(s => `<button class="sec-row ${!q && s.id === ui.sec ? 'on' : ''}" data-sec="${s.id}"><span class="tab" style="--c:var(--t${(s.data.color || 0) % TABS})"></span><span class="nm">${esc(s.data.name)}</span><span class="count">${pagesOf(s.id).length}</span></button>`).join('') + `<button class="add-sec" data-addsec="${nb.id}">+ Section</button></div>`;
    }
    return h + '</div>';
  }).join('');
  $('nbList').innerHTML = html || '<div class="empty"><strong>No notebooks</strong>Tap + to create one.</div>';
  if(editState && editState.kind === 'nb') wireEditForm($('nbList'));
}
function pageItemHTML(p, path){
  return `<button class="page-item ${cur && p.id === cur.id ? 'on' : ''}" data-page="${p.id}"><div class="pi-top"><span class="pi-title ${p.data.title ? '' : 'untitled'}">${esc(p.data.title || 'Untitled page')}</span><span class="pi-date">${fmtDate(p.updated)}</span></div>${p.data.snippet ? `<div class="pi-snip">${esc(p.data.snippet)}</div>` : ''}${path ? `<div class="pi-path">${esc(path)}</div>` : ''}</button>`;
}
function pathOf(p){ const s = getDoc(p.data.sec), nb = s && getDoc(s.data.nb); return (nb ? nb.data.name + ' › ' : '') + (s ? s.data.name : ''); }
async function renderList(){
  const q = $('search').value.trim();
  if(q){ renderSearch(q); return; }
  $('editSec').hidden = false; $('newPage').parentElement.hidden = false;
  const s = getDoc(ui.sec);
  const nb = getDoc(ui.nb);
  if(!s){
    $('listTitle').innerHTML = `<div class="crumb">${esc(nb ? nb.data.name : '')}</div><h2>No section</h2>`;
    $('editSec').hidden = true; $('secEdit').innerHTML = '';
    $('pageList').innerHTML = '<div class="empty"><strong>No section here yet</strong>Add one under the notebook name, or tap Page to start one called Notes.</div>';
    return;
  }
  $('listTitle').innerHTML = `<div class="crumb">${esc(nb ? nb.data.name : '')}</div><h2><span class="tab" style="--c:var(--t${(s.data.color || 0) % TABS})"></span>${esc(s.data.name)}</h2>`;
  if(editState && editState.kind === 'sec' && editState.id === s.id){ $('secEdit').innerHTML = `<div style="padding:0 10px">${editFormHTML(s.data.name, s.data.color || 0, 'section')}</div>`; wireEditForm($('secEdit')); }
  else $('secEdit').innerHTML = '';
  const pages = pagesOf(s.id);
  $('pageList').innerHTML = pages.length ? pages.map(p => pageItemHTML(p)).join('') : `<div class="empty"><strong>No pages yet</strong>Tap Page to start writing in ${esc(s.data.name)}.</div>`;
}
function refreshPageItem(id){
  const el = $('pageList').querySelector(`[data-page="${id}"]`), p = getDoc(id);
  if(!el || !p) return;
  const t = document.createElement('div');
  t.innerHTML = pageItemHTML(p, $('search').value.trim() ? pathOf(p) : '');
  el.replaceWith(t.firstElementChild);
}
function markActivePage(){ $('pageList').querySelectorAll('.page-item').forEach(el => el.classList.toggle('on', !!cur && el.dataset.page === cur.id)); }
async function buildSearch(){
  if(searchCache) return searchCache;
  const all = await IDB.all('docs'), map = new Map();
  for(const d of all){
    if(d.kind !== 'content' || d.deleted || !d.data) continue;
    let txt = '';
    for(const it of d.data.items || []){ if(it.t === 'x') txt += ' ' + htmlText(it.html); else if(it.t === 'm') txt += ' ' + it.tex; else if(it.t === 'i' && it.f) txt += fieldText(it); }
    map.set(d.id.slice(2), {txt: fold(txt), pics: pagePictures(d.data.items || [])});
  }
  searchCache = map;
  return map;
}
// everything readable on a page: title, typed text, handwriting (as read by Claude), imported pages
function pageWords(p, e){
  return [p.data.title || '', e ? e.txt : '', HW.text(p)].concat(e ? e.pics.map(it => ptxtText(ptxtOf(it.a))) : []).join('\n');
}
async function renderSearch(q){
  $('editSec').hidden = true; $('newPage').parentElement.hidden = true; $('secEdit').innerHTML = '';
  $('listTitle').innerHTML = `<div class="crumb">Search</div><h2>“${esc(q)}”</h2>`;
  const idx = await buildSearch();
  if($('search').value.trim() !== q) return;
  const needle = fold(q), hits = [];
  for(const p of [...docs.values()].filter(d => d.kind === 'page' && live(d)).sort((a, b) => b.updated - a.updated)){
    let e = idx.get(p.id);
    if(cur && cur.id === p.id){
      const items = [...cur.items.values()];
      let txt = ''; for(const it of items){ if(it.t === 'x') txt += ' ' + htmlText(it.html); else if(it.t === 'm') txt += ' ' + it.tex; else if(it.t === 'i' && it.f) txt += fieldText(it); }
      e = {txt: fold(txt), pics: pagePictures(items)};
    }
    const hay = fold(pageWords(p, e)).replace(/-\n/g, '').replace(/\n/g, ' ');
    if(!hay.includes(needle)) continue;
    let h = pageItemHTML(p, pathOf(p));
    // where it is inside imported pages (PDFs, scans): tap to jump to that line
    const sub = e ? ptxtHits(e.pics, needle, 4) : [];
    for(const x of sub) h += `<button class="hit-line" data-page="${p.id}" data-jump="${x.id}" data-y="${x.y}"><span class="hl-n">p. ${x.n}</span><span class="hl-s">${x.html}</span></button>`;
    hits.push(h);
  }
  const reading = PT.queue.length + (PT.busy ? 1 : 0);
  $('pageList').innerHTML = hits.length ? hits.join('') : '<div class="empty"><strong>Nothing found</strong>No page contains that text.' + (hwMode() === 'off' ? ' Reading handwriting and scans is off in the settings.' : reading ? ` ${reading} imported page${reading === 1 ? ' is' : 's are'} still being read.` : '') + '</div>';
}
let searchT;
$('search').addEventListener('input', () => {
  clearTimeout(searchT);
  searchT = setTimeout(() => { renderNav(); renderList(); if($('search').value.trim()) showLeft('list'); }, 160);
});
$('nbList').addEventListener('click', async e => {
  const t = e.target.closest('button'); if(!t) return;
  if(t.dataset.nb){ prefs.open[t.dataset.nb] = !prefs.open[t.dataset.nb]; savePrefs(); renderNav(); return; }
  if(t.dataset.editnb){ const nb = getDoc(t.dataset.editnb); if(!nb) return; editState = {kind: 'nb', id: nb.id, color: nb.data.color || 0}; renderNav(); return; }
  if(t.dataset.sec){ selectSection(t.dataset.sec); return; }
  if(t.dataset.addsec){
    const nbId = t.dataset.addsec, secs = sectionsOf(nbId), nb = getDoc(nbId);
    const s = await newDoc('sec', {nb: nbId, name: 'New section', color: ((nb.data.color || 0) + secs.length) % TABS, order: secs.length ? Math.max(...secs.map(x => x.data.order || 0)) + 1 : 0});
    ui.nb = nbId; ui.sec = s.id; saveUi();
    editState = {kind: 'sec', id: s.id, color: s.data.color};
    renderNav(); renderList(); showLeft('list');
  }
});
function selectSection(id){
  const s = getDoc(id); if(!s) return;
  $('search').value = '';
  ui.nb = s.data.nb; ui.sec = id; saveUi(); editState = null;
  renderNav(); renderList(); showLeft('list');
  if(width() !== 'narrow'){
    const first = pagesOf(id)[0];
    if(first){ if(!cur || cur.id !== first.id) openPage(first.id); }
    else closeCurrent().then(showEmpty);
  }
}
$('addNb').addEventListener('click', async () => {
  const nbs = notebooks(), color = nbs.length % TABS;
  const nb = await newDoc('nb', {name: 'New notebook', color, order: nbs.length ? Math.max(...nbs.map(n => n.data.order || 0)) + 1 : 0});
  const s = await newDoc('sec', {nb: nb.id, name: 'Notes', color, order: 0});
  prefs.open[nb.id] = true; savePrefs();
  ui.nb = nb.id; ui.sec = s.id; saveUi();
  editState = {kind: 'nb', id: nb.id, color};
  renderNav(); renderList();
});
$('editSec').addEventListener('click', () => {
  const s = getDoc(ui.sec); if(!s) return;
  editState = editState && editState.id === s.id ? null : {kind: 'sec', id: s.id, color: s.data.color || 0};
  renderList();
});
$('listBack').addEventListener('click', () => showLeft('nav'));
$('pageList').addEventListener('click', e => {
  const t = e.target.closest('[data-page]'); if(!t) return;
  const p = getDoc(t.dataset.page); if(!p) return;
  if(!$('search').value.trim()){ ui.sec = p.data.sec; }
  const jump = t.dataset.jump, y = +t.dataset.y;
  openPage(p.id).then(() => { if($('search').value.trim()) markActivePage(); if(jump) jumpToLine(jump, y); });
});
/* ---------- drag to reorder: notebooks, sections, pages ----------
   Mouse: press and drag. Touch / Pencil: press and hold (RO_HOLD), then drag; a quick swipe still scrolls.
   Sections can go into another open notebook; a page dropped on a section in the left column moves there. */
const RO_HOLD = 400;
let ro = null, roClickBlock = 0;
const roSel = '.page-item[data-page], .sec-row[data-sec], .nb-main[data-nb]';
function roDown(e){
  if(ro || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const el = e.target.closest(roSel); if(!el) return;
  const kind = el.dataset.page ? 'page' : el.dataset.sec ? 'sec' : 'nb';
  if(kind === 'page' && $('search').value.trim()) return;   // search results are not a list to sort
  ro = {el, kind, id: el.dataset.page || el.dataset.sec || el.dataset.nb, pid: e.pointerId, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse', on: false, drop: null};
  if(!ro.mouse) ro.t = setTimeout(() => { if(ro && !ro.on) roBegin(); }, RO_HOLD);
}
function roBegin(){
  const r = ro.el.getBoundingClientRect();
  ro.on = true; ro.dy = ro.y - r.top; ro.dx = ro.x - r.left;
  const g = ro.el.cloneNode(true); g.classList.add('ro-ghost'); g.classList.remove('on');
  g.style.left = r.left + 'px'; g.style.top = r.top + 'px'; g.style.width = r.width + 'px';
  document.body.appendChild(g); ro.ghost = g;
  const line = document.createElement('div'); line.className = 'ro-line'; line.hidden = true; document.body.appendChild(line); ro.line = line;
  ro.el.classList.add('ro-drag'); document.body.classList.add('ro-on');
  try { ro.el.setPointerCapture(ro.pid); } catch {}
}
function roRows(){
  if(ro.kind === 'nb') return [...$('nbList').querySelectorAll('.nb-main[data-nb]')];
  if(ro.kind === 'sec') return [...$('nbList').querySelectorAll('.sec-row[data-sec], .add-sec[data-addsec]')];
  return [...$('pageList').querySelectorAll('.page-item[data-page]')];
}
function roMove(e){
  if(!ro || e.pointerId !== ro.pid) return;
  if(!ro.on){
    const d = Math.hypot(e.clientX - ro.x, e.clientY - ro.y);
    if(ro.mouse){ if(d > 6) roBegin(); else return; }
    else { if(d > 8){ clearTimeout(ro.t); ro = null; } return; }   // moved before the hold: it is a scroll
  }
  e.preventDefault();
  ro.ghost.style.top = (e.clientY - ro.dy) + 'px';
  if(ro.kind === 'page') ro.ghost.style.left = (e.clientX - ro.dx) + 'px';   // pages can travel to a section
  // scroll the list when the finger nears its top or bottom
  const box = ro.el.closest('.nb-list, #pageList, .page-list') || ro.el.parentElement;
  const scroller = box && (box.scrollHeight > box.clientHeight ? box : box.parentElement);
  if(scroller){ const b = scroller.getBoundingClientRect(); if(e.clientY < b.top + 36) scroller.scrollTop -= 10; else if(e.clientY > b.bottom - 36) scroller.scrollTop += 10; }
  document.querySelectorAll('.ro-into').forEach(x => x.classList.remove('ro-into'));
  ro.drop = null; ro.line.hidden = true;
  if(ro.kind === 'page'){
    const under = document.elementFromPoint(e.clientX, e.clientY), sr = under && under.closest('#nbList .sec-row[data-sec]');
    if(sr){ const p = getDoc(ro.id); if(p && sr.dataset.sec !== p.data.sec){ sr.classList.add('ro-into'); ro.drop = {into: sr.dataset.sec}; } return; }
  }
  const rows = roRows().filter(r => r !== ro.el);
  let best = null, bd = Infinity;
  for(const r of rows){
    const b = r.getBoundingClientRect(); if(!b.height) continue;
    const d = e.clientY < b.top ? b.top - e.clientY : e.clientY > b.bottom ? e.clientY - b.bottom : 0;
    if(d < bd){ bd = d; best = {r, b}; }
  }
  if(!best || bd > 60) return;
  const add = !!best.r.dataset.addsec, before = add || e.clientY < best.b.top + best.b.height / 2;
  ro.drop = {ref: best.r, before};
  const lb = (ro.kind === 'nb' ? best.r.closest('.nb') || best.r : best.r).getBoundingClientRect();
  ro.line.style.left = best.b.left + 'px'; ro.line.style.width = best.b.width + 'px';
  ro.line.style.top = ((before ? best.b.top : (ro.kind === 'nb' ? lb.bottom : best.b.bottom)) - 1.5) + 'px';
  ro.line.hidden = false;
}
// orders 0, 1, 2 … for the list as shown; only changed docs are written (and synced)
async function roRenumber(list, extra){
  for(let i = 0; i < list.length; i++){
    const d = list[i], more = extra && extra.doc === d ? extra.patch : null;
    if((d.data.order || 0) !== i || more) await patchDoc(d, Object.assign({order: i}, more || {}));
  }
}
async function roDrop(st){
  const me = getDoc(st.id), dr = st.drop; if(!me || !dr) return;
  if(dr.into){   // page onto a section in the left column
    const s = getDoc(dr.into); if(!s) return;
    const top = pagesOf(s.id).reduce((m, p) => Math.min(m, p.data.order || 0), 1);
    await patchDoc(me, {sec: s.id, order: top - 1});
    toast('Moved to ' + s.data.name);
  } else {
    const r = dr.ref;
    if(st.kind === 'nb'){
      const list = notebooks().filter(d => d !== me), at = list.findIndex(d => d.id === r.dataset.nb);
      list.splice(at + (dr.before ? 0 : 1), 0, me); await roRenumber(list);
    } else if(st.kind === 'sec'){
      const nbId = r.dataset.addsec || (getDoc(r.dataset.sec) || {data: {}}).data.nb; if(!nbId) return;
      const list = sectionsOf(nbId).filter(d => d !== me);
      const at = r.dataset.addsec ? list.length : list.findIndex(d => d.id === r.dataset.sec) + (dr.before ? 0 : 1);
      list.splice(at, 0, me);
      const moved = me.data.nb !== nbId;
      await roRenumber(list, moved ? {doc: me, patch: {nb: nbId}} : null);
      if(moved){ if(ui.sec === me.id){ ui.nb = nbId; saveUi(); } prefs.open[nbId] = true; savePrefs(); toast('Moved to ' + getDoc(nbId).data.name); }
    } else {
      const list = pagesOf(me.data.sec).filter(d => d !== me), at = list.findIndex(d => d.id === r.dataset.page);
      list.splice(at + (dr.before ? 0 : 1), 0, me); await roRenumber(list);
    }
  }
  ensureUi(); renderNav(); renderList();
}
function roEnd(e, cancel){
  if(!ro || e.pointerId !== ro.pid) return;
  const st = ro; ro = null; clearTimeout(st.t);
  if(!st.on) return;
  roClickBlock = Date.now();
  st.ghost.remove(); st.line.remove(); st.el.classList.remove('ro-drag'); document.body.classList.remove('ro-on');
  document.querySelectorAll('.ro-into').forEach(x => x.classList.remove('ro-into'));
  if(!cancel) roDrop(st).catch(err => { console.warn('reorder', err); toast('Could not move it'); });
}
for(const id of ['nbList', 'pageList']){
  const box = $(id);
  box.addEventListener('pointerdown', roDown);
  box.addEventListener('click', e => { if(Date.now() - roClickBlock < 500){ e.stopPropagation(); e.preventDefault(); } }, true);
  // once something is picked up the finger drags it instead of scrolling the list
  box.addEventListener('touchmove', e => { if(ro && ro.on) e.preventDefault(); }, {passive: false});
  box.addEventListener('contextmenu', e => { if(ro) e.preventDefault(); });
}
addEventListener('pointermove', roMove, {passive: false});
addEventListener('pointerup', e => roEnd(e, false));
addEventListener('pointercancel', e => roEnd(e, true));
$('newPage').addEventListener('click', () => newPage());
$('newMore').addEventListener('click', e => { renderTemplates(); openPop('newPop', e.currentTarget); });
function renderTemplates(){
  const list = templates();
  $('tmplList').innerHTML = `<button class="menu-item" data-tmpl="">Blank page</button>` +
    list.map(t => `<div style="display:flex;align-items:center"><button class="menu-item" style="flex:1" data-tmpl="${t.id}">${esc(t.data.name)}</button><button class="icon-btn" data-deltmpl="${t.id}" aria-label="Delete template ${esc(t.data.name)}" title="Delete template"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('') +
    (list.length ? '' : '<p class="hint" style="padding:4px 8px">Make a template with More › Save page as template.</p>');
}
$('tmplList').addEventListener('click', async e => {
  const d = e.target.closest('[data-deltmpl]');
  if(d){
    if(d.dataset.armed){ await removeDoc(d.dataset.deltmpl, 'tmpl'); renderTemplates(); toast('Template deleted'); }
    else { d.dataset.armed = '1'; d.style.color = 'var(--danger)'; d.title = 'Tap again to delete'; setTimeout(() => { delete d.dataset.armed; d.style.color = ''; }, 3000); }
    return;
  }
  const b = e.target.closest('[data-tmpl]'); if(!b) return;
  closePops();
  newPage(b.dataset.tmpl || null);
});

/* sidebar visibility */
$('sideBtn').addEventListener('click', () => {
  if(width() === 'narrow'){ app.dataset.view = 'list'; return; }
  prefs.focus = !prefs.focus; savePrefs();
  if(!prefs.focus && !$('calc').hidden) Calc.close();
  app.classList.toggle('focus', prefs.focus);
});
addEventListener('resize', () => {
  if(width() === 'narrow') app.classList.remove('focus'); else app.classList.toggle('focus', !!prefs.focus);
});

/* continue where you left off: jump to the last thing written or changed on this page */
function lastSpotItem(){
  if(!cur || !cur.items.size) return null;
  if(cur.lastId && cur.items.has(cur.lastId)) return cur.items.get(cur.lastId);
  // pages from before this was tracked: newest item by its time-based id
  let best = null, key = '';
  for(const it of cur.items.values()){ const k = String(it.id).slice(1); if(!best || k > key){ best = it; key = k; } }
  return best;
}
let camAnim = 0;
function continueHere(){
  if(!cur) return;
  finishEditing();
  const it = lastSpotItem();
  if(!it){ toast('Nothing written on this page yet'); return; }
  const b = itemBox(it);
  const z = cam.z;
  const vw = W / z, vh = H / z;
  // horizontal: keep the view if the spot already fits, otherwise centre it
  const left = -cam.ox / z;
  let tx = cam.ox;
  if(b[0] < left + 16 / z || b[2] > left + vw - 16 / z){
    const cx = (b[2] - b[0] < vw - 32 / z) ? (b[0] + b[2]) / 2 : b[0] + (vw / 2 - 32 / z);
    tx = W / 2 - cx * z;
  }
  // vertical: bottom of the spot at 60% of the screen height, so there is room to keep writing below
  const ty = H * 0.6 - b[3] * z;
  const fx = cam.ox, fy = cam.oy, t0 = performance.now(), d = 260;
  cancelAnimationFrame(camAnim);
  const step = now => {
    const k = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - k, 3);
    cam.ox = fx + (tx - fx) * e; cam.oy = fy + (ty - fy) * e;
    invalidate();
    if(k < 1) camAnim = requestAnimationFrame(step); else saveCamSoon();
  };
  camAnim = requestAnimationFrame(step);
}
$('continueBtn').addEventListener('click', continueHere);

/* sidebar width: drag the edges, double-tap an edge to reset */
const SIDE_LIM = {navW: [150, 420, 232], listW: [180, 560, 264], oneW: [200, 520, 280]};
function applySideWidths(){
  for(const k in SIDE_LIM){
    const v = +prefs[k];
    if(isFinite(v) && v > 0) app.style.setProperty('--' + k, clamp(v, SIDE_LIM[k][0], SIDE_LIM[k][1]) + 'px');
    else app.style.removeProperty('--' + k);
  }
}
applySideWidths();
document.querySelectorAll('.side-grip').forEach(g => {
  let drag = null, lastTap = 0;
  const key = () => g.dataset.grip === 'nav' ? 'navW' : (matchMedia('(max-width:1100px)').matches ? 'oneW' : 'listW');
  const colW = () => g.dataset.grip === 'nav' ? $('side').querySelector('.nav').getBoundingClientRect().width
    : matchMedia('(max-width:1100px)').matches ? $('side').getBoundingClientRect().width - 1 : $('side').querySelector('.list').getBoundingClientRect().width;
  g.addEventListener('pointerdown', e => {
    e.preventDefault();
    drag = {id: e.pointerId, x: e.clientX, y: e.clientY, w: colW() || SIDE_LIM[key()][2], k: key(), moved: false};
    g.setPointerCapture(e.pointerId); g.classList.add('on');
  });
  g.addEventListener('pointermove', e => {
    if(!drag || e.pointerId !== drag.id) return;
    if(!drag.moved && Math.abs(e.clientX - drag.x) < 4) return;
    drag.moved = true;
    const L = SIDE_LIM[drag.k];
    prefs[drag.k] = Math.round(clamp(drag.w + e.clientX - drag.x, L[0], L[1]));
    applySideWidths();
  });
  const end = e => {
    if(!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null; g.classList.remove('on');
    if(d.moved){ savePrefs(); lastTap = 0; return; }
    if(e.type !== 'pointerup') return;
    const now = Date.now();
    if(now - lastTap < 350){ delete prefs[d.k]; savePrefs(); applySideWidths(); lastTap = 0; return; }
    lastTap = now;
    // a plain tap goes through to whatever is under the handle (page list, notebook counts)
    g.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    g.style.pointerEvents = '';
    if(under && under !== g) under.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, view: window}));
  };
  g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
});

/* =====================================================================
   Toolbar
   ===================================================================== */
const PALETTE = ['auto', '#5D6B79', '#8A97A4', '#1F4FCF', '#3BA5F0', '#0E8C8C', '#167A3C', '#4CC26B', '#9BC53D', '#F5C400', '#E07A10', '#C2362B', '#FF6FA3', '#CC3F66', '#7B3FBF', '#A04FBD', '#8B5A2B', '#FFFFFF'];
// eraser picked in the Pencil menu: one erase, then back to the tool from before (set in wheelPick)
let eraseOnce = null;
function setTool(t){
  eraseOnce = null;
  prefs.tool = t; savePrefs();
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  stage.className = 'stage tool-' + t;
  if(t !== 'lasso') clearSel();
  if(editing && t !== 'text') finishEditing();
  renderOpts();
}
function renderOpts(){
  const t = prefs.tool, ink = t === 'pen' || t === 'hl';
  const paste = t === 'lasso';   // (1.53) always: pastes Inkwell copies and pictures/text from other apps
  $('opts').hidden = !(ink || t === 'eraser' || t === 'mark' || paste);
  $('pasteBtn').hidden = !paste; $('sizeWrap').hidden = t === 'lasso';
  $('lassoMode').hidden = t !== 'lasso';
  if(t === 'lasso') $('lassoMode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === (prefs.lassoMode === 'box' || prefs.lassoMode === 'tap' ? prefs.lassoMode : 'free')));
  $('swatches').hidden = !ink; $('colorBtn').hidden = !ink;
  $('eraseMode').hidden = t !== 'eraser';
  $('assistBtn').hidden = t !== 'pen';
  $('hlSnap').hidden = t !== 'hl'; $('hlSnap').classList.toggle('on', !!prefs.hlSnap);
  $('assistBtn').classList.toggle('on', !!(prefs.refLine || prefs.autoText));
  if(t === 'eraser') $('eraseMode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === (prefs.eraser.mode === 'area' ? 'area' : 'stroke')));
  if(ink){
    const favs = t === 'pen' ? prefs.penFavs : prefs.hlFavs, c = prefs[t].c;
    $('swatches').innerHTML = favs.map((f, i) => `<button class="swatch ${t === 'hl' ? 'hl' : ''} ${f === c ? 'on' : ''}" data-i="${i}" aria-label="Colour"><span style="--c:${f === 'auto' ? 'var(--fg)' : f}"></span></button>`).join('');
    const other = !favs.includes(c);
    $('colorBtn').classList.toggle('cur', other);
    $('colorBtn').style.setProperty('--c', other ? (c === 'auto' ? 'var(--fg)' : c) : '');
  }
  renderFmt();
  if(t === 'pen' || t === 'hl' || t === 'eraser' || t === 'mark'){
    $('size').value = prefs[t].s;
    const d = t === 'pen' ? clamp(2 + penWidth() * 1.4, 2, 22) : t === 'hl' ? clamp(hlWidth() * 0.45, 4, 22) : t === 'mark' ? clamp(markWidth() * 0.45, 4, 22) : clamp(eraserRadius() * 0.8, 4, 24);
    $('sizeDot').style.setProperty('--d', d + 'px');
  }
}
// the tool bar scrolls sideways when it doesn't fit; fade the edge that has more behind it
function barFade(){
  const b = $('toolbar'), more = b.scrollWidth - b.clientWidth;
  b.classList.toggle('fade-l', more > 2 && b.scrollLeft > 2);
  b.classList.toggle('fade-r', more > 2 && b.scrollLeft < more - 2);
}
$('toolbar').addEventListener('scroll', barFade, {passive: true});
addEventListener('resize', barFade);
if(window.ResizeObserver) new ResizeObserver(barFade).observe($('toolbar'));
// iOS only shows :active (pressed) styles when the page listens for touches
document.addEventListener('touchstart', () => {}, {passive: true});
$('lassoMode').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if(!b) return; prefs.lassoMode = b.dataset.m; savePrefs(); renderOpts(); });
$('hlSnap').addEventListener('click', () => {
  prefs.hlSnap = !prefs.hlSnap; savePrefs(); renderOpts();
  toast(prefs.hlSnap ? 'Stick to text is on: highlights snap onto the line of text under them' : 'Stick to text is off: the highlighter draws freely');
});
$('eraseMode').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if(!b) return; prefs.eraser.mode = b.dataset.m; savePrefs(); renderOpts(); });
document.querySelector('.tools').addEventListener('click', e => { const b = e.target.closest('.tool'); if(b) setTool(b.dataset.tool); });
$('size').addEventListener('input', () => { const t = prefs.tool; if(prefs[t]) { prefs[t].s = +$('size').value; savePrefs(); renderOpts(); } });
let lp = null;
$('swatches').addEventListener('pointerdown', e => {
  const b = e.target.closest('[data-i]'); if(!b) return;
  const t = prefs.tool, i = +b.dataset.i;
  lp = setTimeout(() => {
    lp = 'done';
    const favs = t === 'pen' ? prefs.penFavs : prefs.hlFavs;
    if(!favs.includes(prefs[t].c)){ favs[i] = prefs[t].c; savePrefs(); renderOpts(); toast('Saved to favourites'); }
    else toast('Pick a new colour with the colour wheel first, then press and hold a swatch to replace it');
  }, 550);
});
$('swatches').addEventListener('pointerup', e => {
  const b = e.target.closest('[data-i]');
  if(lp === 'done'){ lp = null; return; }
  clearTimeout(lp); lp = null;
  if(!b) return;
  const t = prefs.tool, favs = t === 'pen' ? prefs.penFavs : prefs.hlFavs;
  prefs[t].c = favs[+b.dataset.i]; savePrefs(); renderOpts();
});
$('swatches').addEventListener('pointerleave', () => { if(lp && lp !== 'done') clearTimeout(lp); lp = null; });
$('colorBtn').addEventListener('click', e => {
  const t = prefs.tool;
  $('palette').innerHTML = PALETTE.map(c => `<button data-c="${c}" class="${prefs[t] && prefs[t].c === c ? 'on' : ''}" style="--c:${c === 'auto' ? 'var(--fg)' : c}" aria-label="${c === 'auto' ? 'Black or white ink' : c}"></button>`).join('');
  $('customColor').value = /^#[0-9a-f]{6}$/i.test(prefs[t].c) ? prefs[t].c : '#1f4fcf';
  openPop('colorPop', e.currentTarget);
});
$('palette').addEventListener('click', e => {
  const b = e.target.closest('[data-c]'); if(!b) return;
  const t = prefs.tool === 'hl' ? 'hl' : 'pen';
  prefs[t].c = b.dataset.c; savePrefs(); renderOpts(); closePops();
});
$('customColor').addEventListener('input', () => { const t = prefs.tool === 'hl' ? 'hl' : 'pen'; prefs[t].c = $('customColor').value; savePrefs(); renderOpts(); });
$('rulerBtn').addEventListener('click', () => {
  prefs.ruler.on = !prefs.ruler.on;
  if(prefs.ruler.on) centerRuler(true);   // always appears in the middle of the screen, straight
  savePrefs(); renderRuler();
  if(prefs.ruler.on) toast(matchMedia('(hover:hover) and (pointer:fine)').matches
    ? 'Drag the hand to move the ruler, the round arrows to turn it. Draw along an edge for a straight line.'
    : 'Drag the ruler with one finger, turn it with two. Draw along an edge for a straight line.');
});
$('fingerBtn').addEventListener('click', () => { prefs.finger = !prefs.finger; savePrefs(); $('fingerBtn').classList.toggle('on', prefs.finger); });
$('zoomBtn').addEventListener('click', () => zoomAt(W / 2, H / 2, 1));
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);

/* =====================================================================
   Mark for later: violet strokes flagged mk:1, listed under "Later"
   ===================================================================== */
const boxGap = (a, b) => Math.max(0, b[0] - a[2], a[0] - b[2], b[1] - a[3], a[1] - b[3]);
const boxUnion = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
// marks drawn close together count as one spot
function clusterMarks(items){
  const groups = [];
  for(const it of items){
    if(!it || it.t !== 's' || !it.mk || !it.p || !it.p.length) continue;
    const b = cur && cur.items.get(it.id) === it ? geoOf(it).b : strokeBox(it);
    const near = groups.filter(g => boxGap(g.b, b) < 40);
    if(!near.length){ groups.push({b: b.slice(), ids: [it.id], at: it.at || 0}); continue; }
    const g = near[0];
    for(const o of near.slice(1)){ g.ids.push(...o.ids); g.b = boxUnion(g.b, o.b); g.at = Math.max(g.at, o.at); groups.splice(groups.indexOf(o), 1); }
    g.ids.push(it.id); g.b = boxUnion(g.b, b); g.at = Math.max(g.at, it.at || 0);
  }
  return groups;
}
const markCounts = new Map();   // page id -> number of marked spots
function updLaterBadge(){
  let n = 0; for(const v of markCounts.values()) n += v;
  const el = $('laterCount'); el.hidden = !n; el.textContent = n > 99 ? '99+' : String(n);
}
const markBadgeSoon = debounce(() => {
  if(cur){ const n = clusterMarks([...cur.items.values()]).length; if(n) markCounts.set(cur.id, n); else markCounts.delete(cur.id); }
  updLaterBadge();
}, 400);
// every marked spot on every page (the open page from memory, the others from the local database)
async function scanMarks(){
  const out = [];
  const all = await IDB.all('docs');
  markCounts.clear();
  for(const d of all){
    if(d.kind !== 'content' || d.deleted || !d.data) continue;
    const pid = d.id.slice(2);
    if(cur && pid === cur.id) continue;
    const page = getDoc(pid); if(!page) continue;
    const raw = d.data.items || [];
    if(!raw.some(s => s && s.t === 's' && s.mk)) continue;
    const items = raw.map(deser).filter(Boolean);
    const groups = clusterMarks(items);
    if(groups.length){ markCounts.set(pid, groups.length); out.push({pid, page, items, groups}); }
  }
  if(cur && getDoc(cur.id)){
    const items = [...cur.items.values()], groups = clusterMarks(items);
    if(groups.length){ markCounts.set(cur.id, groups.length); out.push({pid: cur.id, page: getDoc(cur.id), items, groups}); }
  }
  updLaterBadge();
  return out;
}
function agoText(ms){
  if(!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if(m < 1) return 'just now';
  if(m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if(h < 24) return h + ' h ago';
  const dd = Math.round(h / 24); if(dd < 14) return dd + (dd === 1 ? ' day ago' : ' days ago');
  return new Date(ms).toLocaleDateString();
}
let laterEntries = [];
async function renderLater(){
  const list = $('laterList');
  const pages = await scanMarks();
  laterEntries = [];
  for(const P of pages) for(const g of P.groups) laterEntries.push({pid: P.pid, page: P.page, items: P.items, g});
  laterEntries.sort((a, b) => (b.g.at - a.g.at) || ((b.page.updated || 0) - (a.page.updated || 0)));
  if(!laterEntries.length){
    list.innerHTML = '<div class="later-empty">Nothing marked yet. Pick the bookmark pen and mark anything you want to come back to; it shows up here.</div>';
    return;
  }
  list.innerHTML = laterEntries.map((e, i) => {
    const near = e.items.filter(it => it.t === 'x' && boxGap(itemBoxRaw(it), e.g.b) < 60).map(it => htmlText(it.html)).join(' ').slice(0, 90);
    return `<div class="later-row" data-i="${i}">
      <button class="later-go" data-go="${i}"><canvas class="later-pv" width="208" height="120"></canvas><span class="later-txt"><b>${esc(e.page.data.title || 'Untitled page')}</b><span>${esc(pathOf(e.page))}${e.g.at ? ' · ' + esc(agoText(e.g.at)) : ''}</span>${near ? `<i>${esc(near)}</i>` : ''}</span></button>
      <button class="later-done" data-done="${i}" title="Done: remove this mark" aria-label="Done, remove mark"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>
    </div>`;
  }).join('');
  const jobs = [];
  list.querySelectorAll('.later-row').forEach(row => jobs.push(() => drawMarkPreview(row.querySelector('canvas'), laterEntries[+row.dataset.i])));
  // previews one after another: each imported page picture is decoded alone, then let go
  (async () => { for(const j of jobs){ if($('laterPop').hidden) return; try { await j(); } catch {} } })();
}
// box of an item that is not on screen (text height is a guess)
function itemBoxRaw(it){
  if(it.t === 's') return strokeBox(it);
  if(it.t === 'i' || it.t === 'tp') return [it.x, it.y, it.x + it.w, it.y + it.h];
  return [it.x, it.y, it.x + (it.w || 200), it.y + 40];
}
async function drawMarkPreview(cv, e){
  const ctx = cv.getContext('2d'), CW = cv.width, CH = cv.height;
  const b = e.g.b, pad = 50;
  let bx0 = b[0] - pad, by0 = b[1] - pad, bx1 = b[2] + pad, by1 = b[3] + pad;
  // keep the canvas shape so ink is not stretched
  const k = Math.min(CW / (bx1 - bx0), CH / (by1 - by0));
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  bx0 = cx - CW / k / 2; bx1 = cx + CW / k / 2; by0 = cy - CH / k / 2; by1 = cy + CH / k / 2;
  const area = [bx0, by0, bx1, by1];
  const T = () => ctx.setTransform(k, 0, 0, k, -bx0 * k, -by0 * k);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, CW, CH);
  const imgs = e.items.filter(it => it.t === 'i' && boxGap(itemBoxRaw(it), area) === 0).slice(0, 3);
  T();
  for(const it of imgs){ ctx.fillStyle = '#FFFFFF'; ctx.fillRect(it.x, it.y, it.w, it.h); }
  for(const it of imgs){
    const u = await assetURL(it.a).catch(() => null);
    if(!u) continue;
    const img = new Image(); img.decoding = 'async'; img.src = u;
    try { await img.decode(); } catch { continue; }
    if(!cv.isConnected){ img.src = ''; return; }
    T(); ctx.drawImage(img, it.x, it.y, it.w, it.h);
    img.src = '';
  }
  T();
  const onP = (x, y) => imgs.some(it => x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h);
  for(const pass of [1, 0]) for(const it of e.items){
    if(it.t !== 's' || (it.hl ? 1 : 0) !== pass) continue;
    const sb = strokeBox(it); if(boxGap(sb, area) > 0) continue;
    const paper = onP((sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2);
    ctx.globalAlpha = (pass ? 0.4 : 1) * opOf(it);
    ctx.fillStyle = inkColor(it.c, false, paper);
    ctx.fill(strokePath(it, false));
  }
  ctx.globalAlpha = 1;
}
async function goToMark(pid, g){
  closePops();
  if(!getDoc(pid)){ toast('That page was deleted'); return; }
  if(!cur || cur.id !== pid){
    if(cur) navStack.push(cur.id);
    const p = getDoc(pid), sec = getDoc(p.data.sec);
    ui.sec = p.data.sec; if(sec) ui.nb = sec.data.nb;
    await openPage(pid, {keepStack: true});
    renderNav(); renderList(); updBack();
  } else if(width() === 'narrow') app.dataset.view = 'editor';
  // take the box from the page as it is now (the mark may have moved)
  let b = g.b;
  const now = g.ids.map(id => cur.items.get(id)).filter(Boolean);
  if(now.length) b = now.map(it => geoOf(it).b).reduce(boxUnion);
  const bw = b[2] - b[0], bh = b[3] - b[1];
  let z = cam.z;
  if(z < 0.6 || z * bw > W * 0.9 || z * bh > H * 0.8) z = clamp(Math.min(1.2, W * 0.8 / Math.max(bw, 1), H * 0.6 / Math.max(bh, 1)), 0.3, 1.2);
  cam.z = z; cam.ox = W / 2 - (b[0] + bw / 2) * z; cam.oy = H * 0.42 - (b[1] + bh / 2) * z;
  invalidate(); saveCamSoon();
  const f = document.createElement('div');
  f.className = 'mark-flash';
  f.style.cssText = `left:${b[0] - 10}px;top:${b[1] - 10}px;width:${bw + 20}px;height:${bh + 20}px`;
  worldFront.appendChild(f); frontXf(f);
  setTimeout(() => f.remove(), 2200);
}
async function clearMark(e){
  if(cur && cur.id === e.pid){
    const ids = e.g.ids.filter(id => cur.items.has(id));
    if(ids.length) removeItems(ids);
    toast('Mark removed', 'Undo', () => { if(cur && cur.id === e.pid) undo(); });
    await saveContentSoon.flush();
  } else {
    const rec = await IDB.get('docs', 'c_' + e.pid);
    if(!rec || !rec.data) return;
    const gone = new Set(e.g.ids), before = rec.data.items || [];
    rec.data = Object.assign({}, rec.data, {items: before.filter(s => !gone.has(s.id))});
    await writeDoc(rec);
    toast('Mark removed', 'Undo', async () => {
      const r = await IDB.get('docs', 'c_' + e.pid); if(!r || !r.data) return;
      const have = new Set((r.data.items || []).map(s => s.id));
      r.data = Object.assign({}, r.data, {items: (r.data.items || []).concat(before.filter(s => gone.has(s.id) && !have.has(s.id)))});
      await writeDoc(r); if(!$('laterPop').hidden) renderLater(); else scanMarks();
    });
  }
}
$('laterBtn').addEventListener('click', e => {
  const open = $('laterPop').hidden;
  if(open) $('laterList').innerHTML = '<div class="later-empty">Loading</div>';
  openPop('laterPop', e.currentTarget);
  if(open) renderLater().then(() => { if(!$('laterPop').hidden) openPopAgain('laterPop', $('laterBtn')); });
});
// re-place a popover after its content changed size
function openPopAgain(id, anchor){
  const p = $(id), r = anchor.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
  p.style.left = clamp(r.left + r.width / 2 - pw / 2, 8, innerWidth - pw - 8) + 'px';
  let y = r.bottom + 8; if(y + ph > innerHeight - 8) y = Math.max(8, innerHeight - ph - 8);
  p.style.top = y + 'px';
}
$('laterList').addEventListener('click', async ev => {
  const go = ev.target.closest('[data-go]'), done = ev.target.closest('[data-done]');
  if(go){ const e = laterEntries[+go.dataset.go]; if(e) goToMark(e.pid, e.g); }
  else if(done){
    const e = laterEntries[+done.dataset.done]; if(!e) return;
    done.closest('.later-row').classList.add('gone');
    await clearMark(e);
    if(!$('laterPop').hidden) renderLater();
  }
});

/* =====================================================================
   Pencil menu: press the Pencil down and hold it still (or right-click)
   ===================================================================== */
const WHEEL_HOLD = 480;
const WHEEL_SIZES = [15, 40, 75];
// (1.69) each tool keeps its own three sizes (prefs.wheelSizes = {pen: [a, b, c], hl: …}); holding a size in the menu
// for WHEEL_SAVE ms puts the size set on the thickness slider into that place
const WHEEL_SAVE = 1500;
function wheelSizes(t){
  const w = prefs.wheelSizes && prefs.wheelSizes[t];
  return WHEEL_SIZES.map((d, i) => { const v = Math.round(+(w && w[i])); return v >= 1 && v <= 100 ? v : d; });
}
let wheelDrag = null, wheelPress = null;
function wheelIcon(tool){ const s = document.querySelector(`.tool[data-tool="${tool}"] svg`); return s ? s.outerHTML : ''; }
// Half-moon menu (like a game weapon wheel) centred on the Pencil tip, opening away from the hand.
// Inner ring: undo and tools; outer ring: colours, thickness (and eraser mode). Picked by direction.
const WH_R0 = 34, WH_R1 = 92, WH_R2 = 152, WH_SPAN = Math.PI * 200 / 180;
let wheelGeo = null;   // {x, y, dir, segs: [{ring, a0, a1, el}]}
function wheelItems(){
  const t = prefs.tool, inkT = t === 'hl' ? 'hl' : 'pen';
  const favs = inkT === 'hl' ? prefs.hlFavs : prefs.penFavs;
  const sizeT = ['pen', 'hl', 'eraser', 'mark'].includes(t) ? t : 'pen';
  const names = {pen: 'Pen', hl: 'Highlighter', mark: 'Mark for later', eraser: 'Eraser', lasso: 'Lasso'};
  const undoSvg = '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
  const inner = [{w: 'undo', label: 'Undo', icon: undoSvg, cls: 'wh-undo'}]
    .concat(['pen', 'hl', 'eraser', 'lasso'].map(v => ({w: 'tool', v, label: names[v], icon: wheelIcon(v), on: v === t, cls: 'wh-tool'})));
  const outer = favs.map(c => ({w: 'c', v: c, label: inkT === 'hl' ? 'Highlighter colour' : 'Pen colour', cls: 'wh-col' + (inkT === 'hl' ? ' hl' : ''),
    icon: `<span style="--c:${c === 'auto' ? 'var(--fg)' : c}"></span>`, on: (t === 'pen' || t === 'hl') && prefs[inkT].c === c}));
  const sizes = wheelSizes(sizeT), sv = prefs[sizeT].s, best = sizes.reduce((a, b) => Math.abs(b - sv) < Math.abs(a - sv) ? b : a);
  sizes.forEach((v, i) => outer.push({w: 's', v, slot: i, label: ['Thin', 'Medium', 'Thick'][i], cls: 'wh-size', icon: `<span style="--d:${4 + v / 7}px"></span>`, on: best === v}));
  if(t === 'eraser'){ const area = prefs.eraser.mode === 'area'; outer.push({w: 'em', label: 'Eraser: switch to ' + (area ? 'Stroke' : 'Partial'), cls: 'wh-em', icon: area ? 'Partial' : 'Stroke'}); }
  return [inner, outer];
}
const arcPt = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
function wedge(r0, r1, a0, a1){
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${arcPt(r1, a0)}A${r1} ${r1} 0 ${big} 1 ${arcPt(r1, a1)}L${arcPt(r0, a1)}A${r0} ${r0} 0 ${big} 0 ${arcPt(r0, a0)}Z`;
}
function buildWheel(){
  if(!wheelGeo) return;
  const dir = wheelGeo.dir, A0 = dir - WH_SPAN / 2, gap = 0.035;
  const [inner, outer] = wheelItems(), segs = [];
  let svg = `<svg class="wh-svg" viewBox="${-WH_R2 - 4} ${-WH_R2 - 4} ${2 * WH_R2 + 8} ${2 * WH_R2 + 8}" style="left:${-WH_R2 - 4}px;top:${-WH_R2 - 4}px;width:${2 * WH_R2 + 8}px;height:${2 * WH_R2 + 8}px">`;
  svg += `<path class="wh-bg" d="${wedge(WH_R0 - 4, WH_R2 + 4, A0 - 0.04, A0 + WH_SPAN + 0.04)}"/>`;
  let icons = '';
  [[inner, WH_R0, WH_R1], [outer, WH_R1 + 3, WH_R2]].forEach(([list, r0, r1], ring) => {
    const step = WH_SPAN / list.length;
    list.forEach((o, i) => {
      const a0 = A0 + i * step, a1 = a0 + step, m = (a0 + a1) / 2, rm = (r0 + r1) / 2, k = segs.length;
      const data = `data-w="${o.w}"${o.v !== undefined ? ` data-v="${esc(String(o.v))}"` : ''}${o.slot !== undefined ? ` data-slot="${o.slot}"` : ''} data-i="${k}" aria-label="${esc(o.label)}"`;
      svg += `<path class="wh-b wh-seg ${o.on ? 'on' : ''}" ${data} d="${wedge(r0, r1, a0 + gap / 2, a1 - gap / 2)}"/>`;
      icons += `<span class="wh-i ${o.cls} ${o.on ? 'on' : ''}" data-i="${k}" style="left:${(rm * Math.cos(m)).toFixed(1)}px;top:${(rm * Math.sin(m)).toFixed(1)}px">${o.icon}</span>`;
      segs.push({ring, a0, a1});
    });
  });
  svg += '</svg>';
  const lr = WH_R2 + 48, lx = clamp(wheelGeo.x + lr * Math.cos(dir), 90, innerWidth - 90) - wheelGeo.x, ly = clamp(wheelGeo.y + lr * Math.sin(dir), 24, innerHeight - 24) - wheelGeo.y;
  $('wheel').innerHTML = svg + icons + `<div class="wh-label" id="whLabel" hidden style="left:${lx.toFixed(0)}px;top:${ly.toFixed(0)}px"></div><span class="wh-tip"></span>`;
  wheelGeo.segs = segs;
}
// the wedge in the direction of (cx, cy) from the Pencil tip; the middle (under the Pencil) is "nothing"
function wheelAt(cx, cy){
  const g = wheelGeo, w = $('wheel'); if(!g || w.hidden) return null;
  const dx = cx - g.x, dy = cy - g.y, d = Math.hypot(dx, dy);
  if(d < WH_R0 - 6 || d > WH_R2 + 70) return null;
  let a = Math.atan2(dy, dx); const A0 = g.dir - WH_SPAN / 2;
  while(a < A0) a += 2 * Math.PI; while(a >= A0 + 2 * Math.PI) a -= 2 * Math.PI;
  if(a > A0 + WH_SPAN) return null;
  const ring = d < WH_R1 + 1 ? 0 : 1, k = g.segs.findIndex(s => s.ring === ring && a >= s.a0 && a < s.a1);
  return k < 0 ? null : w.querySelector(`.wh-seg[data-i="${k}"]`);
}
function openWheel(x, y, pointerId){
  if(!cur) return;
  closePops(); clearSel();
  // right-handed: the hand rests to the right of and below the Pencil, so the half-moon opens left and a little up
  const base = prefs.wheel === 'left' ? -20 * Math.PI / 180 : 200 * Math.PI / 180, m = 6;
  const fitScore = dir => { let n = 0; for(let i = 0; i <= 12; i++){ const a = dir - WH_SPAN / 2 + i * WH_SPAN / 12, px = x + (WH_R2 + 4) * Math.cos(a), py = y + (WH_R2 + 4) * Math.sin(a); if(px >= m && px <= innerWidth - m && py >= m && py <= innerHeight - m) n++; } return n; };
  let dir = base, best = -1;
  for(const off of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]){
    const d = base + off * Math.PI / 180, sc = fitScore(d);
    if(sc > best){ best = sc; dir = d; } if(sc === 13) break;
  }
  wheelGeo = {x, y, dir, segs: []};
  buildWheel();
  const w = $('wheel');
  w.style.left = x + 'px'; w.style.top = y + 'px';
  w.style.setProperty('--wdx', (Math.cos(dir) * -14).toFixed(1) + 'px'); w.style.setProperty('--wdy', (Math.sin(dir) * -14).toFixed(1) + 'px');
  w.hidden = false; w.classList.remove('in'); void w.offsetWidth; w.classList.add('in');
  wheelDrag = pointerId != null ? {id: pointerId, x, y, far: false} : null;
}
// (1.69) holding the Pencil (or a finger) on a size: a ring fills up around it, then that size becomes the one on
// the thickness slider (for the current tool), the menu shows the new size and stays open until the Pencil is lifted
let wheelHold = null;   // {b, timer, raf, el}
// (1.69.2) the held size "charges up": the wedge fills from the inside out (after a short pause, so a quick pick shows
// nothing); when full, it flashes, the dot grows or shrinks to the new size with a little bounce and the label says
// "Thick: 15 → 23"
const WHEEL_WAIT = 250;
function wheelSegGeo(b){ const g = wheelGeo && wheelGeo.segs[+b.dataset.i]; return g ? {r0: g.ring ? WH_R1 + 3 : WH_R0, r1: g.ring ? WH_R2 : WH_R1, a0: g.a0 + 0.0175, a1: g.a1 - 0.0175} : null; }
function wheelOverlay(b, cls){
  const svg = $('wheel').querySelector('.wh-svg'), g = wheelSegGeo(b); if(!svg || !g) return null;
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('class', cls); svg.appendChild(el); el._g = g;
  return el;
}
function wheelHoldStop(){
  if(!wheelHold) return;
  clearTimeout(wheelHold.timer); cancelAnimationFrame(wheelHold.raf);
  if(wheelHold.el) wheelHold.el.remove();
  wheelHold = null;
}
function wheelHoldTrack(b){
  if(wheelHold && wheelHold.b === b) return;
  wheelHoldStop();
  if(!b || b.dataset.w !== 's' || !(wheelPress || wheelDrag)) return;
  const el = wheelOverlay(b, 'wh-charge'), t0 = performance.now() + WHEEL_WAIT, span = WHEEL_SAVE - WHEEL_WAIT;
  const hold = wheelHold = {b, el, raf: 0, timer: 0};
  const tick = () => {
    if(wheelHold !== hold || !el) return;
    const p = clamp((performance.now() - t0) / span, 0, 1), e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2, g = el._g;
    if(p > 0) el.setAttribute('d', wedge(g.r0, g.r0 + Math.max(0.5, (g.r1 - g.r0) * e), g.a0, g.a1));
    if(p < 1) hold.raf = requestAnimationFrame(tick);
  };
  hold.raf = requestAnimationFrame(tick);
  hold.timer = setTimeout(() => {
    if(wheelHold !== hold) return;
    wheelHoldStop();
    const t = ['pen', 'hl', 'eraser', 'mark'].includes(prefs.tool) ? prefs.tool : 'pen', i = +b.dataset.slot, v = Math.round(prefs[t].s);
    if(!(i >= 0 && i < 3) || !(v >= 1)) return;
    const list = wheelSizes(t), old = list[i]; list[i] = v;
    if(!prefs.wheelSizes || typeof prefs.wheelSizes !== 'object') prefs.wheelSizes = {};
    prefs.wheelSizes[t] = list; savePrefs();
    buildWheel();
    const nb = $('wheel').querySelector(`.wh-seg[data-w="s"][data-slot="${i}"]`);
    if(!nb) return;
    if(wheelPress){ wheelPress.b = nb; wheelPress.saved = true; }   // lifting here picks it (the same size) and closes
    wheelHold = {b: nb, timer: 0, raf: 0, el: null};                // no second save while it is still held
    wheelHover(nb);
    const fl = wheelOverlay(nb, 'wh-flash'); if(fl){ const g = fl._g; fl.setAttribute('d', wedge(g.r0, g.r1, g.a0, g.a1)); }
    const ic = $('wheel').querySelector(`.wh-i[data-i="${nb.dataset.i}"]`), dot = ic && ic.querySelector('span');
    if(ic) ic.classList.add('saved');
    if(dot){
      // grow or shrink from the old size to the new one
      dot.style.transition = 'none'; dot.style.setProperty('--d', (4 + old / 7) + 'px'); void dot.offsetWidth;
      dot.style.transition = ''; dot.style.setProperty('--d', (4 + v / 7) + 'px');
    }
    const L = $('whLabel'); if(L){ L.textContent = `${nb.getAttribute('aria-label') || 'Size'}: ${old} → ${v}`; L.hidden = false; }
  }, WHEEL_SAVE);
}
// the option under the Pencil grows, fills in and is named above the menu
function wheelHover(b){
  wheelHoldTrack(b);
  const w = $('wheel');
  w.querySelectorAll('.wh-b.hover').forEach(x => { if(x !== b) x.classList.remove('hover'); });
  const L = $('whLabel'); if(!L) return;
  w.querySelectorAll('.wh-i.hover').forEach(x => { if(!b || x.dataset.i !== b.dataset.i) x.classList.remove('hover'); });
  if(!b){ L.hidden = true; w.classList.remove('picking'); return; }
  b.classList.add('hover'); w.classList.add('picking');
  const ic = w.querySelector(`.wh-i[data-i="${b.dataset.i}"]`); if(ic) ic.classList.add('hover');
  const c = b.dataset.w === 'c' ? b.dataset.v : null;
  L.innerHTML = (c ? `<span class="wh-dot" style="--c:${c === 'auto' ? 'var(--fg)' : c}"></span>` : '') + esc(b.getAttribute('aria-label') || '');
  L.hidden = false;
}
function closeWheel(){ wheelHoldStop(); const w = $('wheel'); if(w && !w.hidden){ w.hidden = true; w.innerHTML = ''; w.classList.remove('picking'); } wheelDrag = null; wheelPress = null; wheelGeo = null; }
function wheelPick(b){
  const k = b.dataset.w, v = b.dataset.v;
  if(k === 'undo'){ undo(); closeWheel(); return; }
  if(k === 'tool'){
    const was = prefs.tool;
    setTool(v);
    if(v === 'eraser' && was !== 'eraser') eraseOnce = ['pen', 'hl', 'mark'].includes(was) ? was : 'pen';
  }
  else if(k === 'c'){
    if(prefs.tool !== 'pen' && prefs.tool !== 'hl') setTool('pen');
    prefs[prefs.tool].c = v; savePrefs(); renderOpts();
  } else if(k === 's'){
    if(!['pen', 'hl', 'eraser', 'mark'].includes(prefs.tool)) setTool('pen');
    prefs[prefs.tool].s = +v; savePrefs(); renderOpts();
  } else if(k === 'em'){
    prefs.eraser.mode = prefs.eraser.mode === 'area' ? 'stroke' : 'area'; savePrefs(); renderOpts();
    buildWheel(); return;   // stay open to see the change
  }
  closeWheel();
}
$('wheel').addEventListener('click', e => { const b = wheelAt(e.clientX, e.clientY); if(b) wheelPick(b); });
$('wheel').addEventListener('contextmenu', e => e.preventDefault());
$('wheel').addEventListener('pointerdown', e => {
  const b = wheelAt(e.clientX, e.clientY); if(!b) return;
  wheelPress = {id: e.pointerId, b}; wheelHover(b);
  // touches are captured by the button they started on; release so lifting over another option counts there
  try { if(e.target.hasPointerCapture && e.target.hasPointerCapture(e.pointerId)) e.target.releasePointerCapture(e.pointerId); } catch {}
});
$('wheel').addEventListener('pointermove', e => {
  if(!wheelPress || wheelPress.id !== e.pointerId) return;
  wheelHover(wheelAt(e.clientX, e.clientY));
});
$('wheel').addEventListener('pointerup', e => {
  if(!wheelPress || wheelPress.id !== e.pointerId) return;
  const start = wheelPress.b, saved = wheelPress.saved; wheelPress = null;
  const b = wheelAt(e.clientX, e.clientY);
  wheelHover(null);
  // slid from one option to another: choose where the Pencil was lifted (a plain tap is handled by click);
  // (1.69) after a size was saved by holding, the menu was redrawn under the finger, so no click follows: pick here
  if(b && (b !== start || saved)) wheelPick(b);
});
$('wheel').addEventListener('pointercancel', () => { wheelPress = null; wheelHover(null); });
// slide the Pencil onto an option and lift it to choose without tapping again
addEventListener('pointermove', e => {
  if(!wheelDrag || e.pointerId !== wheelDrag.id) return;
  if(!wheelDrag.far && Math.hypot(e.clientX - wheelDrag.x, e.clientY - wheelDrag.y) > 18) wheelDrag.far = true;
  wheelHover(wheelAt(e.clientX, e.clientY));
}, true);
addEventListener('pointerup', e => {
  if(!wheelDrag || e.pointerId !== wheelDrag.id) return;
  const d = wheelDrag; wheelDrag = null;
  const b = wheelAt(e.clientX, e.clientY);
  wheelHover(null);
  if(d.far && b) wheelPick(b);
}, true);
addEventListener('pointercancel', e => { if(wheelDrag && e.pointerId === wheelDrag.id) wheelDrag = null; }, true);
// a touch anywhere else closes the menu and does nothing else
document.addEventListener('pointerdown', e => {
  const w = $('wheel');
  if(w.hidden || e.target.closest('#wheel')) return;
  closeWheel(); e.stopPropagation(); e.preventDefault();
}, true);
addEventListener('resize', closeWheel);

/* paper */
function renderPaper(){
  if(!cur) return;
  const bg = cur.bg;
  document.querySelectorAll('#paperType button').forEach(b => b.classList.toggle('on', b.dataset.v === bg.type));
  $('fxWrap').hidden = bg.type === 'blank' || bg.type === 'lined';
  $('fyWrap').hidden = bg.type === 'blank';
  $('linkXY').parentElement.hidden = bg.type === 'blank' || bg.type === 'lined';
  $('fyLbl').firstChild.textContent = bg.type === 'lined' ? 'Line height ' : 'Height ';
  $('fx').value = (bg.sx / MM).toFixed(1); $('fy').value = (bg.sy / MM).toFixed(1);
  $('fxVal').textContent = (bg.sx / MM).toFixed(1) + ' mm'; $('fyVal').textContent = (bg.sy / MM).toFixed(1) + ' mm';
  $('linkXY').checked = Math.abs(bg.sx - bg.sy) < 0.01;
}
function setBg(patch){ cur.bg = Object.assign({}, cur.bg, patch); renderPaper(); invalidate(1, 0, 0); saveContentSoon(); }
$('paperBtn').addEventListener('click', e => { if(!cur) return; renderPaper(); openPop('paperPop', e.currentTarget); });
$('paperType').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if(b && cur) setBg({type: b.dataset.v}); });
$('fx').addEventListener('input', () => { const v = +$('fx').value * MM; setBg($('linkXY').checked ? {sx: v, sy: v} : {sx: v}); });
$('fy').addEventListener('input', () => { const v = +$('fy').value * MM; setBg($('linkXY').checked && cur.bg.type !== 'lined' ? {sx: v, sy: v} : {sy: v}); });
$('linkXY').addEventListener('change', () => { if($('linkXY').checked) setBg({sy: cur.bg.sx}); });
$('paperDefault').addEventListener('click', () => { if(!cur) return; prefs.bg = Object.assign({}, cur.bg); savePrefs(); closePops(); toast('New pages will use this paper'); });

/* more menu */
$('moreBtn').addEventListener('click', e => { if(!cur) return; const d = $('mDelete'); d.classList.remove('armed'); d.textContent = 'Delete page'; openPop('morePop', e.currentTarget); });
$('mDelete').addEventListener('click', () => {
  const d = $('mDelete');
  if(!d.classList.contains('armed')){ d.classList.add('armed'); d.textContent = 'Tap again to delete this page'; return; }
  closePops(); if(cur) deletePage(cur.id);
});
$('mSnap').addEventListener('click', () => { prefs.snapLines = !prefs.snapLines; savePrefs(); $('mSnap').classList.toggle('on', prefs.snapLines); toast(prefs.snapLines ? 'Typed text snaps to answer lines' : 'Text snapping off'); });
$('mFit').addEventListener('click', () => {
  closePops(); const b = contentBox();
  if(!b){ zoomAt(W / 2, H / 2, 1); return; }
  const z = clamp(Math.min((W - 48) / (b[2] - b[0]), (H - 48) / (b[3] - b[1])), Z_MIN, Math.min(2, zMax()));   // (1.67.4) respects Max zoom
  cam.z = z; cam.ox = (W - (b[2] - b[0]) * z) / 2 - b[0] * z; cam.oy = 24 - b[1] * z;
  invalidate(); saveCamSoon();
});
$('mTemplate').addEventListener('click', () => {
  closePops(); if(!cur) return;
  $('tmplName').value = $('title').value || 'Template';
  showModal('tmplDlg'); setTimeout(() => { $('tmplName').focus(); $('tmplName').select(); }, 60);
});
$('tmplSave').addEventListener('click', async () => {
  if(!cur) return;
  finishEditing();
  const name = $('tmplName').value.trim() || 'Template';
  await newDoc('tmpl', {name, bg: Object.assign({}, cur.bg), items: [...cur.items.values()].map(ser)});
  hideModal('tmplDlg'); renderTemplates(); toast(`Template “${name}” saved`);
});
$('mExport').addEventListener('click', () => { closePops(); exportPdfFile(); });
/* ---------- Page history (1.27): list, small previews, restore as one undo step ---------- */
$('mHistory').addEventListener('click', () => { closePops(); openHistory(); });
function verWhen(at){
  const d = new Date(at), today = new Date().toDateString() === d.toDateString();
  return (today ? 'Today' : d.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'})) + ', ' + hhmm(at);
}
async function openHistory(){
  if(!cur) return;
  if(editing) finishEditing();
  await flushSaves();
  const pid = cur.id, list = await versionsOf(pid), box = $('histList');
  if(!list.length) box.innerHTML = '<p class="hint">No earlier versions yet. From now on Inkwell keeps one each time you come back to this page and change it.</p>';
  else box.innerHTML = list.map((v, i) => {
    const why = v.data.why === 'merge' ? 'before changes from another device' : v.data.why === 'restore' ? 'before a restore' : 'before editing';
    return `<div class="trash-item hist-item" data-i="${i}"><canvas width="192" height="128"></canvas><div class="ti-text"><div class="ti-name">${esc(verWhen(v.data.at))}</div><div class="hint">${v.data.n} item${v.data.n === 1 ? '' : 's'}, ${why}</div></div><button class="btn ghost" data-act="restore">Restore</button></div>`;
  }).join('');
  box.onclick = async e => {
    const b = e.target.closest('[data-act="restore"]'); if(!b) return;
    const v = list[+b.closest('.hist-item').dataset.i];
    hideModal('histDlg');
    await restoreVersion(v);
  };
  showModal('histDlg');
  // previews, one at a time so a long history stays responsive
  const cvs = [...box.querySelectorAll('canvas')];
  for(let i = 0; i < cvs.length; i++){
    await new Promise(r => setTimeout(r, 0));
    if($('histDlg').hidden) break;
    try { drawVersion(cvs[i], list[i].data); } catch(e){ console.warn('preview', e); }
  }
}
function drawVersion(cv, data){
  const items = (data.items || []).map(deser).filter(Boolean);
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  if(!items.length) return;
  const boxOf = it => it.t === 's' ? strokeBox(it) : [it.x || 0, it.y || 0, (it.x || 0) + (it.w || 120), (it.y || 0) + (it.h || (it.t === 'x' ? 26 * (it.fs || 1) : 40))];
  let b = null;
  for(const it of items){ const q = boxOf(it); b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q; }
  const sc = Math.min((W - 12) / Math.max(1, b[2] - b[0]), (H - 12) / Math.max(1, b[3] - b[1]), 1);
  ctx.setTransform(sc, 0, 0, sc, 6 - b[0] * sc, 6 - b[1] * sc);
  for(const it of items){
    if(it.t === 's'){ ctx.globalAlpha = (it.hl ? 0.35 : 1) * opOf(it); ctx.fillStyle = inkColor(it.c, true); ctx.fill(strokePath(it, false)); ctx.globalAlpha = 1; }
    else { const q = boxOf(it); ctx.fillStyle = it.t === 'i' ? '#e4e6ea' : it.t === 'tp' ? '#e8b23a' : '#c3c8d0'; ctx.fillRect(q[0], q[1], q[2] - q[0], it.t === 'x' ? Math.min(q[3] - q[1], 10 / sc) : q[3] - q[1]); }
  }
}
async function restoreVersion(v){
  const pid = v.data.page;
  if(!cur || cur.id !== pid) await openPage(pid);
  if(!cur || cur.id !== pid) return;
  if(editing) finishEditing();
  await saveVersion(pid, {bg: cur.bg, items: [...cur.items.values()].map(ser)}, 'restore');
  cur.verAt = Date.now();
  const target = new Map();
  for(const sItem of v.data.items || []){ const it = deser(sItem); if(it && it.id) target.set(it.id, it); }
  const after = [], before = [];
  for(const id of new Set([...cur.items.keys(), ...target.keys()])){
    const o = cur.items.get(id) || null, n = target.get(id) || null;
    if(o && n && stable(ser(o)) === stable(ser(n))) continue;
    after.push([id, n]); before.push([id, o]);
  }
  clearSel();
  if(after.length) apply(after, before);
  if(v.data.bg && stable(v.data.bg) !== stable(cur.bg)){ cur.bg = normBg(v.data.bg); renderPaper(); invalidate(); saveContentSoon(); }
  toast('Restored the version from ' + verWhen(v.data.at) + '. Undo brings back what you had.');
}

/* =====================================================================
   Popovers and dialogs
   ===================================================================== */
function openPop(id, anchor){
  const p = $(id), wasOpen = !p.hidden;
  closePops(id === 'tcolorPop' ? 'keepFmt' : null);
  if(wasOpen) return;
  p.hidden = false;
  const r = anchor.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
  let x = clamp(r.left + r.width / 2 - pw / 2, 8, innerWidth - pw - 8);
  let y = r.bottom + 8;
  if(y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 8);
  p.style.left = x + 'px'; p.style.top = y + 'px';
  p._anchor = anchor; anchor.classList.add('pop-open');
}
function closePop(id){ const p = $(id); p.hidden = true; if(p._anchor){ p._anchor.classList.remove('pop-open'); p._anchor = null; } }
function closePops(){ for(const id of ['paperPop', 'morePop', 'newPop', 'colorPop', 'tcolorPop', 'shapePop', 'laterPop', 'fadePop', 'assistPop', 'tsizePop', 'spellPop']) closePop(id); }
document.addEventListener('pointerdown', e => {
  if(e.target.closest('.pop') || e.target.closest('#paperBtn,#moreBtn,#newMore,#colorBtn,#shapeBtn,#laterBtn,#selFade,#assistBtn,[data-act="tcolor"],[data-act="tsize"],[data-act="spell"]')) return;
  closePops();
}, true);
let modalAt = 0;
function showModal(id){ closePops(); $(id).hidden = false; modalAt = Date.now(); }
function hideModal(id){
  $(id).hidden = true;
  if(id === 'exportDlg' && typeof Pdf !== 'undefined') Pdf.abort = true;
  if(id === 'importDlg' && typeof dropImport === 'function') dropImport();
  if(id === 'linkDlg' && keepEditing){ keepEditing = false; if(editing){ const el = elMap.get(editing.id); if(el) el.focus({preventScroll: true}); } }
}
document.querySelectorAll('.modal').forEach(m => {
  // (1.44.1) the click a finger tap sends after lifting lands on the backdrop of a dialog that tap just opened: ignore it
  m.addEventListener('click', e => { if(e.target === m && Date.now() - modalAt < 500) return; if(e.target === m || e.target.closest('[data-close]')) hideModal(m.id); });
});

/* page links */
let linkRange = null;
function openLinkPicker(){
  const s = getSelection();
  linkRange = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
  keepEditing = true;
  $('linkSearch').value = '';
  renderLinkList();
  showModal('linkDlg');
  setTimeout(() => $('linkSearch').focus(), 60);
}
function renderLinkList(){
  const q = $('linkSearch').value.trim().toLowerCase();
  const pages = [...docs.values()].filter(d => d.kind === 'page' && live(d) && (!cur || d.id !== cur.id)).sort((a, b) => b.updated - a.updated)
    .filter(p => !q || (p.data.title || '').toLowerCase().includes(q) || pathOf(p).toLowerCase().includes(q)).slice(0, 60);
  $('linkList').innerHTML = pages.map(p => `<button data-lp="${p.id}">${esc(p.data.title || 'Untitled page')}<small>${esc(pathOf(p))}</small></button>`).join('') || '<p class="hint" style="padding:12px">No other pages yet.</p>';
}
$('linkSearch').addEventListener('input', renderLinkList);
$('linkList').addEventListener('click', e => {
  const b = e.target.closest('[data-lp]'); if(!b) return;
  const p = getDoc(b.dataset.lp);
  hideModal('linkDlg');
  if(!editing || !p) return;
  const el = elMap.get(editing.id);
  el.focus({preventScroll: true});
  const s = getSelection();
  if(linkRange && el.contains(linkRange.startContainer)){ s.removeAllRanges(); s.addRange(linkRange); }
  const label = (s.rangeCount && !s.isCollapsed) ? s.toString() : (p.data.title || 'Untitled page');
  document.execCommand('insertHTML', false, `<a class="pl" data-page="${p.id}" contenteditable="false">${esc(label)}</a>&nbsp;`);
  prepTextEl(el);
  syncEditingHTML(); saveContentSoon();
});
