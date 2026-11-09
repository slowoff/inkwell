/* =====================================================================
   Homework (1.93). Mark something with the Select tool (Free or Box) → Homework: a picture of the marked part, what
   to do, a due date and a reminder time. Doc kind 'hw' (syncs like other docs; older app versions ignore it):
     {text, a (asset id of the picture), page (page id), b (world box on that page), due 'YYYY-MM-DD' | '',
      remind (ms since 1970) | null, done?: true, doneAt?, at}
   The top bar's Homework button lists them. Reminders reach every device where Settings → Homework reminders is on,
   as a push notification (edge function `push`, sent by a pg_cron job that checks every minute).
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
  whenText(ms){
    const d = new Date(ms), t = new Date(); t.setHours(0, 0, 0, 0);
    const n = Math.round((new Date(d).setHours(0, 0, 0, 0) - t) / 86400000);
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const dd = n === 0 ? 'today' : n === 1 ? 'tomorrow' : d.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short'}).replace(',', '');
    return dd + ', ' + hm;
  },
  // reminder time from the dialog (null = none)
  remindAt(){
    const w = $('hwWhen').value, due = this.day($('hwDue').value);
    if(w === 'none') return null;
    if(w === 'pick'){ const v = $('hwPick').value; const t = v ? new Date(v).getTime() : NaN; return isFinite(t) ? t : null; }
    if(!due) return null;
    const d = new Date(due);
    if(w === 'eve'){ d.setDate(d.getDate() - 1); d.setHours(18, 0, 0, 0); } else d.setHours(7, 0, 0, 0);
    return d.getTime();
  },
  // the first reminder choice that is still ahead
  pickWhen(){
    const sel = $('hwWhen');
    for(const w of ['eve', 'morn']){ sel.value = w; const t = this.remindAt(); if(t && t > Date.now() + 60000) return; }
    sel.value = 'none';
  },
  remInfo(){
    const el = $('hwRemInfo'), t = this.remindAt(), w = $('hwWhen').value;
    $('hwPickWrap').hidden = w !== 'pick';
    el.classList.remove('warn');
    if(w === 'none'){ el.textContent = 'No reminder.'; return; }
    if(!t){ el.textContent = w === 'pick' ? 'Pick a day and time.' : 'Pick a due date first.'; return; }
    if(t <= Date.now() + 60000){ el.textContent = 'That time has already passed: pick another one, or no reminder.'; el.classList.add('warn'); return; }
    el.textContent = 'Reminder ' + this.whenText(t) + '. ' + (this.pushOn() ? 'It comes to the devices where Homework reminders are on.' : 'It goes to devices where Settings → Homework reminders is on (turn it on on your phone).');
  },
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
    $('hwPick').value = '';
    this.pickWhen(); this.remInfo();
    showModal('hwDlg');
  },
  // u = a picture made here (revoked when replaced); null clears it
  setImg(u){ if(this.imgUrl) URL.revokeObjectURL(this.imgUrl); this.imgUrl = u; if(u) $('hwImg').src = u; else $('hwImg').removeAttribute('src'); },
  async save(){
    const remind = this.remindAt(), w = $('hwWhen').value;
    if(w !== 'none' && (!remind || remind <= Date.now() + 60000)){ this.remInfo(); toast('Pick a reminder time that is still ahead, or No reminder'); return; }
    const text = $('hwText').value.trim().slice(0, 500), due = $('hwDue').value || '';
    const patch = {text, due, remind: w === 'none' ? null : Math.round(remind), when: w};
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
      const rem = !x.done && x.remind && x.remind > Date.now() ? 'Reminder ' + this.whenText(x.remind) : '';
      const pg = x.page && getDoc(x.page);
      const sub = [rem, pg ? (pg.data.title || 'Untitled page') : ''].filter(Boolean).join(' · ');
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
    $('hwvInfo').textContent = [x.done ? 'Done' : (x.remind ? (x.remind > Date.now() ? 'Reminder ' : 'Reminded ') + this.whenText(x.remind) : 'No reminder'), pg ? 'On ' + (pg.data.title || 'Untitled page') : (x.page ? 'The page was deleted' : '')].filter(Boolean).join(' · ');
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
    const w = x.when || (x.remind ? 'pick' : 'none');
    $('hwWhen').value = w;
    if(x.remind){ const d = new Date(x.remind); $('hwPick').value = this.ymd(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
    else $('hwPick').value = '';
    if(x.remind && x.remind <= Date.now() + 60000) this.pickWhen();
    this.setImg(null);
    this.remInfo();
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
  // a notification was tapped (?hw=<id> on start, or a message from the service worker)
  showSoon(id, tries){
    if(!id) return;
    tries = tries || 0;
    if(docs.get(id) && live(docs.get(id))){ this.view(id); return; }
    if(tries < 40) setTimeout(() => this.showSoon(id, tries + 1), 500);
    else this.openList();
  },

  // ---- reminders on this device (web push) ----
  ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  standalone(){ return navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches); },
  supported(){ return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
  pushOn(){ return !!LSget('inkwell.push', null) && this.supported() && Notification.permission === 'granted'; },
  dev(){ const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) || (this.ios && !/iPhone/.test(u)) ? 'iPad' : /Android/.test(u) ? 'Android' : 'Computer'; },
  async call(action, body){
    const {data} = await Sync.sb.auth.getSession(); const s = data && data.session;
    if(!s) throw Object.assign(new Error('Sign in first'), {code: 'not_signed_in'});
    let res;
    try {
      res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/push', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token, apikey: CFG.SUPABASE_ANON_KEY},
        body: JSON.stringify(Object.assign({action}, body || {}))
      });
    } catch { throw Object.assign(new Error('No connection'), {code: 'offline'}); }
    let j = {}; try { j = await res.json(); } catch {}
    if(res.status === 404 && !j.error) throw Object.assign(new Error('Reminders are not set up on the server yet'), {code: 'no_server'});
    if(!res.ok) throw Object.assign(new Error(j.message || j.error || 'Server error ' + res.status), {code: j.error || 'http_' + res.status, status: res.status});
    return j;
  },
  key(s){ s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while(s.length % 4) s += '='; const b = atob(s), o = new Uint8Array(b.length); for(let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; },
  busy: false,
  async turnOn(){
    if(this.busy) return;
    if(!Sync.user){ toast('Sign in first (Settings → Sign in with Google)'); return; }
    if(!this.supported()){ this.renderPush(); return; }
    this.busy = true; this.pushMsg('Turning on…');
    try {
      // asked first, straight from the tap (iOS only asks from a tap)
      const perm = await Notification.requestPermission();
      if(perm !== 'granted'){ this.pushMsg(perm === 'denied' ? 'Notifications are blocked for Inkwell. Allow them in the device settings (Settings → Notifications → Inkwell), then try again.' : 'Notifications were not allowed.'); return; }
      const reg = await navigator.serviceWorker.ready;
      const {pub} = await this.call('key');
      let sub = await reg.pushManager.getSubscription();
      if(sub && LSget('inkwell.pushKey', '') !== pub){ try { await sub.unsubscribe(); } catch {} sub = null; }
      if(!sub) sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: this.key(pub)});
      const j = sub.toJSON();
      await this.call('sub', {sub: {endpoint: j.endpoint, keys: j.keys}, dev: this.dev()});
      LSset('inkwell.push', j.endpoint); LSset('inkwell.pushKey', pub);
      this.pushMsg('');
      toast('Homework reminders are on for this ' + this.dev());
      this.call('test', {endpoint: j.endpoint}).catch(() => {});
    } catch(e){
      console.warn('push on', e);
      this.pushMsg(e.code === 'no_server' ? 'Reminders are not set up on the server yet.' : e.code === 'offline' ? 'No connection. Try again when online.' : 'Could not turn reminders on: ' + (e.message || e));
    } finally { this.busy = false; this.renderPush(); }
  },
  async turnOff(){
    const ep = LSget('inkwell.push', null);
    LSset('inkwell.push', null);
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if(sub) await sub.unsubscribe(); } catch {}
    if(ep && Sync.user) this.call('unsub', {endpoint: ep}).catch(() => {});
    toast('Homework reminders are off for this device');
    this.renderPush();
  },
  async test(){
    const ep = LSget('inkwell.push', null); if(!ep) return;
    try { const j = await this.call('test', {endpoint: ep}); toast(j.status >= 200 && j.status < 300 ? 'Test sent: it should show up in a few seconds' : 'The test did not go through (' + j.status + '). Turn reminders off and on again.'); }
    catch(e){ toast(e.code === 'not_subscribed' ? 'This device is not on the list any more: turn reminders off and on again' : 'Could not send the test: ' + (e.message || e)); }
  },
  pushMsg(t){ this.msg = t; const el = $('pushInfo'); if(el && t) el.textContent = t; },
  renderPush(){
    const box = $('pushBox'); if(!box) return;
    box.hidden = !Sync.user;
    if(!Sync.user) return;
    const on = this.pushOn(), btn = $('pushBtn');
    btn.textContent = on ? 'Turn off' : 'Turn on';
    btn.disabled = false;
    $('pushTest').hidden = !on;
    let info;
    if(this.msg) info = this.msg;
    else if(!this.supported()) info = this.ios && !this.standalone() ? 'To get reminders on this ' + this.dev() + ': in Safari tap Share → Add to Home Screen, open Inkwell from the Home Screen, sign in, then turn this on there.' : 'This browser cannot show reminders.';
    else if(on) info = 'Reminders for your homework show up on this ' + this.dev() + ' as notifications, also when Inkwell is closed.';
    else info = 'Get a notification on this device when homework is due. Turn it on on your phone to get reminders there.';
    if(!this.supported()) btn.disabled = true;
    $('pushInfo').textContent = info;
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
$('hwWhen').addEventListener('change', () => {
  if($('hwWhen').value === 'pick' && !$('hwPick').value){
    const t = HWK.remindAt() || Date.now() + 3600000, d = new Date(t);
    const base = $('hwDue').value ? HWK.day($('hwDue').value) : new Date();
    base.setDate(base.getDate() - 1); base.setHours(18, 0, 0, 0);
    const p = base.getTime() > Date.now() ? base : d;
    $('hwPick').value = HWK.ymd(p) + 'T' + String(p.getHours()).padStart(2, '0') + ':' + String(p.getMinutes()).padStart(2, '0');
  }
  HWK.remInfo();
});
$('hwDue').addEventListener('change', () => HWK.remInfo());
$('hwPick').addEventListener('input', () => HWK.remInfo());
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
$('pushBtn').addEventListener('click', () => { HWK.msg = ''; HWK.pushOn() ? HWK.turnOff() : HWK.turnOn(); });
$('pushTest').addEventListener('click', () => HWK.test());
if('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if(e.data && e.data.hw !== undefined){ if(e.data.hw) HWK.showSoon(e.data.hw); else HWK.openList(); } });
(() => {
  const q = new URLSearchParams(location.search), id = q.get('hw');
  if(q.has('hw')){
    q.delete('hw');
    try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); } catch {}
    setTimeout(() => id ? HWK.showSoon(id) : HWK.openList(), 1200);
  }
})();
setInterval(() => HWK.count(), 30000);
document.addEventListener('visibilitychange', () => { if(!document.hidden) HWK.count(); });
setTimeout(() => HWK.count(), 1500);
