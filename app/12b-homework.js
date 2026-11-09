/* =====================================================================
   Homework (1.93). Mark something with the Select tool (Free or Box) → Homework: a picture of the marked part, what
   to do and a due date. Doc kind 'hw' (syncs like other docs; older app versions ignore it):
     {text, a (asset id of the picture), page (page id), b (world box on that page), due 'YYYY-MM-DD' | '',
      remind: null, done?: true, doneAt?, at}
   The top bar's Homework button lists them. (1.93.1) Phone reminders removed (Rafael); `remind` is always null now and
   an old push subscription on a device is dropped once (HWK.dropPush).
   ===================================================================== */
'use strict';
const HWK = {
  editId: null, area: null, page: null, blob: null, imgUrl: null, viewId: null,
  all(){ return [...docs.values()].filter(d => d.kind === 'hw' && live(d)); },
  open(){ return this.all().filter(d => !d.data.done); },
  // ---- dates ----
  ymd(d){ return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
  day(s){ const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; },
  dueText(s){
    const d = this.day(s); if(!d) return '';
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const n = Math.round((d - t) / 86400000);
    if(n === 0) return 'today'; if(n === 1) return 'tomorrow'; if(n === -1) return 'yesterday';
    return d.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short'}).replace(',', '');
  },
  late(s){ const d = this.day(s); if(!d) return false; const t = new Date(); t.setHours(0, 0, 0, 0); return d < t; },
  // ---- adding ----
  // area = world box on the open page; text = what to put in "What to do" at first
  async start(area, text){
    if(!cur || !area) return;
    const pad = 8, a = [area[0] - pad, area[1] - pad, area[2] + pad, area[3] + pad];
    let blob = null;
    try { blob = await (await fetch(await Ask.capture(a[0], a[1], a[2], a[3], {pad: 0, max: 1400}))).blob(); }
    catch(e){ console.warn('homework picture', e); toast('Could not make the picture of that part'); return; }
    this.editId = null; this.area = area.slice(); this.page = cur.id; this.blob = blob;
    this.setImg(URL.createObjectURL(blob));
    $('hwDlgTitle').textContent = 'Add to Homework'; $('hwSave').textContent = 'Add';
    $('hwText').value = (text || '').trim().slice(0, 500);
    const t = new Date(); t.setDate(t.getDate() + 1);
    $('hwDue').value = this.ymd(t);
    showModal('hwDlg');
  },
  // u = a picture made here (revoked when replaced); null clears it
  setImg(u){ if(this.imgUrl) URL.revokeObjectURL(this.imgUrl); this.imgUrl = u; if(u) $('hwImg').src = u; else $('hwImg').removeAttribute('src'); },
  async save(){
    const text = $('hwText').value.trim().slice(0, 500), due = $('hwDue').value || '';
    const patch = {text, due, remind: null, when: 'none'};
    try {
      if(this.editId){
        const rec = docs.get(this.editId); if(!rec || !live(rec)){ hideModal('hwDlg'); return; }
        await patchDoc(rec, Object.assign(patch, {done: false, doneAt: null}));
        hideModal('hwDlg'); toast('Homework saved');
        if(!$('hwViewDlg').hidden) this.view(rec.id);
      } else {
        const a = await saveAsset(this.blob);
        const rec = await newDoc('hw', Object.assign(patch, {a, page: this.page, b: this.area, at: Date.now()}));
        hideModal('hwDlg');
        toast('Added to Homework' + (patch.due ? ' (due ' + this.dueText(patch.due) + ')' : ''), 'Open', () => this.openList());
        this.blob = null; void rec;
      }
    } catch(e){ console.warn('homework save', e); toast('Could not save: ' + (e.message || e)); return; }
    this.count(); if(!$('hwListDlg').hidden) this.renderList();
  },
  // from the selection menu: the selected items' box (and the Box area / page text lines)
  fromSel(){
    let b = sel && sel.b ? sel.b.slice() : null;
    const u = (q) => { b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q.slice(); };
    if(TS.area) u(TS.area);
    for(const l of TS.lines) u(l.b);
    return b;
  },
  textIn(area){
    if(TS.lines.length) return TS.text();
    const out = [];
    for(const it of cur ? cur.items.values() : []){
      if(it.t !== 'x') continue;
      const q = itemBox(it); if(q[2] < area[0] || q[0] > area[2] || q[3] < area[1] || q[1] > area[3]) continue;
      out.push([q[1], htmlText(it.html)]);
    }
    return out.sort((a, b) => a[0] - b[0]).map(x => x[1]).join('\n');
  },
  // ---- list ----
  count(){
    const n = this.open().length, el = $('hwCount');
    if(!el) return;
    el.hidden = !n; el.textContent = n > 99 ? '99+' : String(n);
  },
  openList(){ showModal('hwListDlg'); this.renderList(); },
  renderList(){
    const list = $('hwList');
    const open = this.open().sort((a, b) => (a.data.due || '9999') .localeCompare(b.data.due || '9999') || (a.data.at || 0) - (b.data.at || 0));
    const done = this.all().filter(d => d.data.done).sort((a, b) => (b.data.doneAt || 0) - (a.data.doneAt || 0)).slice(0, 30);
    const row = d => {
      const x = d.data, due = x.due ? 'Due ' + this.dueText(x.due) : 'No due date';
      const pg = x.page && getDoc(x.page);
      const sub = pg ? (pg.data.title || 'Untitled page') : '';
      return `<div class="later-row hw-row${x.done ? ' done' : ''}" data-id="${esc(d.id)}">
        <button class="later-go" data-view="${esc(d.id)}"><img class="hw-pv" alt="" data-a="${esc(x.a || '')}"><span class="later-txt"><b>${esc(x.text || 'Homework')}</b><span class="${!x.done && this.late(x.due) ? 'hw-late' : ''}">${esc(due)}</span>${sub ? `<i>${esc(sub)}</i>` : ''}</span></button>
        <button class="later-done" data-done="${esc(d.id)}" title="${x.done ? 'Not done yet' : 'Done'}" aria-label="${x.done ? 'Mark as not done' : 'Mark as done'}"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>
      </div>`;
    };
    let html = '';
    if(!open.length) html += '<div class="later-empty">Nothing to do. To add homework: pick the Select tool, circle or box what you have to do, then tap Homework.</div>';
    html += open.map(row).join('');
    if(done.length) html += `<div class="later-head">Done <span>${done.length}</span></div>` + done.map(row).join('');
    list.innerHTML = html;
    (async () => {
      for(const img of list.querySelectorAll('img[data-a]')){
        if($('hwListDlg').hidden) return;
        const a = img.dataset.a; if(!a) continue;
        const u = await assetURL(a).catch(() => null);
        if(u) img.src = u;
      }
    })();
  },
  async setDone(id, done){
    const rec = docs.get(id); if(!rec || !live(rec)) return;
    await patchDoc(rec, {done: !!done, doneAt: done ? Date.now() : null});
    this.count();
    if(!$('hwListDlg').hidden) this.renderList();
  },
  async del(id){
    const rec = docs.get(id); if(!rec || !live(rec)) return;
    const keep = Object.assign({}, rec.data);
    await removeDoc(id, 'hw', null, true);
    this.count(); if(!$('hwListDlg').hidden) this.renderList();
    toast('Homework deleted', 'Undo', async () => {
      const r = docs.get(id) || await IDB.get('docs', id) || {id, kind: 'hw'};
      r.kind = 'hw'; r.deleted = false; r.data = keep;
      await writeDoc(r); this.count(); if(!$('hwListDlg').hidden) this.renderList();
    });
  },
  async view(id){
    const rec = docs.get(id); if(!rec || !live(rec)){ toast('That homework was deleted'); return; }
    this.viewId = id;
    const x = rec.data;
    $('hwvDue').textContent = x.due ? 'Due ' + this.dueText(x.due) : 'Homework';
    $('hwvDue').classList.toggle('hw-late', !x.done && this.late(x.due));
    $('hwvText').textContent = x.text || '';
    const pg = x.page && getDoc(x.page);
    $('hwvInfo').textContent = [x.done ? 'Done' : '', pg ? 'On ' + (pg.data.title || 'Untitled page') : (x.page ? 'The page was deleted' : '')].filter(Boolean).join(' · ');
    $('hwvGo').hidden = !pg;
    $('hwvDone').textContent = x.done ? 'Not done' : 'Done';
    $('hwvImg').removeAttribute('src');
    showModal('hwViewDlg');
    if(x.a){ const u = await assetURL(x.a).catch(() => null); if(u && this.viewId === id) $('hwvImg').src = u; }
  },
  async edit(id){
    const rec = docs.get(id); if(!rec || !live(rec)) return;
    const x = rec.data;
    this.editId = id; this.blob = null;
    $('hwDlgTitle').textContent = 'Edit homework'; $('hwSave').textContent = 'Save';
    $('hwText').value = x.text || ''; $('hwDue').value = x.due || '';
    this.setImg(null);
    hideModal('hwViewDlg');
    showModal('hwDlg');
    if(x.a){ const u = await assetURL(x.a).catch(() => null); if(u && this.editId === id) $('hwImg').src = u; }
  },
  async go(id){
    const rec = docs.get(id); if(!rec || !live(rec)) return;
    hideModal('hwViewDlg'); hideModal('hwListDlg');
    const b = rec.data.b;
    if(b && b.length === 4) await goToMark(rec.data.page, {b, ids: []});
    else if(getDoc(rec.data.page)) await goToMark(rec.data.page, {b: [0, 0, 400, 300], ids: []});
  },
  // (1.93.1) reminders were removed: a device that had them turned on drops its push subscription once
  // (browser side, and the server's list when signed in). Nothing else to do: the server job that sent them is off.
  async dropPush(){
    const ep = LSget('inkwell.push', null); if(!ep) return;
    try { const reg = await navigator.serviceWorker.ready; const sub = reg.pushManager && await reg.pushManager.getSubscription(); if(sub) await sub.unsubscribe(); } catch {}
    try {
      const {data} = await Sync.sb.auth.getSession(); const s = data && data.session;
      if(s) await fetch(CFG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/push', {method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token, apikey: CFG.SUPABASE_ANON_KEY},
        body: JSON.stringify({action: 'unsub', endpoint: ep})});
    } catch {}
    LSset('inkwell.push', null); LSset('inkwell.pushKey', null);
  },
};

$('selHw').addEventListener('click', () => {
  const area = HWK.fromSel(); if(!area) return;
  const text = HWK.textIn(area);
  clearSel(); HWK.start(area, text);
});
$('tsHw').addEventListener('click', () => {
  const area = HWK.fromSel(); if(!area) return;
  const text = HWK.textIn(area);
  clearSel(); HWK.start(area, text);
});
$('hwSave').addEventListener('click', () => HWK.save());
$('hwBtn').addEventListener('click', () => HWK.openList());
$('hwList').addEventListener('click', ev => {
  const v = ev.target.closest('[data-view]'), d = ev.target.closest('[data-done]');
  if(d){ const rec = docs.get(d.dataset.done); if(rec) HWK.setDone(rec.id, !rec.data.done); }
  else if(v) HWK.view(v.dataset.view);
});
$('hwvDone').addEventListener('click', async () => {
  const rec = docs.get(HWK.viewId); if(!rec) return;
  const done = !rec.data.done;
  await HWK.setDone(rec.id, done);
  hideModal('hwViewDlg');
  if(done) toast('Done', 'Undo', () => HWK.setDone(rec.id, false));
});
$('hwvDel').addEventListener('click', () => { const id = HWK.viewId; hideModal('hwViewDlg'); HWK.del(id); });
$('hwvEdit').addEventListener('click', () => HWK.edit(HWK.viewId));
$('hwvGo').addEventListener('click', () => HWK.go(HWK.viewId));
// (1.93.1) an old link from a reminder (?hw=<id>) just opens the Homework list
(() => {
  const q = new URLSearchParams(location.search);
  if(q.has('hw')){
    q.delete('hw');
    try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); } catch {}
    setTimeout(() => HWK.openList(), 1200);
  }
})();
setTimeout(() => HWK.dropPush(), 4000);
setInterval(() => HWK.count(), 30000);
document.addEventListener('visibilitychange', () => { if(!document.hidden) HWK.count(); });
setTimeout(() => HWK.count(), 1500);
