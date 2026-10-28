/* Inkwell app, part 9 of 13: Settings, backups, page edge.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
/* =====================================================================
   Settings: sign in, backup, restore
   ===================================================================== */
$('status').addEventListener('click', openSettings);
$('settingsBtn').addEventListener('click', openSettings);
function openSettings(){ Clean.plan = null; $('cleanBtn').textContent = 'Free up space'; $('cleanBtn').classList.remove('danger'); $('cleanBtn').disabled = false; $('cleanInfo').textContent = 'Images nothing uses any more'; renderSettings(); showModal('settingsDlg'); updTrashInfo(true); DbSize.render(); DbSize.get().then(() => DbSize.render()).catch(() => {}); }
async function renderSettings(){
  renderPrefSettings(); updTrashInfo(); renderVersion();
  const ready = !!Sync.sb;
  $('setNoConfig').hidden = ready;
  if(authView === 'newpass' && !Sync.user) authView = 'signin';
  if(authView === 'reset' && Sync.user) authView = 'signin';
  const view = !ready ? '' : authView === 'newpass' ? 'newpass' : Sync.user ? 'in' : authView === 'reset' ? 'reset' : 'signin';
  $('authForm').hidden = view !== 'signin';
  $('resetForm').hidden = view !== 'reset';
  $('newPassForm').hidden = view !== 'newpass';
  $('signedIn').hidden = view !== 'in';
  if(view === 'newpass'){
    const email = Sync.user.email || '';
    $('newPassUser').value = email;
    $('newPassHint').textContent = recovering() ? `Choose a new password for ${email || 'your account'}. You are signed in.` : `Choose a new password for ${email || 'your account'}.`;
    $('newPassCancel').textContent = recovering() ? 'Not now' : 'Cancel';
  }
  if(!ready && Sync.configured()) $('setNoConfig').querySelector('p').textContent = Sync.msg ? 'Sync could not start: ' + Sync.msg + '.' : 'Starting sync…';
  if(Sync.user){
    $('whoami').textContent = Sync.user.email || 'your account';
    renderSyncInfo();
    Files.on(true).then(() => { renderSyncInfo(); renderCloud(); }).catch(() => {});
  }
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    $('storageInfo').textContent = est && est.usage != null ? `Using ${(est.usage / 1048576).toFixed(1)} MB on this device` : '';
  } catch {}
}
/* ---------- Cloud storage meter and Clean up (1.27) ----------
   One shared cloud total (R2, kept under the free 10 GB by the files function). The bar shows everyone's use
   (light) and yours (dark); orange from 80 %, red when full. Clean up lists pages by the size of their pictures. */
const fmtMB = mb => mb >= 1000 ? (mb / 1024).toFixed(1) + ' GB' : mb > 0 && mb < 1 ? 'under 1 MB' : Math.round(mb) + ' MB';
function renderGD(){
  const i = Files.info, box = $('gdBox');
  if(!i || !i.r2 || !i.google_client_id){ box.hidden = true; return; }
  box.hidden = false;
  const g = i.gdrive, ok = !!(g && !g.broken);
  $('gdConnect').hidden = ok;
  $('gdConnect').textContent = g && g.broken ? 'Connect again' : 'Connect Google Drive';
  $('gdToggle').hidden = true; $('gdMove').hidden = true;
  $('gdWhy').hidden = ok;
  if(GD.moving) return;
  const ns = GD.notesState(), nt = ns.saved && ns.uid === (Sync.user && Sync.user.id) ? new Date(ns.saved) : null;
  const when = nt ? (nt.toDateString() === new Date().toDateString() ? pad2(nt.getHours()) + ':' + pad2(nt.getMinutes()) : nt.toLocaleDateString()) : '';
  const wait = Files.full && Files.localOnly ? ` · ${Files.localOnly} new picture${Files.localOnly === 1 ? '' : 's'} waiting on this device` : '';
  $('gdState').textContent = !g ? 'Not connected' + wait : g.broken ? 'The Google sign-in has expired. New pictures wait on this device until you connect again.' + wait
    : `${g.email || 'Connected'} · pictures ${fmtMB(g.mb || 0)} · notes copied ${when ? 'at ' + when : 'shortly'}` + (i.used_mb > 0.05 ? ` · ${fmtMB(i.used_mb)} of older pictures still to move` : '') + checkText() + wait;
  function checkText(){
    const c = LSget('inkwell.gdCheck', null);
    if(!c || c.uid !== (Sync.user && Sync.user.id)) return '';
    return !c.folder_ok ? ' · the Drive folder is missing!' : c.missing ? ` · ${c.missing} picture${c.missing === 1 ? '' : 's'} missing in Drive` : ` · all ${c.total} pictures checked`;
  }
}
/* (1.64) How full the notes server is (Supabase free plan: 500 MB). Asks the database function db_size
   (supabase/migrations/20261026_db_size.sql) at most once an hour; a server without it shows nothing (no error).
   Settings shows "Notes server: x of 500 MB"; from 80 % a reminder (at most once a day) says it is nearly full. */
const DB_CAP_MB = 500, DB_WARN = 0.8;
const DbSize = {
  mb: null, at: 0, missing: false, busy: false,
  async get(force){
    if(!Sync.sb || !Sync.user || this.missing || this.busy) return this.mb;
    if(!force && this.mb !== null && Date.now() - this.at < 3600000) return this.mb;
    this.busy = true;
    try {
      const {data, error, status} = await Sync.sb.rpc('db_size');
      if(error){
        if(error.code === 'PGRST202' || status === 404 || /Could not find the function/i.test(String(error.message || ''))) this.missing = true;
        else console.warn('db size', error);
      } else if(Number(data) > 0){ this.mb = Number(data) / 1048576; this.at = Date.now(); }
    } catch(e){ console.warn('db size', e); }
    finally { this.busy = false; }
    return this.mb;
  },
  share(){ return this.mb === null ? null : this.mb / DB_CAP_MB; },
  render(){
    const row = $('dbRow'), sh = this.share();
    if(sh === null || !Sync.user){ row.hidden = true; return; }
    row.hidden = false;
    const bar = $('dbBar');
    $('dbUsed').style.width = (Math.min(1, sh) * 100).toFixed(1) + '%';
    bar.classList.toggle('near', sh >= DB_WARN && sh < 0.95); bar.classList.toggle('full', sh >= 0.95);
    bar.setAttribute('aria-valuenow', Math.round(sh * 100));
    $('dbInfo').textContent = `Notes server: ${fmtMB(this.mb)} of ${fmtMB(DB_CAP_MB)}` +
      (sh >= 0.95 ? ' · almost full: soon new changes may stop syncing' : sh >= DB_WARN ? ' · nearly full' : '');
  },
  // after a sync: refresh (hourly) and remind once a day from 80 %
  async check(){
    const mb = await this.get();
    if(!$('settingsDlg').hidden) this.render();
    const sh = this.share();
    if(sh === null || sh < DB_WARN) return;
    const day = new Date().toDateString();
    if(LSget('inkwell.dbWarn', '') === day) return;
    LSset('inkwell.dbWarn', day);
    toast(`The notes server is ${Math.round(sh * 100)} % full (${fmtMB(mb)} of ${fmtMB(DB_CAP_MB)}). Page history can be trimmed to free space.`);
  }
};
function renderCloud(){
  const i = Files.info, row = $('cloudRow');
  renderGD();
  const cu = $('cleanupBtn');
  if(i && i.google_client_id){ if(cu.parentNode !== $('gdBox').querySelector('.gd-btns')) $('gdBox').querySelector('.gd-btns').insertBefore(cu, $('gdMove')); }
  else if(cu.parentNode !== row) row.appendChild(cu);   // server without Google: the old storage bar keeps its Clean up
  if(!i || !i.r2 || !i.cap_mb || i.google_client_id){ row.hidden = true; return; }   // 1.34: no shared storage bar
  row.hidden = false;
  const sh = Files.share(), mine = Math.min(1, (i.used_mb || 0) / i.cap_mb), full = sh >= 0.995 || !!(Files.full && Files.full.code === 'cloud_full');
  $('cloudAll').style.width = (sh * 100).toFixed(1) + '%';
  $('cloudMine').style.width = (mine * 100).toFixed(1) + '%';
  const bar = $('cloudBar');
  bar.classList.toggle('near', !full && sh >= 0.8); bar.classList.toggle('full', full);
  bar.setAttribute('aria-valuenow', Math.round(sh * 100));
  $('cloudInfo').textContent = `You ${fmtMB(i.used_mb || 0)} · everyone ${fmtMB(i.total_mb || 0)} of ${fmtMB(i.cap_mb)}` +
    (full ? ' · full: new pictures stay on this device' : sh >= 0.8 ? ' · nearly full' : '');
}
$('gdConnect').addEventListener('click', () => GD.connect());
$('gLogin').addEventListener('click', () => GD.login());
$('gdToggle').addEventListener('click', () => { const g = Files.info && Files.info.gdrive; GD.setOn(!(g && g.on)).catch(e => toast(e.message || String(e))); });
$('gdMove').addEventListener('click', () => GD.move());
let cuSort = 'big', cuRows = [];
$('cleanupBtn').addEventListener('click', () => openCleanup());
async function openCleanup(){
  hideModal('settingsDlg');
  $('cuList').innerHTML = '<p class="hint">Counting…</p>'; $('cuInfo').textContent = '';
  showModal('cleanupDlg');
  try {
    await flushSaves();
    const sizes = new Map();
    for(const a of await IDB.all('assets')) if(a && a.id && a.blob) sizes.set(a.id, a.blob.size);
    if(await Files.on()){ const {files} = await Files.call('list'); for(const f of files || []) sizes.set(f.id, +f.bytes || sizes.get(f.id) || 0); }
    const rows = [];
    for(const d of await IDB.all('docs')){
      if(d.kind !== 'content' || d.deleted || !d.data) continue;
      const page = getDoc(d.id.slice(2)); if(!page) continue;
      const ids = new Set();
      for(const it of d.data.items || []) if(it && typeof it.a === 'string') ids.add(it.a);
      let bytes = 0; for(const id of ids) bytes += sizes.get(id) || 0;
      if(!bytes) continue;
      rows.push({id: page.id, title: page.data.title || 'Untitled page', path: pathOf(page), bytes, n: ids.size, at: d.updated || 0});
    }
    cuRows = rows;
    const i = Files.info;
    $('cuInfo').textContent = (i && i.r2 ? `Cloud: everyone ${fmtMB(i.total_mb || 0)} of ${fmtMB(i.cap_mb)}. ` : '') +
      'Pages with pictures, imported PDFs and scans. Deleted pages go to Recently deleted first. The space comes back after you empty Recently deleted and tap Free up space in the settings. Nothing is deleted unless you choose it.';
    renderCleanup();
  } catch(e){ $('cuList').innerHTML = `<p class="hint">Could not count: ${esc(e.message || String(e))}</p>`; }
}
function renderCleanup(){
  for(const b of $('cuSort').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === cuSort);
  const rows = cuRows.slice().sort(cuSort === 'big' ? (a, b) => b.bytes - a.bytes : (a, b) => a.at - b.at);
  $('cuList').innerHTML = rows.length ? rows.map(r => `<label class="trash-item"><input type="checkbox" data-pid="${esc(r.id)}"><div class="ti-text"><div class="ti-name">${esc(r.title)}</div><div class="hint">${esc(r.path)} · ${r.n} picture${r.n === 1 ? '' : 's'} · last changed ${esc(fmtDate(r.at) || 'long ago')}</div></div><span class="cu-size">${fmtMB(r.bytes / 1048576)}</span></label>`).join('')
    : '<p class="hint">No pages with pictures.</p>';
  cuChanged();
}
function cuChanged(){
  const sel = [...$('cuList').querySelectorAll('input:checked')].map(x => x.dataset.pid);
  const mb = cuRows.filter(r => sel.includes(r.id)).reduce((a, r) => a + r.bytes, 0) / 1048576;
  $('cuSel').textContent = sel.length ? `${sel.length} page${sel.length === 1 ? '' : 's'}, about ${fmtMB(mb)}` : '';
  $('cuDelete').disabled = !sel.length;
}
$('cuSort').addEventListener('click', e => { const b = e.target.closest('button'); if(!b) return; cuSort = b.dataset.v; renderCleanup(); });
$('cuList').addEventListener('change', cuChanged);
$('cuDelete').addEventListener('click', async () => {
  const btn = $('cuDelete');
  if(!btn.classList.contains('armed')){ btn.classList.add('armed'); btn.textContent = 'Tap again to delete'; setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'Delete selected'; }, 4000); return; }
  btn.classList.remove('armed'); btn.textContent = 'Delete selected';
  const ids = [...$('cuList').querySelectorAll('input:checked')].map(x => x.dataset.pid);
  for(const id of ids){
    if(cur && cur.id === id){ await closeCurrent(); showEmpty(); }
    await removeDoc(id, 'page'); await removeDoc('c_' + id, 'content', id);
    localStorage.removeItem('inkwell.cam.' + id);
  }
  renderNav(); renderList(); updTrashInfo();
  cuRows = cuRows.filter(r => !ids.includes(r.id)); renderCleanup();
  toast(`Moved ${ids.length} page${ids.length === 1 ? '' : 's'} to Recently deleted. To get the space back: empty Recently deleted, then Free up space.`, 'Open', async () => { hideModal('cleanupDlg'); await purgeTrash(); await renderTrash(); showModal('trashDlg'); });
});

/* ---------- Free up space: images nothing uses any more ----------
   Used = referenced (key "a") by any page, template or chat, including Recently deleted, the open page and the
   current Claude chat, or still waiting to upload. Online copies younger than a day are kept, so an import that
   another device is still uploading is never touched. Nothing is removed before you confirm. */
const Clean = {plan: null};
async function cleanScan(){
  await flushSaves();
  if(Sync.user){
    await Sync.run();
    if(Sync.state !== 'synced') throw new Error('Sync first (' + (Sync.msg || 'not synced') + ')');
  }
  const used = new Set();
  // (1.67.3) assetRefs also counts "as", the list of all scans of a Claude question (1.52). Before, only the first
  // scan of such a question counted as used, so Free up space offered to delete the others from the chat history.
  const walk = v => assetRefs(v, used);
  for(const d of await IDB.all('docs')) if(d.kind !== 'ptxt' && d.data) walk(d.data);
  if(cur){ for(const it of cur.items.values()) walk(it); walk(cur.undo); walk(cur.redo); }   // Undo can still bring a deleted picture back
  walk(Ask.msgs); walk(Ask.view);
  for(const id of (await IDB.get('meta', 'pendingAssets')) || []) used.add(id);
  const local = (await IDB.all('assets')).filter(r => r && r.id && !used.has(r.id)).map(r => ({id: r.id, size: r.blob ? r.blob.size : 0}));
  const server = [];
  if(Sync.user){
    const dayAgo = Date.now() - 864e5;
    if(await Files.on(true)){
      const {files} = await Files.call('list');
      for(const f of files || []){
        if(!f || !f.id || used.has(f.id)) continue;
        const t = Date.parse(f.created_at || '');
        if(isFinite(t) && t < dayAgo) server.push({id: f.id, size: +f.bytes || 0, r2: true});
      }
    }
    for(let off = 0; off < 200000; off += 1000){
      const {data, error} = await Sync.sb.storage.from('assets').list(Sync.user.id, {limit: 1000, offset: off});
      if(error) throw error;
      for(const o of data || []){
        if(!o || !o.name || !/^a-/.test(o.name) || used.has(o.name)) continue;
        const t = Date.parse(o.created_at || o.updated_at || '');
        if(isFinite(t) && t < dayAgo) server.push({id: o.name, size: (o.metadata && +o.metadata.size) || 0});
      }
      if(!data || data.length < 1000) break;
    }
  }
  return {local, server};
}
const planSize = p => { const ids = new Set(p.local.concat(p.server).map(r => r.id)); return {n: ids.size, mb: p.local.concat(p.server).reduce((a, r) => a + r.size, 0) / 1048576}; };
async function cleanRun(plan){
  for(const r of plan.local){
    await IDB.del('assets', r.id);
    const u = assetURLs.get(r.id); if(u){ URL.revokeObjectURL(u); assetURLs.delete(r.id); }
  }
  const r2 = plan.server.filter(r => r.r2), sb = plan.server.filter(r => !r.r2);
  for(let i = 0; i < r2.length; i += 100) await Files.call('del', {ids: r2.slice(i, i + 100).map(r => r.id)});
  for(let i = 0; i < sb.length; i += 100){
    const {error} = await Sync.sb.storage.from('assets').remove(sb.slice(i, i + 100).map(r => Sync.user.id + '/' + r.id));
    if(error) throw error;
  }
  if(r2.length) Files.on(true).catch(() => {});
  // their searchable text goes too
  for(const id of new Set(plan.local.concat(plan.server).map(r => r.id))){ const d = docs.get('pt_' + id); if(d && live(d)) await removeDoc(d.id, 'ptxt', null, true); }
}
$('cleanBtn').addEventListener('click', async () => {
  const btn = $('cleanBtn'), info = $('cleanInfo');
  const done = () => { btn.disabled = false; btn.textContent = 'Free up space'; btn.classList.remove('danger'); };
  if(Clean.plan){
    const plan = Clean.plan, {n, mb} = planSize(plan); Clean.plan = null;
    btn.disabled = true; info.textContent = 'Removing…';
    try { await cleanRun(plan); info.textContent = `Removed ${n} unused image${n === 1 ? '' : 's'}, ${mb.toFixed(1)} MB freed.`; }
    catch(e){ console.warn('clean', e); info.textContent = 'Not everything could be removed: ' + (e.message || e); }
    done(); renderSettings(); return;
  }
  btn.disabled = true; info.textContent = 'Checking…';
  try {
    const plan = await cleanScan(), {n, mb} = planSize(plan);
    if(!n){ info.textContent = 'No unused images. Nothing to free.'; done(); return; }
    Clean.plan = plan;
    const lmb = plan.local.reduce((a, r) => a + r.size, 0) / 1048576, smb = plan.server.reduce((a, r) => a + r.size, 0) / 1048576;
    info.textContent = `${n} image${n === 1 ? '' : 's'} (${mb.toFixed(1)} MB) that no page, template, chat or Recently deleted item uses` + (Sync.user ? `: ${lmb.toFixed(1)} MB on this device, ${smb.toFixed(1)} MB online.` : '.') + ' Tap Remove to delete them for good.';
    btn.disabled = false; btn.textContent = 'Remove'; btn.classList.add('danger');
  } catch(e){ console.warn('clean scan', e); info.textContent = 'Could not check: ' + (e.message || e); done(); }
});

$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('authMsg'); msg.textContent = 'Signing in';
  await clearStaleSession();
  const {data, error} = await Sync.sb.auth.signInWithPassword({email: $('authEmail').value.trim(), password: $('authPass').value});
  if(!error && data && data.session) Sync.fresh = {s: data.session, at: Date.now(), tries: 0};
  msg.textContent = error ? (/Email not confirmed/i.test(error.message) ? 'Confirm your email first: open the link Supabase sent you, then sign in.' : /Invalid login/i.test(error.message) ? 'Wrong email or password.' : error.message) : '';
  if(!error){ $('authPass').value = ''; renderSettings(); }
});
$('authSignup').addEventListener('click', async () => {
  const msg = $('authMsg'), email = $('authEmail').value.trim(), pass = $('authPass').value;
  if(!email || pass.length < 6){ msg.textContent = 'Enter an email and a password with at least 6 characters.'; return; }
  msg.textContent = 'Creating account';
  const {data, error} = await Sync.sb.auth.signUp({email, password: pass});
  if(error){ msg.textContent = error.message; return; }
  msg.textContent = data.session ? '' : 'Account created. Open the confirmation email, then come back and sign in.';
  renderSettings();
});
function renderSyncInfo(){
  const el = $('syncInfo'); if(!el || !Sync.user) return;
  let t = (Sync.state === 'warn' ? Sync.msg : Sync.lastOk ? 'Last synced ' + hhmm(Sync.lastOk) : 'Not synced yet') + (Sync.liveOk ? ' · instant sync on' : ' · checks every 20 s');
  const i = Files.info;
  if(i && i.r2 && Files.migLeft) t += ` · moving ${Files.migLeft} older pictures to the new storage`;
  if(GD.moveLeft) t += ` · moving ${GD.moveLeft} pictures to your Google Drive`;
  if(Files.full && Files.localOnly) t += Files.full.code === 'need_drive' ? ` · ${Files.localOnly} new picture${Files.localOnly === 1 ? '' : 's'} waiting: connect Google Drive` : Files.full.code === 'gdrive_full' ? ` · Google Drive full: ${Files.localOnly} new picture${Files.localOnly === 1 ? ' is' : 's are'} on this device only` : ` · cloud full: ${Files.localOnly} new picture${Files.localOnly === 1 ? ' is' : 's are'} on this device only`;
  if(i && i.claude_usd != null && (i.claude_usd > 0 || i.claude_limit != null)) t += ` · Claude this month USD ${(+i.claude_usd).toFixed(2)}` + (i.claude_limit == null ? '' : ` of ${(+i.claude_limit).toFixed(2)}`);
  el.textContent = t;
}
$('signOut').addEventListener('click', async () => {
  Sync.unlisten();
  Sync.signingOut = true; Sync.fresh = null;
  try { await Sync.sb.auth.signOut(); } finally { Sync.signingOut = false; }
  Sync.user = null;
  // forget the account's server state (Drive access, storage info); the notes stay on this device (1.36)
  Files.info = null; Files.full = null; Files.infoAt = 0; GD.tok = null; GD.moveLeft = 0;
  setStatus(); renderSettings(); renderCloud();
});
// Before signing in: if an old session is still stored on this device, let its pending token renewal finish
// and remove it, so it cannot fail later and sign the new session out (seen on the iPad 2026-10-15).
async function clearStaleSession(){
  if(Sync.user) return;
  let raw = null; try { raw = localStorage.getItem('inkwell-auth'); } catch {}
  if(!raw) return;
  Sync.signingOut = true;
  try { await Sync.sb.auth.signOut({scope: 'local'}); } catch(e){ console.warn('clear old session', e); }
  finally { Sync.signingOut = false; }
  try { localStorage.removeItem('inkwell-auth'); } catch {}
}

/* Forgot / change password.
   The reset email links back to this page (if the address is allowed in Supabase Auth → URL Configuration);
   otherwise the link lands on the Supabase "Site URL". Either way the link, or the address it landed on,
   can be pasted into Inkwell, which finishes the sign-in itself. */
let authView = 'signin';   // signin | reset | newpass
function clearLinkErr(){ try { sessionStorage.removeItem('inkwell.linkerr'); } catch {} }
function recovering(){ try { return !!sessionStorage.getItem('inkwell.recovery'); } catch { return false; } }
function setRecovering(on){ try { on ? sessionStorage.setItem('inkwell.recovery', '1') : sessionStorage.removeItem('inkwell.recovery'); } catch {} }
function readAuthLink(){
  const h = new URLSearchParams(location.hash.replace(/^#/, '')), q = new URLSearchParams(location.search);
  const out = {recovery: h.get('type') === 'recovery' && !!h.get('access_token'), error: h.get('error_code') || h.get('error_description') || q.get('error_code') || ''};
  if(out.recovery) setRecovering(true);
  // an expired/used link: remember it briefly, the first visit in a fresh Safari reloads once for the offline cache
  try {
    if(out.error) sessionStorage.setItem('inkwell.linkerr', JSON.stringify({c: out.error, at: Date.now()}));
    else { const le = JSON.parse(sessionStorage.getItem('inkwell.linkerr') || 'null'); if(le && Date.now() - le.at < 60000) out.error = le.c; }
  } catch {}
  if(out.error && !out.recovery) history.replaceState(null, '', location.pathname + location.search.replace(/([?&])(error|error_code|error_description)=[^&]*/g, '$1').replace(/[?&]+$/, ''));
  return out;
}
function linkErrorText(code){
  return /expired|otp_expired|invalid|access_denied/i.test(code) ? 'This link has expired or was already used. Send a new one.' : 'The link did not work (' + code + '). Send a new one.';
}
function startRecovery(){
  setRecovering(true);
  authView = 'newpass';
  setTimeout(() => { openSettings(); $('newPassMsg').textContent = ''; $('newPass').value = ''; }, 300);
}
$('authForgot').addEventListener('click', () => {
  authView = 'reset';
  $('resetEmail').value = $('authEmail').value.trim();
  $('resetMsg').textContent = ''; $('resetLinkMsg').textContent = ''; $('resetLink').value = '';
  $('resetPaste').hidden = true;
  renderSettings();
  if(!$('resetEmail').value) $('resetEmail').focus();
});
$('resetBack').addEventListener('click', () => {
  authView = 'signin'; clearLinkErr();
  if($('resetEmail').value.trim()) $('authEmail').value = $('resetEmail').value.trim();
  renderSettings();
});
$('resetForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('resetMsg'), email = $('resetEmail').value.trim();
  if(!/^\S+@\S+\.\S+$/.test(email)){ msg.textContent = 'Enter the email address of your account.'; return; }
  if(!navigator.onLine){ msg.textContent = 'You are offline. Connect to the internet and try again.'; return; }
  $('resetSend').disabled = true; msg.textContent = 'Sending'; clearLinkErr();
  const {error} = await Sync.sb.auth.resetPasswordForEmail(email, {redirectTo: new URL('./', location.href).href});
  $('resetSend').disabled = false;
  if(error){
    msg.textContent = /rate limit|too many|security purposes/i.test(error.message) ? 'Too many emails were sent. Wait a while (up to an hour), then try again.' : error.message;
    return;
  }
  msg.textContent = `If ${email} has an Inkwell account, an email with a link is on its way. It can take a few minutes; check spam too.`;
  $('resetPaste').hidden = false;
});
$('resetUse').addEventListener('click', () => useResetLink($('resetLink').value));
$('resetLink').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); useResetLink($('resetLink').value); } });
async function useResetLink(text){
  const msg = $('resetLinkMsg');
  text = (text || '').trim();
  let r;
  if(text) await clearStaleSession();
  try {
    if(/^\d{6,10}$/.test(text)){
      r = await Sync.sb.auth.verifyOtp({email: $('resetEmail').value.trim(), token: text, type: 'recovery'});
    } else {
      let u; try { u = new URL(text); } catch { msg.textContent = 'That is not a link. Copy the whole link from the email and paste it here.'; return; }
      const h = new URLSearchParams(u.hash.replace(/^#/, '')), q = u.searchParams;
      const err = h.get('error_code') || h.get('error_description') || q.get('error_code') || q.get('error_description');
      if(h.get('access_token') && h.get('refresh_token')){
        msg.textContent = 'Checking the link';
        r = await Sync.sb.auth.setSession({access_token: h.get('access_token'), refresh_token: h.get('refresh_token')});
      } else if(err){ msg.textContent = linkErrorText(err); return; }
      else if((q.get('token') || q.get('token_hash')) && (q.get('type') || 'recovery') === 'recovery'){
        msg.textContent = 'Checking the link';
        r = await Sync.sb.auth.verifyOtp({token_hash: q.get('token_hash') || q.get('token'), type: 'recovery'});
      } else { msg.textContent = 'This does not look like the password link. Copy the link from the Inkwell email and paste it here.'; return; }
    }
  } catch(e){ r = {error: e}; }
  if(r.error || !(r.data && r.data.session)){
    const m = r.error && r.error.message || '';
    msg.textContent = /expired|invalid|not found|used/i.test(m) || !m ? 'This link has expired or was already used. Send a new one.' : /fetch|network/i.test(m) ? 'You are offline. Connect to the internet and try again.' : m;
    return;
  }
  Sync.user = r.data.session.user;
  Sync.fresh = {s: r.data.session, at: Date.now(), tries: 0};
  $('resetLink').value = ''; msg.textContent = '';
  setRecovering(true);
  authView = 'newpass';
  setStatus(); renderSettings(); Sync.run();
  $('newPassMsg').textContent = ''; $('newPass').value = '';
}
$('changePass').addEventListener('click', () => {
  authView = 'newpass'; setRecovering(false);
  $('newPassMsg').textContent = ''; $('newPass').value = '';
  renderSettings();
  $('newPass').focus();
});
$('newPassCancel').addEventListener('click', () => { authView = 'signin'; setRecovering(false); renderSettings(); });
$('newPassForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('newPassMsg'), pass = $('newPass').value;
  if(pass.length < 6){ msg.textContent = 'Use at least 6 characters.'; return; }
  if(!navigator.onLine){ msg.textContent = 'You are offline. Connect to the internet and try again.'; return; }
  msg.textContent = 'Saving';
  const {error} = await Sync.sb.auth.updateUser({password: pass});
  if(error){
    const m = error.message || '';
    msg.textContent = /different from the old|same.*password/i.test(m) ? 'That is your current password. Choose a different one.'
      : /weak|short|characters/i.test(m) ? 'This password is too weak. ' + m
      : /reauth|recent|nonce/i.test(m) ? 'For safety, sign out, use "Forgot password?" and change it from the email link.'
      : /session|jwt|expired/i.test(m) ? 'Your sign-in expired. Use "Forgot password?" again.' : m;
    return;
  }
  $('newPass').value = '';
  setRecovering(false); authView = 'signin';
  renderSettings();
  toast('Password changed. Use the new password on your other devices.');
});
$('syncNow').addEventListener('click', async () => { $('syncInfo').textContent = 'Syncing'; await Sync.run(); renderSettings(); });

/* Settings: theme and shape straightening (per device) */
function renderPrefSettings(){
  $('setTheme').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === (prefs.theme || 'auto')));
  const hold = +prefs.snapHold || 0;
  $('setHold').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === hold));
  $('setLeft').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === (prefs.leftEdge ? 1 : 0)));
  { const cur = Math.round(cam.z * 100), m = Math.round(zMax() * 100), lim = zMax() < Z_TOP;
    $('setZoomCur').textContent = 'Use current zoom (' + cur + '%)';
    $('setZoom').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === (lim ? 'cur' : 'none')));
    $('setZoomHint').textContent = lim ? 'You can zoom in up to ' + m + '%. Zoom to another level and tap Use current zoom to change it.' : 'You can zoom in up to 800%. Zoom in as far as you want, then come here and tap Use current zoom.'; }
  $('setLeftHint').textContent = prefs.leftEdge ? 'Pages stop at the left edge and only grow up, down and to the right.' : 'Pages go on forever in every direction.';
  $('setModel').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === (prefs.askModel || 'auto')));
  $('setHw').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === hwMode()));
  renderHwStatus();
  $('setWheel').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === (prefs.wheel || 'right')));
  $('setWheelHint').textContent = prefs.wheel === 'off' ? 'Holding the Pencil still does nothing special.' : `Press the Pencil on the page and hold it still to open a quick menu for tools, colours and thickness. It opens as a half circle around the Pencil tip, ${prefs.wheel === 'left' ? 'to the right' : 'to the left'}, away from your hand. Slide towards an option and lift, or tap it. The eraser picked here erases once, then you are back to your pen.`;
  $('setModelHint').textContent = {auto: 'A quick check picks the cheap model for easy questions and the smart one for worksheets, handwriting and calculations.', fast: 'Always Haiku: cheapest and fastest, weaker at handwriting and long calculations.', smart: 'Always Sonnet: best answers, about 20 times the price of Haiku.'}[prefs.askModel || 'auto'];
  $('setHoldHint').textContent = hold ? `Hold the pen still for ${(hold / 1000).toFixed(2).replace(/0$/, '')} s at the end of a stroke to turn it into a straight line or shape.` : 'Strokes are never straightened.';
}
$('setTheme').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if(!b) return;
  prefs.theme = b.dataset.v; savePrefs(); setThemeAttr(); themeChanged(); renderPrefSettings();
});
$('setLeft').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if(!b) return;
  prefs.leftEdge = b.dataset.v === '1'; savePrefs(); renderPrefSettings(); invalidate();
});
$('setZoom').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if(!b) return;
  prefs.zMax = b.dataset.v === 'cur' ? clamp(Math.round(cam.z * 100) / 100, 0.5, Z_TOP) : Z_TOP;
  savePrefs(); renderPrefSettings();
  toast(b.dataset.v === 'cur' ? 'Max zoom set to ' + Math.round(zMax() * 100) + '%' : 'Max zoom back to 800%');
});
$('setModel').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if(!b) return;
  prefs.askModel = b.dataset.v; savePrefs(); renderPrefSettings();
});
$('setHw').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if(!b) return;
  prefs.hwSearch = b.dataset.v === 'docs' ? 'docs' : b.dataset.v === 'on'; savePrefs();
  HW.state = ''; PT.state = '';
  if(!HW.on()){ HW.queue.length = 0; clearTimeout(HW.timer); }
  if(!PT.on()){ PT.queue.length = 0; clearTimeout(PT.timer); }
  renderPrefSettings();
  HW.scanAll().catch(() => {}); PT.scanAll().catch(() => {});
});
$('setWheel').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if(!b) return;
  prefs.wheel = b.dataset.v; savePrefs(); renderPrefSettings();
});
$('setHold').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if(!b) return;
  prefs.snapHold = +b.dataset.v; savePrefs(); renderPrefSettings();
});
// (1.50) Shapes popover switch "Snap lines to angles" (prefs angleSnap; missing = on): the line tools of the
// Shapes menu (line, arrows, spring, dashed) click into 15° steps when drawn close to them; off = any angle.
// (1.51) renamed "Snap to angles": also turning a selection with the rotate handle (shapes, ink, pictures).
// 1.49 had this switch turn hold-to-straighten (snapHold) off by mistake: put that back once.
if(!prefs.v150){
  if(+prefs.snapHold === 0 && +prefs.snapHoldLast > 0) prefs.snapHold = +prefs.snapHoldLast;
  delete prefs.snapHoldLast; prefs.v150 = 1; savePrefs();
}
function renderSnapShapes(){ $('snapShapes').classList.toggle('on', prefs.angleSnap !== false); }
$('snapShapes').addEventListener('click', () => {
  prefs.angleSnap = prefs.angleSnap === false; savePrefs(); renderSnapShapes();
  toast(prefs.angleSnap ? 'Lines and turning snap to 0°, 15°, 45°, 90° …' : 'Angle snapping off: lines and turning go exactly where you drag');
});
renderSnapShapes();

/* Recently deleted */
const inTrash = d => !!(d && d.deleted && d.data && d.data._del);
async function trashGroups(){
  const all = await IDB.all('docs'), groups = new Map();
  for(const d of all){
    if(!inTrash(d)) continue;
    const g = d.data._del.g;
    if(!groups.has(g)) groups.set(g, {g, at: d.data._del.at, members: [], top: null});
    const gr = groups.get(g);
    gr.members.push(d);
    if(d.id === g) gr.top = d;
    gr.at = Math.max(gr.at, d.data._del.at);
  }
  return [...groups.values()];
}
async function purgeTrash(){
  const limit = Date.now() - TRASH_DAYS * 864e5;
  for(const gr of await trashGroups()) if(gr.at < limit) for(const d of gr.members) await removeDoc(d.id, d.kind, null, true);
}
function trashLabel(gr){
  const t = gr.top, d = t && t.data, any = id => docs.get(id);
  const nameOf = x => x && x.data ? (x.data.name || x.data.title || '') : '';
  if(!t) return {name: 'Deleted items', sub: gr.members.length + ' item' + (gr.members.length === 1 ? '' : 's')};
  const count = k => gr.members.filter(m => m.kind === k).length, pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  if(t.kind === 'page') { const sec = nameOf(any(d.sec)); return {name: d.title || 'Untitled page', sub: 'Page' + (sec ? ' in ' + sec : '')}; }
  if(t.kind === 'sec') return {name: d.name || 'Section', sub: 'Section, ' + pl(count('page'), 'page')};
  if(t.kind === 'nb') return {name: d.name || 'Notebook', sub: 'Notebook, ' + pl(count('sec'), 'section') + ', ' + pl(count('page'), 'page')};
  if(t.kind === 'tmpl') return {name: d.name || 'Template', sub: 'Template'};
  return {name: nameOf(t) || t.kind, sub: t.kind};
}
async function updTrashInfo(force){
  // (1.60.2) only while Settings is open: it reads every doc, and renderSettings runs after every sync
  if(!force && $('settingsDlg').hidden) return;
  const n = (await trashGroups()).length;
  $('trashInfo').textContent = 'Recently deleted' + (n ? ` (${n})` : '');
}
async function renderTrash(){
  const groups = (await trashGroups()).sort((a, b) => b.at - a.at), list = $('trashList');
  $('trashEmpty').disabled = !groups.length;
  if(!groups.length){ list.innerHTML = '<p class="hint">Nothing here. Things you delete from now on show up here.</p>'; return; }
  list.innerHTML = groups.map(gr => {
    const l = trashLabel(gr), when = new Date(gr.at).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'});
    return `<div class="trash-item" data-g="${esc(gr.g)}"><div class="ti-text"><div class="ti-name">${esc(l.name)}</div><div class="hint">${esc(l.sub)}, deleted ${esc(when)}</div></div>` +
      `<button class="btn ghost" data-act="restore">Restore</button><button class="btn danger" data-act="purge">Delete</button></div>`;
  }).join('');
}
async function undelete(d){
  const data = Object.assign({}, d.data); delete data._del;
  d.deleted = false; d.data = data;
  await writeDoc(d);
}
async function fallbackNb(){
  const nbs = notebooks(); if(nbs.length) return (getDoc(ui.nb) || nbs[0]).id;
  return (await newDoc('nb', {name: 'Restored', color: 0, order: 0})).id;
}
async function fallbackSec(){
  const nb = await fallbackNb(), secs = sectionsOf(nb);
  if(secs.length) return (getDoc(ui.sec) && getDoc(ui.sec).data.nb === nb ? getDoc(ui.sec) : secs[0]).id;
  return (await newDoc('sec', {nb, name: 'Restored', color: 0, order: 0})).id;
}
// Brings back everything deleted together with g. If its notebook/section is also deleted, that comes back too;
// if that is gone for good, it lands in the current notebook/section.
async function restoreGroup(g, depth = 0){
  const gr = (await trashGroups()).find(x => x.g === g); if(!gr) return '';
  for(const d of gr.members) await undelete(d);
  const top = docs.get(g);
  let note = '';
  if(top && top.kind === 'page' || top && top.kind === 'sec'){
    const pk = top.kind === 'page' ? 'sec' : 'nb', pid = top.data[pk], parent = docs.get(pid);
    if(!live(parent)){
      if(inTrash(parent) && depth < 3){ await restoreGroup(parent.data._del.g, depth + 1); note = top.kind === 'page' ? ' with its section' : ' with its notebook'; }
      if(!live(docs.get(pid))){ await patchDoc(top, {[pk]: pk === 'sec' ? await fallbackSec() : await fallbackNb()}); note = ' into ' + (pk === 'sec' ? 'the current section' : 'the current notebook'); }
    }
  }
  return note;
}
$('trashBtn').addEventListener('click', async () => { hideModal('settingsDlg'); await purgeTrash(); await renderTrash(); showModal('trashDlg'); });
$('trashBack').addEventListener('click', () => { hideModal('trashDlg'); openSettings(); });
$('trashList').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]'); if(!b) return;
  const row = b.closest('.trash-item'), g = row.dataset.g;
  if(b.dataset.act === 'purge'){
    if(!b.classList.contains('armed')){ b.classList.add('armed'); b.textContent = 'Tap again'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Delete'; }, 3500); return; }
    const gr = (await trashGroups()).find(x => x.g === g);
    if(gr) for(const d of gr.members) await removeDoc(d.id, d.kind, null, true);
    await renderTrash(); toast('Deleted for good');
    return;
  }
  b.disabled = true;
  const name = row.querySelector('.ti-name').textContent;
  const note = await restoreGroup(g);
  const top = docs.get(g);
  if(top && top.kind === 'page'){ const sec = getDoc(top.data.sec); ui.sec = top.data.sec; if(sec) ui.nb = sec.data.nb; saveUi(); }
  else if(top && top.kind === 'sec'){ ui.nb = top.data.nb; ui.sec = top.id; saveUi(); }
  else if(top && top.kind === 'nb'){ ui.nb = top.id; ui.sec = null; saveUi(); }
  ensureUi(); renderNav(); renderList(); renderTemplates();
  await renderTrash();
  toast(`Restored "${name}"${note}`);
});
$('trashEmpty').addEventListener('click', async () => {
  const b = $('trashEmpty');
  if(!b.classList.contains('armed')){ b.classList.add('armed'); b.textContent = 'Tap again to empty'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Empty'; }, 3500); return; }
  b.classList.remove('armed'); b.textContent = 'Empty';
  for(const gr of await trashGroups()) for(const d of gr.members) await removeDoc(d.id, d.kind, null, true);
  await renderTrash(); toast('Recently deleted emptied');
});

/* Version and updates */
let swReg = null;
async function appVersion(){
  const c = navigator.serviceWorker && navigator.serviceWorker.controller;
  if(!c) return '';
  return new Promise(res => {
    const ch = new MessageChannel(), t = setTimeout(() => res(''), 1500);
    ch.port1.onmessage = e => { clearTimeout(t); res(String(e.data || '')); };
    try { c.postMessage('version', [ch.port2]); } catch { clearTimeout(t); res(''); }
  });
}
async function renderVersion(){
  let v = await appVersion();
  // (1.58.5) the offline cache may not answer (just updated, or not running yet): use the newest change log entry
  if(!v){ try { v = CHANGELOG[0][0]; } catch {} }
  $('verInfo').textContent = 'Inkwell' + (v ? ' ' + v.replace(/^inkwell-/, '') : '');
}
/* (1.47) Change log: "See changes" next to the version in Settings. Newest first; add an entry with every release. */
const CHANGELOG = [
  ['1.69', '2026-10-28', ['Grid in Shapes: set the rows and columns, then drag a box on the page and it is split into that grid (tap for a standard size). It is ordinary ink, so you can move, recolour or erase single lines', 'Fix: Stick to text no longer paints a huge highlight when a picture or drawing is next to the text you mark', 'Fix: if the iPad loses the drawing of your ink while you move around the page, Inkwell notices and draws it again (your strokes were never deleted)', 'Fix: pages restored from Recently deleted on one device now reach your other devices (before, they were sent again every 20 seconds and refused)']],
  ['1.68', '2026-10-27', ['Ask Claude history: filter the chats by Page, Section or Notebook of the page you have open, or All. Each button shows how many chats it has; your choice is remembered']],
  ['1.67.4', '2026-10-27', ['Fix: graph formulas written together like sinx, xe^x or 2pix now work (they said "Unknown name")', 'Fix: PDFs are let go after importing, so Inkwell uses less memory on the iPad', 'Fix: To formula no longer puts the formula on another page if you switch pages while Claude reads', 'Fix: an imported picture stays on the page you imported it on, also if you open another page meanwhile', 'Fix: a picture that is not downloaded yet is no longer asked for again on every scroll', 'Fix: Fit everything on screen respects the Max zoom setting', 'Fix: PDF export and Word import no longer fail when tapped twice quickly or after being offline once']],
  ['1.67.3', '2026-10-27', ['Fix: pictures saved while others were uploading (a big import) could stay on this device only and never reach your other devices. Once a day Inkwell now finds such pictures and uploads them', 'Fix: one picture that fails to upload no longer holds up all the others', 'Fix: Free up space no longer offers to delete the 2nd to 4th scan of a Claude question', 'Fix: a Claude question that fails (no connection) keeps its text and pictures so you can send it again', 'Fix: with a window open (Settings, export …) the keyboard no longer deletes or changes things on the page behind it', 'Fix: Restore backup shows the restored copy of the page that is open', 'Fix: the "Starting is taking too long" box goes away by itself once Inkwell has started']],
  ['1.67.2', '2026-10-27', ['Fix: tapping a fill-in box of an imported worksheet no longer turns the formatting bar into a tall column over the page']],
  ['1.67.1', '2026-10-27', ['Security: imported PDFs and Word files can no longer run code inside Inkwell']],
  ['1.67', '2026-10-26', ['Ask Claude: upload photos and pictures (the picture button next to scan: camera, Photos or Files; on the PC also paste or drop). Up to 4 per question, together with scans']],
  ['1.66', '2026-10-26', ['Spell check is now Inkwell\'s own, the same on the iPad and the PC and also offline: pick the language with the Spelling button (Deutsch Schweiz/Deutschland, English UK/US, Português Portugal/Brasil); each text box keeps its language', 'Tap a word with a red line for fixes, or Add to dictionary', 'Export as PDF: choose Only some pages (e.g. 3 or 2-5, 8). Imported documents give one PDF page per imported page, with the same numbers']],
  ['1.65', '2026-10-26', ['The graph window remembers what you typed last (axis names, ranges, steps, function, numbers and grid), also after closing the app']],
  ['1.64.3', '2026-10-26', ['Fix: Inkwell now starts when the Wi-Fi is connected but the internet is not working (before it could stay empty, with Settings not opening)']],
  ['1.64.2', '2026-10-26', ['If Inkwell fails to start, it now shows what went wrong on screen (with a Reload button) instead of staying empty']],
  ['1.64.1', '2026-10-26', ['Behind the scenes: the biggest app file (writing tools) is split into four smaller ones. Nothing changes in how the app works']],
  ['1.64', '2026-10-26', ['Settings → Your notes shows how full the notes server is (of 500 MB), with a reminder once a day when it is over 80 % full']],
  ['1.63.1', '2026-10-26', ['Page history keeps the last 10 versions of each page (was 30), so your notes take less space on the server. Older versions go when the page gets a new one']],
  ['1.63', '2026-10-25', ['Select tool: new "Tap" choice next to Free and Box. Tap things to select them (Pencil or finger), tap more to add them, tap a selected one to drop it, tap empty space to clear', 'Tapping writing on an imported page now selects the writing, not the whole page']],
  ['1.62.1', '2026-10-25', ['Behind the scenes: the app is now split into 13 smaller files by area, with automatic checks that they load in the right order. Nothing changes in how the app works']],
  ['1.62', '2026-10-25', ['Highlighter works like a real one: black text and lines under a highlight stay black, only the paper takes the colour (on screen, when printing and in exported PDFs)']],
  ['1.61.3', '2026-10-25', ['Behind the scenes: part of the app moved into separate files with fast automatic checks, so future changes are safer. Nothing changes in how the app works']],
  ['1.61.2', '2026-10-25', ['Pencil: on curves the line drawn ahead of the tip now bends with the curve (in 1.61 it went straight on for a moment and then snapped back)']],
  ['1.61.1', '2026-10-25', ['Fix: scribbling with the highlighter (or the pen) back and forth no longer leaves white gaps and slits in the colour, on screen and in exported PDFs']],
  ['1.61', '2026-10-25', ['Pencil: the line keeps up with the tip better (drawn slightly ahead while you write fast in one direction; what is saved is exactly what you wrote)', 'Long strokes and drawings stay smooth while drawing (only the newest part is redrawn)', 'Word import, backups and formulas now also work offline the first time (before they needed to be used once online)']],
  ['1.60.2', '2026-10-25', ['Fix: a keyboard shortcut pressed right after Ctrl+V (cut, undo, delete) is no longer ignored', 'Fix: sync can no longer lose strokes when two devices upload the same page at the same moment (the server now refuses to overwrite a newer copy; the device merges and tries again)', 'Fix: a change that reached the server a moment late could be skipped by your other devices for good; it is now picked up', 'Fix: a stroke erased on another device no longer comes back', 'Faster, lighter sync: it no longer reads all your notes every 20 seconds, only what changed']],
  ['1.60.1', '2026-10-22', ['Stick to text: highlights now fit the letters on imported pages (measured on the page itself), sit centred on the line and cover whole words, also on big headings']],
  ['1.60', '2026-10-22', ['Highlighter: new "Stick to text" switch. Highlights snap onto the line of text under them (imported pages and typed text), straight and as tall as the text; drawn down across lines, each line gets marked', 'Without text under it, a level highlight becomes one straight band']],
  ['1.59.3', '2026-10-22', ['Fix: typed text and formulas no longer shift and fall apart when zooming (1.59.2 change undone)']],
  ['1.59.2', '2026-10-22', ['Fix: typed text, formulas and Claude answers stay sharp when zoomed in with the pen tool (they went blurry on the iPad)']],
  ['1.59.1', '2026-10-22', ['Fix: strokes no longer disappear a moment after writing when the same page is open on another device (the two devices kept sending the page back and forth, and an older copy could overwrite the newest strokes)']],
  ['1.59', '2026-10-22', ['Turn imported pages and pictures: select them and tap the turn button (90° each tap)', 'Import: turn all pages before placing them, for PDFs that were scanned sideways']],
  ['1.58.12', '2026-10-22', ['Write to text makes the same text box as typing there: with Snap text to lines on, the words sit on the answer line or in the table cell at the printed text size']],
  ['1.58.11', '2026-10-21', ['Fix: the empty strip at the bottom of the screen is gone, the page now reaches the bottom edge (iPad Home Screen app)']],
  ['1.58.10', '2026-10-21', ['Fix: a custom text colour is kept even if the text box closed while the colour picker was open']],
  ['1.58.9', '2026-10-21', ['Custom colour for text: pick any colour in the text colour menu, like for the pen']],
  ['1.58.8', '2026-10-21', ['Snap text to lines also finds pale grey answer lines on worksheets, and thin lines that got lost when a big page was read']],
  ['1.58.7', '2026-10-21', ['The text colour you pick stays for all your writing, also in new text boxes, until you pick another one', 'The line under the A shows the colour you are writing in']],
  ['1.58.6', '2026-10-21', ['Fix: picking a text colour with nothing selected now colours what you type next']],
  ['1.58.5', '2026-10-21', ['Fix: the version number next to Inkwell at the bottom of Settings is shown again']],
  ['1.58.4', '2026-10-21', ['Graph numbers sit centred under their mark on the horizontal axis and level with their mark beside the vertical axis, so it is clear which line each belongs to (graphs inserted from now on)']],
  ['1.58.3', '2026-10-21', ['Fix: imported pages no longer turn blocky when zoomed in past about 300 %. They are redrawn at the new size a moment after you stop zooming']],
  ['1.58.2', '2026-10-21', ['Cleaner What\'s new window that fits the iPad screen: the title stays at the top and the list scrolls below it', 'Fix: windows no longer run under the status bar or past the bottom of the screen']],
  ['1.58.1', '2026-10-21', ['Fix: the hand next to a text box moves it on the iPad, with a finger and with the Pencil']],
  ['1.58', '2026-10-21', ['Select a graph and tap Add formula to draw another function on it, in its own colour and line style, with the formula written next to the curve. Works on graphs made from now on']],
  ['1.57', '2026-10-21', ['Graphs get a solid background in the page colour, so their grid no longer mixes with the paper grid (white in light mode, dark in dark mode). Switch it off in the graph window under Look', 'Erasers no longer erase graphs, so you can rub out what you wrote on a graph. To remove a graph, select it with the Select tool and delete it']],
  ['1.56', '2026-10-21', ['The text bar also works in the PDF\'s own fill-in fields: Bold, Italic, Underline, text size and colour for the whole field, plus spell check']],
  ['1.55', '2026-10-21', ['The text formatting buttons now sit in the top tool bar when the Text tool is on, instead of floating over the text box', 'Spell check button in the text bar: misspelled words are underlined while you type (on by default)']],
  ['1.54', '2026-10-21', ['Text size dropdown in the text formatting bar: select words to resize them, or pick a size with nothing selected to resize the whole text box']],
  ['1.53.1', '2026-10-20', ['Fix: after copying page text, Copy as picture, or text from a text box, Paste put back an older Inkwell copy instead', 'Fix: Cmd+V on an iPad keyboard pastes']],
  ['1.53', '2026-10-20', ['Select tool: choose Free or Box. Box selects everything in a rectangle and can Copy as picture, like a screenshot of that part', 'Paste from other apps with Ctrl+V or the Paste button: pictures and screenshots become a picture, text a text box']],
  ['1.52', '2026-10-20', ['Select text on imported pages: draw a lasso around text on a PDF or scanned page, then Copy it, or open Text… to copy part of it or put it on the page as a text box', 'PDFs imported from now on remember where each line is, so you can select one column of a page', 'Scan several pages in a row: after Add & scan next, tap Take next photo; or Choose photos to pick several at once, check each one or Add all', 'Ask Claude: scan up to 4 parts of the page into one question (+ Scan more)']],
  ['1.51', '2026-10-20', ['The Shapes menu switch is now "Snap to angles" and also covers turning: with it off, shapes and other selections turn to any angle instead of clicking into 15° steps']],
  ['1.50.1', '2026-10-20', ['Fix: a finger that lands on the ruler\'s Snap button still helps move and turn the ruler']],
  ['1.50', '2026-10-20', ['The switch in the Shapes menu is now "Snap lines to angles": turn it off and lines and arrows no longer click into 0°, 15°, 45°, 90°', 'Snap button on the ruler: turn it off and the ruler turns to any angle instead of clicking into 15° steps', 'Fix: a setting changed right before closing the app (like the ruler position) could be forgotten', 'Holding the pen still to straighten a stroke works as before 1.49 again (Settings → Straighten shapes)']],
  ['1.49', '2026-10-20', ['Shapes menu has a "Snap strokes to shapes" switch: turn it off and straight lines and shapes you draw stay as drawn']],
  ['1.48.1', '2026-10-20', ['Fix: strokes could disappear right after writing (while a sync came in, while an update loaded, when iPadOS interrupted the Pencil, or when a small letter written slowly opened the Pencil menu)']],
  ['1.48', '2026-10-20', ['Tab in a text box moves the text forward to the next tab stop (Shift+Tab takes it back)']],
  ['1.47.1', '2026-10-20', ['See changes opens the change log in its own window']],
  ['1.47', '2026-10-20', ['Pencil ink follows smooth curves: fast writing no longer gets corners, and quick loops no longer shrink', 'Change log in Settings (this list)']],
  ['1.46', '2026-10-20', ['Word files are turned into a PDF through your Google Drive, so they look like in Word', 'Imports close the dialog right away and pages appear one by one while you keep writing; Stop button, one undo removes the whole import']],
  ['1.45', '2026-10-20', ['Hand grip next to a text box you are typing in, to move the box']],
  ['1.44.1', '2026-10-20', ['A finger tap with the Text or Formula tool places a box', 'Text pasted into table cells stays readable']],
  ['1.44', '2026-10-20', ['"Read handwriting & scans" has a Docs only choice']],
  ['1.43', '2026-10-20', ['Dotted answer lines work with text snapping', 'Text on imported pages starts at the size of the printed text']],
  ['1.42.2', '2026-10-20', ['Top bar no longer blurred by iPadOS 26']],
  ['1.42.1', '2026-10-19', ['Reference line sits at the bottom of the letters (dots on i no longer move it)']],
  ['1.42', '2026-10-19', ['Writing menu with Write to text and Reference line; ink is never moved any more']],
  ['1.41.1', '2026-10-19', ['Lasso no longer grabs the whole imported page']],
  ['1.41', '2026-10-19', ['Writing assist to try out (keep lines level, even word spacing)']],
  ['1.40', '2026-10-19', ['Fade slider for selected items', 'Graph look options: size, colours, line style, grid fade, arrow tips']],
  ['1.39', '2026-10-19', ['Compass in Shapes for circles and arcs']],
  ['1.38', '2026-10-19', ['Copy and paste with the select tool']],
  ['1.37', '2026-10-19', ['Max zoom setting']],
  ['1.36', '2026-10-18', ['Each Google account keeps its own notes on the device', 'Drive notes copy and daily check run reliably; many smaller fixes']],
  ['1.35', '2026-10-18', ['New server keys, daily Drive check, automatic tests']],
  ['1.34', '2026-10-18', ['Sign in with Google only; pictures are saved in your own Google Drive']],
  ['1.33', '2026-10-18', ['Copy of all notes in Google Drive']],
  ['1.32', '2026-10-18', ['Clearer Google Drive connect errors']],
  ['1.31', '2026-10-18', ['Privacy page']],
  ['1.30', '2026-10-18', ['Google Drive for pictures (optional)']],
  ['1.29', '2026-10-17', ['Typed text snaps into table cells of worksheets']],
  ['1.28', '2026-10-17', ['Storage bar, heads-up when nearly full, Clean up']],
  ['1.27', '2026-10-17', ['Page history, zip backups, upload when leaving the app, Claude spending cap']],
  ['1.26', '2026-10-17', ['Edits from two devices are merged', 'Bigger touch targets']],
  ['1.25', '2026-10-17', ['Setup guide for Import from OneNote']],
  ['1.24', '2026-10-16', ['Import from OneNote']],
  ['1.23', '2026-10-16', ['Drag to reorder notebooks, sections and pages']],
  ['1.22', '2026-10-16', ['Mark for later removed from the Pencil menu']],
  ['1.21', '2026-10-16', ['Eraser picked in the Pencil menu erases once']],
  ['1.20', '2026-10-16', ['Pencil menu is a half-moon wheel that opens away from your hand']],
  ['1.19', '2026-10-16', ['Pages Claude will not read are skipped']],
  ['1.18', '2026-10-16', ['Shape rotation and ruler fixes']],
  ['1.17', '2026-10-16', ['Claude panel steps aside while scanning']],
  ['1.16', '2026-10-16', ['Finer mouse-wheel zoom']],
  ['1.15', '2026-10-16', ['Erasers work on text boxes']],
  ['1.14', '2026-10-16', ['Calculator']],
  ['1.13', '2026-10-15', ['Tutor / Solve / Practice in one menu']],
  ['1.12', '2026-10-15', ['Free up space']],
  ['1.11', '2026-10-15', ['Instant sync between devices']],
  ['1.10', '2026-10-15', ['Export a page as one PDF file']],
  ['1.9', '2026-10-15', ['Practice from your notes']],
  ['1.8', '2026-10-15', ['Write to text']],
  ['1.7', '2026-10-15', ['Search inside imported PDFs and scans']],
  ['1.6', '2026-10-15', ['Sharp typed text when zoomed in']],
  ['1.5', '2026-10-15', ['Page slider only shows on a deliberate scroll']],
  ['1.4', '2026-10-15', ['Long pages export in parts']],
  ['1.3', '2026-10-15', ['Fix: correct password did not sign in on the iPad']],
  ['1.2', '2026-10-15', ['Forgot password and Change password']],
  ['1.1', '2026-10-15', ['Polish all over']],
  ['1.0', '2026-10-15', ['First numbered release: notebooks, Pencil ink, text, formulas, PDF import, sync, Ask Claude']]
];
function renderChangelog(){
  const day = d => new Date(d + 'T12:00:00').toLocaleDateString([], {day: 'numeric', month: 'short', year: 'numeric'});
  $('changelog').innerHTML = CHANGELOG.map(([v, d, items]) => `<section><h4>${esc(v)}<small>${esc(day(d))}</small></h4><ul>${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>`).join('');
}
// (1.47.1) the change log opens in its own window on top of Settings (it was cut off at the bottom of Settings)
$('logBtn').addEventListener('click', () => {
  if(!$('changelog').innerHTML) renderChangelog();
  $('logVer').textContent = $('verInfo').textContent;
  $('logDlg').hidden = false; modalAt = Date.now();
  $('changelog').scrollTop = 0;
});
$('updBtn').addEventListener('click', async () => {
  const b = $('updBtn');
  if(b.dataset.ready && swReg && swReg.waiting){ b.textContent = 'Updating'; b.disabled = true; swReg.waiting.postMessage('skipWaiting'); return; }
  if(!swReg){ toast('Updates only work in the installed app'); return; }
  if(!navigator.onLine){ toast('You are offline'); return; }
  b.disabled = true; b.textContent = 'Checking';
  try {
    await swReg.update();
    if(swReg.installing) await new Promise(res => { const w = swReg.installing; w.addEventListener('statechange', () => { if(w.state !== 'installing') res(); }); setTimeout(res, 20000); });
  } catch {}
  b.disabled = false;
  if(swReg.waiting){ b.dataset.ready = '1'; b.textContent = 'Install update'; }
  else { b.textContent = 'Check for update'; toast('You have the latest version'); }
});

function blobToDataURL(b){ return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); }); }
/* ---------- Backup (1.27): zip files in parts of up to BACKUP_PART_MB, with every picture, also the ones only online.
   Part 1 holds notes.json (all notes) plus pictures; the other parts hold pictures. Each part is saved with its own tap
   (iPad Safari only shares a file right after a tap). Pictures from the server are not kept on the device. ---------- */
const BACKUP_PART_MB = 80;
let backupPlan = null;
async function assetBlob(id){
  const a = await IDB.get('assets', id); if(a && a.blob) return a.blob;
  if(!Sync.sb || !Sync.user || !navigator.onLine) return null;
  if(await Files.on()){ try { const b = await Files.download(id); if(b) return b; } catch {} }
  const r = await Sync.sb.storage.from('assets').download(Sync.user.id + '/' + id);
  return r.error ? null : r.data;
}
async function backupScan(){
  await flushSaves();
  const docsAll = (await IDB.all('docs')).filter(d => !d.deleted && d.data).map(d => ({id: d.id, kind: d.kind, data: d.data, updated: d.updated}));
  const sizes = new Map();
  for(const a of await IDB.all('assets')) if(a && a.id) sizes.set(a.id, a.blob ? a.blob.size : 0);
  if(Sync.user && navigator.onLine){
    if(await Files.on()){ const {files} = await Files.call('list'); for(const f of files || []) if(!sizes.has(f.id)) sizes.set(f.id, +f.bytes || 0); }
    for(let off = 0; off < 200000; off += 1000){
      const {data, error} = await Sync.sb.storage.from('assets').list(Sync.user.id, {limit: 1000, offset: off});
      if(error) break;
      for(const o of data || []) if(o && /^a-/.test(o.name || '') && !sizes.has(o.name)) sizes.set(o.name, (o.metadata && +o.metadata.size) || 0);
      if(!data || data.length < 1000) break;
    }
  }
  const notesSize = JSON.stringify(docsAll).length;
  const parts = [{ids: [], size: notesSize}];
  for(const [id, size] of [...sizes].sort((a, b) => a[0] < b[0] ? -1 : 1)){
    let p = parts[parts.length - 1];
    if(p.ids.length && p.size + size > BACKUP_PART_MB * 1048576){ p = {ids: [], size: 0}; parts.push(p); }
    p.ids.push(id); p.size += size;
  }
  return {docs: docsAll, parts, total: [...sizes.values()].reduce((a, b) => a + b, 0) + notesSize, pics: sizes.size, at: new Date()};
}
function backupName(plan, i){
  const d = plan.at;
  return `inkwell-backup-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` + (plan.parts.length > 1 ? `-part${i + 1}of${plan.parts.length}` : '') + '.zip';
}
function renderBackup(){
  const plan = backupPlan, mb = x => (x / 1048576).toFixed(x < 10485760 ? 1 : 0);
  $('backupInfo').textContent = `${plan.docs.length} notes items and ${plan.pics} pictures, ${mb(plan.total)} MB in ${plan.parts.length} file${plan.parts.length === 1 ? '' : 's'}. Save ${plan.parts.length === 1 ? 'it' : 'each part'} (to Files or iCloud Drive, for example). To restore, choose all the parts together in Settings → Restore backup.`;
  $('backupParts').innerHTML = plan.parts.map((p, i) => `<button class="btn ghost${p.done ? ' done' : ''}" data-bpart="${i}">${p.done ? '✓ ' : ''}Save ${plan.parts.length === 1 ? 'backup' : 'part ' + (i + 1)} <span class="hint">${mb(p.size)} MB${i === 0 ? ', with all notes' : ''}</span></button>`).join('');
}
async function saveFile(file){
  if(navigator.canShare && navigator.canShare({files: [file]})){ try { await navigator.share({files: [file], title: file.name}); return true; } catch(e){ return e && e.name === 'AbortError' ? false : (dl(), true); } }
  return dl(), true;
  function dl(){ const u = URL.createObjectURL(file); const a = document.createElement('a'); a.href = u; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); }
}
$('backupBtn').addEventListener('click', async () => {
  const btn = $('backupBtn'); btn.disabled = true; btn.textContent = 'Preparing';
  try {
    backupPlan = await backupScan();
    hideModal('settingsDlg'); $('backupMsg').textContent = ''; renderBackup(); showModal('backupDlg');
  } catch(e){ toast('Backup failed: ' + (e.message || e)); }
  btn.disabled = false; btn.textContent = 'Download backup';
});
$('backupParts').addEventListener('click', async e => {
  const b = e.target.closest('[data-bpart]'); if(!b || !backupPlan || b.disabled) return;
  const i = +b.dataset.bpart, plan = backupPlan, part = plan.parts[i], msg = $('backupMsg');
  b.disabled = true;
  try {
    if(!window.JSZip) await loadScript('lib/docx/jszip.min.js');
    const zip = new JSZip(), missing = [];
    if(i === 0) zip.file('notes.json', JSON.stringify({app: 'Inkwell', version: 2, exported: plan.at.toISOString(), parts: plan.parts.length, docs: plan.docs}));
    for(let k = 0; k < part.ids.length; k++){
      msg.textContent = `Collecting pictures ${k + 1} of ${part.ids.length}…`;
      const id = part.ids[k], blob = await assetBlob(id);
      if(blob) zip.file('pictures/' + id, blob, {binary: true}); else missing.push(id);
    }
    msg.textContent = 'Packing…';
    const out = await zip.generateAsync({type: 'blob', compression: 'STORE'});
    const ok = await saveFile(new File([out], backupName(plan, i), {type: 'application/zip'}));
    if(ok){ part.done = true; renderBackup(); }
    msg.textContent = missing.length ? `${missing.length} picture${missing.length === 1 ? '' : 's'} could not be fetched (offline?). Try this part again later.` : (plan.parts.every(p => p.done) ? 'All parts saved.' : '');
  } catch(err){ msg.textContent = 'This part failed: ' + (err.message || err); }
  b.disabled = false;
});
{
  const rb = document.createElement('button');
  rb.className = 'btn ghost'; rb.id = 'restoreBtn'; rb.textContent = 'Restore backup';
  $('backupBtn').before(rb);
  rb.addEventListener('click', () => $('restoreFile').click());
}
$('restoreFile').addEventListener('change', async () => {
  const files = [...$('restoreFile').files]; if(!files.length) return;
  try {
    let docsIn = null; const pics = [];
    for(const f of files){
      if(/\.zip$/i.test(f.name) || f.type === 'application/zip'){
        if(!window.JSZip) await loadScript('lib/docx/jszip.min.js');
        const zip = await JSZip.loadAsync(f);
        const nj = zip.file('notes.json');
        if(nj){ const j = JSON.parse(await nj.async('string')); if(j && Array.isArray(j.docs)) docsIn = (docsIn || []).concat(j.docs); }
        zip.forEach((path, entry) => { const m = /^pictures\/(a-[A-Za-z0-9_-]+)$/.exec(path); if(m && !entry.dir) pics.push({id: m[1], get: () => entry.async('blob')}); });
      } else {
        const j = JSON.parse(await f.text());
        if(!j || !Array.isArray(j.docs)) throw new Error(f.name + ' is not an Inkwell backup');
        docsIn = (docsIn || []).concat(j.docs);
        for(const a of j.assets || []) pics.push({id: a.id, type: a.type, get: async () => (await fetch(a.data)).blob()});
      }
    }
    if(!docsIn && !pics.length) throw new Error('Not an Inkwell backup');
    let n = 0, p = 0, openHit = false;
    if(cur) await flushSaves();
    for(const d of docsIn || []){
      const local = await IDB.get('docs', d.id);
      if(local && local.updated >= d.updated && !local.deleted) continue;
      await IDB.put('docs', {id: d.id, kind: d.kind, data: d.data, deleted: false, updated: Math.max(d.updated, local ? local.updated + 1 : 0), dirty: 1});
      if(cur && d.id === 'c_' + cur.id) openHit = true;
      n++;
    }
    const pend = [];
    for(const a of pics){
      if(await IDB.get('assets', a.id)) continue;
      const blob = await a.get();
      await IDB.put('assets', {id: a.id, blob, type: a.type || blob.type || 'image/jpeg'}); pend.push(a.id); p++;
    }
    if(pend.length) await pendAdd(pend);   // (1.67.3) added in one step (the old read-then-write could lose pictures)
    await loadDocs(); ensureUi(); renderNav(); renderList(); Sync.soon();
    // (1.67.3) the open page was restored too: show the restored copy (before, the old copy stayed on screen and the
    // next stroke saved it over the restored one)
    if(openHit && cur){ const id = cur.id, keep = {...cam}; cur = null; await openPage(id, {keepStack: true}); Object.assign(cam, keep); invalidate(); }
    toast(`Restored ${n} item${n === 1 ? '' : 's'} and ${p} picture${p === 1 ? '' : 's'}` + (docsIn ? '' : ' (choose part 1 too for the notes)'));
    hideModal('settingsDlg');
  } catch(e){ toast('Restore failed: ' + (e.message || e)); }
  $('restoreFile').value = '';
});

/* =====================================================================
   Page edge on the left (Settings -> Left side of the page)
   ===================================================================== */
function clampLeft(){
  if(cur.lx === undefined){ const b = contentBox(); cur.lx = b ? Math.min(0, b[0]) : 0; }
  const max = (W > 900 ? 56 : 20) - cur.lx * cam.z;
  if(cam.ox > max) cam.ox = max;
}
