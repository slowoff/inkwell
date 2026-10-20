/* Inkwell — notes with typed text and Apple Pencil ink on an infinite page. */
(() => {
'use strict';

/* =====================================================================
   Basics
   ===================================================================== */
const $ = id => document.getElementById(id);
const CFG = window.INKWELL_CONFIG || {};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MM = 96 / 25.4;            // CSS px per millimetre
const A4W = 794, A4H = 1123;     // A4 at 96 dpi
const TABS = 6;
const LSget = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const pad2 = x => String(x).padStart(2, '0');
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

let toastTimer;
function toast(msg, btnLabel, onBtn){
  const t = $('toast'), b = $('toastBtn');
  $('toastText').textContent = msg;
  if(btnLabel){ b.hidden = false; b.textContent = btnLabel; b.onclick = () => { t.hidden = true; onBtn(); }; }
  else b.hidden = true;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, btnLabel ? 9000 : 3800);
}

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
  refLine: false,   // Reference line (1.42): faint line under the handwriting line being written
  ruler: {on: false, cx: null, cy: null, a: 0},
  bg: {type: 'grid', sx: 5 * MM, sy: 5 * MM},
  theme: 'auto',   // 'auto' follows the iPad, or 'light' / 'dark'
  snapHold: 550,   // ms the pen must rest before a stroke is straightened; 0 = off
  leftEdge: false, // true: the page stops at its left edge (endless only up, down and right)
  zMax: 8,         // highest zoom (1 = 100 %); set from Settings with "Use current zoom"
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

/* =====================================================================
   Local database (IndexedDB) — everything is stored here first
   ===================================================================== */
/* One local database per account (1.36). Before, signing out and signing in with another account kept the first
   account's notes on screen, and anything edited then was uploaded into the other account. Now each account has
   its own local database: 'inkwell' (the original one, and notes made without an account) and 'inkwell-<user id>'
   for any other account that signs in on this device. Nothing is deleted when switching; signing back in with the
   first account brings its notes back, including changes not uploaded yet.
   localStorage inkwell.dbs = {cur: name of the database in use, users: {userId: name}}; meta 'owner' = its account. */
const Acct = {
  owner: null,
  st(){ const s = LSget('inkwell.dbs', null) || {}; return {cur: s.cur || 'inkwell', users: s.users || {}}; },
  name(){ return this.st().cur; },
  async load(){ this.owner = (await IDB.get('meta', 'owner').catch(() => null)) || null; },
  // true when the local notes belong to the signed-in account (or have no account yet and now get this one)
  mine(){ return !!(Sync.user && this.owner === Sync.user.id); },
  async ok(user){
    if(!user) return false;
    if(this.owner === user.id) return true;
    const st = this.st(), mapped = st.users[user.id];
    if(!this.owner && (!mapped || mapped === st.cur)){
      // notes made without an account (or by a version before 1.36): from now on they belong to this account
      await IDB.put('meta', user.id, 'owner');
      this.owner = user.id; st.users[user.id] = st.cur; LSset('inkwell.dbs', st);
      return true;
    }
    // the notes on this device belong to another account: open this account's own local notes instead
    if(this.switching) return false;
    this.switching = true;
    try { await flushSaves(); } catch(e){ console.warn('switch account', e); }
    st.cur = mapped || 'inkwell-' + user.id; st.users[user.id] = st.cur;
    LSset('inkwell.dbs', st);
    LSset('inkwell.opening', null);
    toast('Opening the notes of ' + (user.email || 'this account') + '…');
    setTimeout(() => location.reload(), 600);
    return false;
  }
};
const IDB = {
  db: null, mem: null,
  async open(){
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open(Acct.name(), 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('docs', {keyPath: 'id'});
          d.createObjectStore('assets', {keyPath: 'id'});
          d.createObjectStore('meta');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('blocked'));
      });
    } catch(e){
      this.mem = {docs: new Map(), assets: new Map(), meta: new Map()};
      toast('Storage is blocked in this browser. Notes will be lost when you close it.');
    }
  },
  req(store, mode, fn){
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      let out;
      if(r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage write aborted'));
    });
  },
  get(store, key){ if(this.mem) return Promise.resolve(this.mem[store].get(key)); return this.req(store, 'readonly', s => s.get(key)); },
  put(store, val, key){
    if(this.mem){ this.mem[store].set(key !== undefined ? key : val.id, structuredClone(val)); return Promise.resolve(); }
    return this.req(store, 'readwrite', s => key !== undefined ? s.put(val, key) : s.put(val));
  },
  del(store, key){ if(this.mem){ this.mem[store].delete(key); return Promise.resolve(); } return this.req(store, 'readwrite', s => s.delete(key)); },
  all(store){ if(this.mem) return Promise.resolve([...this.mem[store].values()]); return this.req(store, 'readonly', s => s.getAll()); }
};

/* Documents: nb (notebook), sec (section), page (title + order), content (paper + items), tmpl (template) */
const docs = new Map();   // every doc except page contents
let searchCache = null;
const live = d => !!(d && !d.deleted && d.data);
const inMap = kind => kind !== 'content' && kind !== 'ver';   // page contents and page versions stay in IndexedDB only
const byOrder = (a, b) => ((a.data.order || 0) - (b.data.order || 0)) || (a.id < b.id ? -1 : 1);
const notebooks = () => [...docs.values()].filter(d => d.kind === 'nb' && live(d)).sort(byOrder);
const sectionsOf = nb => [...docs.values()].filter(d => d.kind === 'sec' && live(d) && d.data.nb === nb).sort(byOrder);
const pagesOf = sec => [...docs.values()].filter(d => d.kind === 'page' && live(d) && d.data.sec === sec).sort(byOrder);
const templates = () => [...docs.values()].filter(d => d.kind === 'tmpl' && live(d)).sort((a, b) => (a.data.name || '').localeCompare(b.data.name || ''));
const getDoc = id => { const d = docs.get(id); return live(d) ? d : null; };

async function writeDoc(rec){
  rec.updated = Math.max(Date.now(), (rec.updated || 0) + 1);
  rec.dirty = 1;
  rec.deleted = !!rec.deleted;
  if(inMap(rec.kind)) docs.set(rec.id, rec);
  searchCache = null;
  await IDB.put('docs', rec);
  Sync.soon();
  return rec;
}
const newDoc = (kind, data, id) => writeDoc({id: id || kind + '-' + newId(), kind, data, deleted: false});
const patchDoc = (rec, patch) => { rec.data = Object.assign({}, rec.data, patch); return writeDoc(rec); };
// Deleting keeps the data for 30 days (Recently deleted in the settings), marked with data._del = {at, g}.
// g = id of the thing the user deleted, so a section comes back together with its pages.
// purge: true wipes the data for good (old behaviour, and what happens after 30 days).
const TRASH_DAYS = 30;
async function removeDoc(id, kind, group, purge){
  const rec = docs.get(id) || await IDB.get('docs', id) || {id, kind};
  rec.kind = rec.kind || kind; rec.deleted = true;
  rec.data = purge || !rec.data ? null : Object.assign({}, rec.data, {_del: {at: Date.now(), g: group || id}});
  return writeDoc(rec);
}

/* Page history (since 1.27). Doc kind 'ver', id v_<pageId>_<time base36>, data {page, at, why, n, bg, items}.
   A version keeps a page as it was before an editing session (at most one per VER_GAP of editing), before changes
   from another device are merged in and before a restore. The newest VER_KEEP per page are kept; older ones are purged.
   Versions sync like other docs (so they are on the server too) but stay out of the in-memory docs map. */
const VER_GAP = 30 * 60000, VER_KEEP = 30;
async function versionsOf(pid){
  const lo = 'v_' + pid + '_', hi = lo + '\uffff';
  const list = IDB.mem ? [...IDB.mem.docs.values()].filter(d => d.id >= lo && d.id < hi)
    : await IDB.req('docs', 'readonly', st => st.getAll(IDBKeyRange.bound(lo, hi)));
  return (list || []).filter(d => d.kind === 'ver' && !d.deleted && d.data && d.data.page === pid).sort((a, b) => b.data.at - a.data.at);
}
async function saveVersion(pid, data, why){
  if(!pid || !data || !Array.isArray(data.items) || !data.items.length) return null;   // an empty page is not worth keeping
  const list = await versionsOf(pid);
  const same = v => stable({bg: v.bg || null, items: v.items}) === stable({bg: data.bg || null, items: data.items});
  if(list[0] && same(list[0].data)) return null;   // unchanged since the last version
  const at = Math.max(Date.now(), list[0] ? list[0].data.at + 1 : 0);
  const rec = await writeDoc({id: 'v_' + pid + '_' + at.toString(36), kind: 'ver', deleted: false,
    data: {page: pid, at, why: why || 'edit', n: data.items.length, bg: data.bg || null, items: data.items}});
  for(const old of list.slice(VER_KEEP - 1)) await removeDoc(old.id, 'ver', null, true);
  return rec;
}

/* Imported PDF pages and photos */
const assetURLs = new Map();
async function saveAsset(blob){
  const id = 'a-' + newId();
  await IDB.put('assets', {id, blob, type: blob.type || 'image/jpeg'});
  const pend = (await IDB.get('meta', 'pendingAssets')) || [];
  pend.push(id);
  await IDB.put('meta', pend, 'pendingAssets');
  Sync.soon();
  return id;
}
async function assetURL(id){
  if(assetURLs.has(id)) return assetURLs.get(id);
  let rec = await IDB.get('assets', id);
  if(!rec) rec = await Sync.fetchAsset(id);
  if(!rec) return null;
  const u = URL.createObjectURL(rec.blob);
  assetURLs.set(id, u);
  return u;
}

/* =====================================================================
   Sync (Supabase). Local-first: edits save locally and upload later.
   ===================================================================== */
const Sync = {
  sb: null, user: null, fresh: null, signingOut: false, state: 'local', msg: '', running: false, again: false, timer: null, lastOk: 0,
  chan: null, chanUser: null, liveOk: false, pingT: 0,
  configured(){ return !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY); },
  async init(){
    if(!this.configured()){ this.state = 'local'; setStatus(); return; }
    if(!window.supabase){ this.state = 'warn'; this.msg = 'Sync library missing'; setStatus(); return; }
    const link = readAuthLink();
    try {
      this.sb = window.supabase.createClient(CFG.SUPABASE_URL.trim(), CFG.SUPABASE_ANON_KEY.trim(), {
        auth: {persistSession: true, autoRefreshToken: true, storageKey: 'inkwell-auth', detectSessionInUrl: true}
      });
      const {data} = await this.sb.auth.getSession();
      this.user = data && data.session ? data.session.user : null;
      this.sb.auth.onAuthStateChange((ev, session) => {
        // A stale stored session (e.g. iOS closed the app while it was renewing its token) can make the library
        // wipe a sign-in that just succeeded. Put the new session back instead of signing out.
        if(ev === 'SIGNED_OUT' && !this.signingOut && this.fresh && Date.now() - this.fresh.at < 20000 && this.fresh.tries < 3){
          const f = this.fresh; f.tries++;
          setTimeout(() => this.sb.auth.setSession({access_token: f.s.access_token, refresh_token: f.s.refresh_token}).catch(e => console.warn('restore session', e)), 0);
          return;
        }
        if(ev === 'PASSWORD_RECOVERY') startRecovery();
        const was = this.user && this.user.id;
        this.user = session ? session.user : null;
        if(!this.user || this.user.id !== was) this.unlisten();
        if(this.user && this.user.id !== was) this.run();
        setStatus(); renderSettings();
      });
      if(link.recovery && this.user) startRecovery();
      else if(link.error && !this.user){ authView = 'reset'; setTimeout(() => { openSettings(); $('resetMsg').textContent = linkErrorText(link.error); }, 300); }
    } catch(e){ this.sb = null; this.state = 'warn'; this.msg = 'Sync settings in config.js look wrong'; }
    if(sessionStorage.getItem('inkwell.recovery') && this.user && authView !== 'newpass') startRecovery();
    setStatus(); renderSettings();
    this.run();
    setInterval(() => { if(document.visibilityState === 'visible') this.run(); }, 20000);
    addEventListener('online', () => this.run());
  },
  soon(){ if(!this.sb || !this.user) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), this.liveOk ? 1500 : 2500); },
  // Instant sync: a device that uploaded changes says so on the account's realtime channel ("changed", no data);
  // the other devices pull right away. Polling every 20 s stays as the fallback when the channel is down.
  listen(){
    if(!this.sb || !this.user || !this.sb.channel) return;
    if(this.chan && this.chanUser === this.user.id) return;
    this.unlisten();
    this.chanUser = this.user.id;
    try {
      const ch = this.sb.channel('inkwell-' + this.user.id, {config: {broadcast: {self: false, ack: false}}});
      ch.on('broadcast', {event: 'changed'}, () => this.ping());
      ch.subscribe(st => {
        const ok = st === 'SUBSCRIBED';
        if(ok === this.liveOk) return;
        this.liveOk = ok; renderSyncInfo();
        if(ok) this.ping();   // catch up on anything missed while not connected
      });
      this.chan = ch;
    } catch(e){ console.warn('live sync', e); this.chan = null; }
  },
  unlisten(){
    if(this.chan){ try { this.sb.removeChannel(this.chan); } catch {} }
    this.chan = null; this.chanUser = null; this.liveOk = false;
  },
  ping(){ clearTimeout(this.pingT); this.pingT = setTimeout(() => this.run(), 200); },
  tell(){ if(this.chan && this.liveOk){ try { this.chan.send({type: 'broadcast', event: 'changed', payload: {}}); } catch(e){ console.warn('live sync send', e); } } },
  async run(){
    if(!this.sb || !this.user){ this.unlisten(); setStatus(); return; }
    // (1.36) the notes on this device must belong to this account; otherwise its own local notes are opened first
    if(!(await Acct.ok(this.user))) return;
    this.listen();
    if(!navigator.onLine){ this.state = 'offline'; setStatus(); return; }
    if(this.running){ this.again = true; return; }
    this.running = true; this.state = 'syncing'; setStatus();
    try {
      await seedBases();
      await this.pull();
      const sent = await this.push();
      await this.pushAssets();
      if(sent) this.tell();
      // (1.36) keep the account's storage info fresh (at most every 10 minutes): the Drive notes copy, the daily
      // picture check and the move of old pictures all start from it. Before, it only loaded when Settings was opened
      // or a picture had to be uploaded or downloaded, so on most starts the notes copy in Drive was not updated.
      Files.on().catch(() => {});
      this.state = 'synced'; this.msg = ''; this.lastOk = Date.now();
      if(this.refused){
        this.state = 'warn';
        this.msg = this.refused === 'notes_full' ? 'Notes storage full: new changes stay on this device' : 'A page is too big to sync: it stays on this device';
      }
    } catch(e){
      console.warn('sync', e);
      this.state = 'warn'; this.msg = syncError(e);
    }
    this.running = false; setStatus(); renderSettings();
    if(this.again){ this.again = false; this.run(); }
  },
  async pull(){
    const key = 'pull:' + this.user.id;
    let cursor = (await IDB.get('meta', key)) || '1970-01-01T00:00:00Z';
    let changed = false;
    for(let guard = 0; guard < 500; guard++){
      const {data, error} = await this.sb.from('docs')
        .select('id,kind,data,deleted,updated_at,server_ts')
        .gt('server_ts', cursor).order('server_ts', {ascending: true}).limit(100);
      if(error) throw error;
      for(const row of data) if(await applyRemote(row)) changed = true;
      if(data.length){ cursor = data[data.length - 1].server_ts; await IDB.put('meta', cursor, key); }
      if(data.length < 100) break;
    }
    if(changed) remoteChanged();
  },
  // Right before uploading: if another device changed one of these docs since this device last saw it,
  // fetch that version and merge it in first, so the upload does not overwrite it.
  async checkStale(){
    const cand = (await IDB.all('docs')).filter(d => d.dirty && !d.deleted && d.data && MERGE_KINDS.has(d.kind));
    let merged = 0;
    for(let i = 0; i < cand.length; i += 100){
      const part = cand.slice(i, i + 100), bases = new Map();
      for(const d of part){ const b = await baseGet(d.id); if(b) bases.set(d.id, b); }
      const ids = part.filter(d => bases.has(d.id)).map(d => d.id);
      if(!ids.length) continue;
      const {data, error} = await this.sb.from('docs').select('id,server_ts').in('id', ids);
      if(error) throw error;
      const stale = (data || []).filter(r => r.server_ts !== bases.get(r.id).ts).map(r => r.id);
      if(!stale.length) continue;
      const full = await this.sb.from('docs').select('id,kind,data,deleted,updated_at,server_ts').in('id', stale);
      if(full.error) throw full.error;
      for(const row of full.data || []){
        const b = bases.get(row.id);
        if(!b.ts && stable(b.d) === stable(row.data)){ await baseSet(row.id, b.d, row.server_ts); continue; }   // seeded base, server unchanged
        if(await applyRemote(row)) merged++;
      }
    }
    if(merged) remoteChanged();
  },
  async push(){
    await this.checkStale();
    const all = await IDB.all('docs');
    const dirty = all.filter(d => d.dirty);
    let batch = [], size = 0, refused = null;
    const LIMIT = /notes_full|doc_too_big/;
    const flush = async () => {
      if(!batch.length) return;
      const rows = batch.map(d => ({user_id: this.user.id, id: d.id, kind: d.kind, data: d.data ?? null, deleted: !!d.deleted, updated_at: d.updated}));
      let {data: back, error} = await this.sb.from('docs').upsert(rows, {onConflict: 'user_id,id'}).select('id,server_ts');
      // (1.36) the server refused a doc (notes limit reached, or one doc too big): upload the others one by one,
      // so one refused doc does not stop everything else from syncing. Refused ones stay on this device.
      if(error && LIMIT.test(String(error.message || '')) && batch.length > 1){
        const ok = [];
        back = [];
        for(let i = 0; i < batch.length; i++){
          const one = await this.sb.from('docs').upsert([rows[i]], {onConflict: 'user_id,id'}).select('id,server_ts');
          if(one.error){
            if(!LIMIT.test(String(one.error.message || ''))) throw one.error;
            refused = String(one.error.message).match(LIMIT)[0];
          } else { ok.push(batch[i]); back.push(...(one.data || [])); }
        }
        batch = ok; error = null;
      } else if(error && LIMIT.test(String(error.message || ''))){ refused = String(error.message).match(LIMIT)[0]; batch = []; error = null; }
      if(error) throw error;
      const ts = new Map((back || []).map(r => [r.id, r.server_ts]));
      for(const d of batch){
        if(!MERGE_KINDS.has(d.kind)) continue;
        if(d.deleted || !d.data) await baseDel(d.id);
        else await baseSet(d.id, d.data, ts.get(d.id));
      }
      for(const d of batch){
        const now = await IDB.get('docs', d.id);
        if(now && now.updated === d.updated){
          now.dirty = 0; await IDB.put('docs', now);
          const m = docs.get(d.id); if(m && m.updated === d.updated) m.dirty = 0;
        }
      }
      batch = []; size = 0;
    };
    for(const d of dirty){
      const s = JSON.stringify(d.data || null).length;
      if(batch.length && size + s > 1500000) await flush();
      batch.push(d); size += s;
    }
    await flush();
    this.refused = refused;
    return dirty.length;
  },
  async pushAssets(){
    let pend = (await IDB.get('meta', 'pendingAssets')) || [];
    const r2 = pend.length ? await Files.on() : false;
    Files.localOnly = pend.length;
    // (1.36) the old Supabase picture storage is only for a server without the files function (it answered 404).
    // If the function just could not be reached, the pictures wait here: before, they went to the old storage,
    // which is about to be emptied.
    if(pend.length && !r2 && !(Files.info && Files.info.r2 === false)) return;
    // cloud full: new pictures stay on this device (nothing is lost) and uploads are retried every 30 minutes
    if(r2 && Files.full && Date.now() - Files.full.at < 1800000) return;
    while(pend.length){
      const id = pend[0];
      const a = await IDB.get('assets', id);
      if(a){
        if(r2){
          try { await Files.upload(id, a.blob); Files.full = null; }
          catch(e){
            if(e.code === 'cloud_full' || e.code === 'storage_full' || e.code === 'gdrive_full' || e.code === 'need_drive'){ Files.full = Object.assign({at: Date.now(), code: e.code}, e.j || {}); Files.localOnly = pend.length; Files.notice(); renderSyncInfo(); return; }
            throw e;
          }
        } else {
          const {error} = await this.sb.storage.from('assets').upload(this.user.id + '/' + id, a.blob, {contentType: a.type || 'image/jpeg', upsert: true});
          if(error) throw error;
        }
      }
      pend = ((await IDB.get('meta', 'pendingAssets')) || []).filter(x => x !== id);
      await IDB.put('meta', pend, 'pendingAssets');
      Files.localOnly = pend.length;
    }
  },
  async fetchAsset(id){
    if(!this.sb || !this.user || !navigator.onLine) return null;
    try {
      let data = null;
      if(await Files.on()){ try { data = await Files.download(id); } catch(e){ console.warn('r2 get', e); } }
      if(!data){
        const r = await this.sb.storage.from('assets').download(this.user.id + '/' + id);
        if(r.error || !r.data) return null;
        data = r.data;
      }
      const rec = {id, blob: data, type: data.type};
      await IDB.put('assets', rec);
      return rec;
    } catch { return null; }
  }
};
/* =====================================================================
   Pictures in Cloudflare R2 (since 1.27), through the server function 'files' (supabase/functions/files).
   The R2 key stays on the server; the app gets short-lived links to its own folder. When the function is
   missing or R2 is not set up (info.r2 false), pictures keep going to Supabase storage as before.
   Old pictures in Supabase storage are copied over in the background (migrate) and still read from there until then.
   ===================================================================== */
const Files = {
  info: null, infoAt: 0, migrating: false, migLeft: null, full: null, localOnly: 0, pend: new Map(), timer: null,
  // share of the cloud in use (everyone together), 0..1, or null when unknown
  share(){ const i = this.info; return i && i.r2 && i.cap_mb ? Math.min(1, (i.total_mb || 0) / i.cap_mb) : null; },
  // a friendly heads-up at most once a day: nearly full, or full (new pictures stay on the device)
  notice(){
    const g = this.info && this.info.gdrive;
    if(g && g.broken && LSget('inkwell.gdNote', '') !== new Date().toDateString()){ LSset('inkwell.gdNote', new Date().toDateString()); GD.lost(); return; }
    if(this.info && this.info.google_client_id && !g && this.full && this.full.code === 'need_drive' && LSget('inkwell.gdNote', '') !== new Date().toDateString()){
      LSset('inkwell.gdNote', new Date().toDateString());
      toast('Connect your Google Drive so new pictures can be saved. Until then they wait on this device.', 'Settings', () => openSettings()); return;
    }
    if(this.info && this.info.google_client_id) return;   // 1.34: no shared storage any more
    const sh = this.share(), full = !!(this.full && this.full.code === 'cloud_full') || (sh !== null && sh >= 0.995);
    const kind = full ? 'full' : sh !== null && sh >= 0.8 ? 'near' : '';
    if(!kind) return;
    const day = new Date().toDateString(), key = 'inkwell.cloudNote';
    if(LSget(key, '') === kind + day) return;
    LSset(key, kind + day);
    if(kind === 'full') toast('Cloud storage is full. New pictures are kept on this device only for now, so they won\'t show up on your other devices. Free up room in Settings → Clean up.', 'Clean up', () => openCleanup());
    else toast(`Cloud storage is ${Math.round(sh * 100)}% full. When it is full, new pictures stay on this device only. You can delete old things in Settings → Clean up.`, 'Clean up', () => openCleanup());
  },
  async call(action, body){
    const {data} = await Sync.sb.auth.getSession(); const s = data && data.session;
    if(!s) throw Object.assign(new Error('Sign in first'), {code: 'not_signed_in'});
    let res;
    try {
      res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/files', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token, apikey: CFG.SUPABASE_ANON_KEY},
        body: JSON.stringify(Object.assign({action}, body || {}))
      });
    } catch { throw Object.assign(new Error('Failed to fetch'), {code: 'offline'}); }
    let j = {}; try { j = await res.json(); } catch {}
    if(!res.ok) throw Object.assign(new Error(j.message || j.error || 'Server error ' + res.status), {code: j.error || 'http_' + res.status, status: res.status, j});
    return j;
  },
  // true when pictures go to R2; info (usage and limits) refreshed at most every 10 minutes
  async on(force){
    if(!Sync.sb || !Sync.user || !navigator.onLine || !Acct.mine()) return false;
    if(force || !this.info || Date.now() - this.infoAt > 600000){
      try { this.info = await this.call('info'); }
      catch(e){ if(e.status === 404) this.info = {r2: false}; else if(!this.info) return false; }
      this.infoAt = Date.now();
      if(this.info && this.info.r2){ this.migrateSoon(); this.notice(); setTimeout(() => GD.autoMove(), 5000); }
    }
    return !!(this.info && this.info.r2);
  },
  async upload(id, blob, again){
    const res = await this.call('put', {id, size: blob.size});
    if(res.drive){
      try {
        const gid = await GD.upload(id, blob);
        await this.call('gdone', {id, gid, size: blob.size});
        if(this.info && this.info.gdrive) this.info.gdrive.mb = (this.info.gdrive.mb || 0) + blob.size / 1048576;
        return;
      } catch(e){
        // Google sign-in no longer valid: the server switched this account back to the shared storage
        if(e.code === 'g_revoked' && !again){ GD.lost(); return this.upload(id, blob, true); }
        throw e;
      }
    }
    const url = res.url;
    let r;
    try { r = await fetch(url, {method: 'PUT', body: blob, headers: {'Content-Type': blob.type || 'image/jpeg'}}); }
    catch { throw Object.assign(new Error('Failed to fetch'), {code: 'offline'}); }
    if(!r.ok) throw new Error('Picture upload failed (' + r.status + ')');
    if(this.info) this.info.used_mb = (this.info.used_mb || 0) + blob.size / 1048576;
  },
  // links are asked for in batches: pictures near the view load together
  url(id){
    return new Promise((res, rej) => {
      this.pend.set(id, (this.pend.get(id) || []).concat([[res, rej]]));
      clearTimeout(this.timer); this.timer = setTimeout(() => this.flushGet(), 30);
    });
  },
  async flushGet(){
    const batch = this.pend; this.pend = new Map();
    const ids = [...batch.keys()];
    for(let i = 0; i < ids.length; i += 100){
      const part = ids.slice(i, i + 100);
      try { const {urls} = await this.call('get', {ids: part}); for(const id of part) for(const [r] of batch.get(id)) r((urls || {})[id] || null); }
      catch(e){ for(const id of part) for(const [, j] of batch.get(id)) j(e); }
    }
  },
  async download(id){
    const u = await this.url(id); if(!u) return null;
    if(typeof u === 'object' && u.g) return GD.download(u.g);
    const r = await fetch(u); if(!r.ok) return null;
    return await r.blob();
  },
  migrateSoon(){ setTimeout(() => this.migrate().catch(e => console.warn('migrate', e)), 4000); },
  async migrate(){
    if(this.migrating || !Sync.user) return;
    const key = 'r2Migrated:' + Sync.user.id;
    if(await IDB.get('meta', key)) return;
    this.migrating = true;
    try {
      for(let guard = 0; guard < 500; guard++){
        if(!navigator.onLine || document.visibilityState !== 'visible' || !Sync.user) break;
        const r = await this.call('migrate', {n: 6});
        this.migLeft = r.left; renderSyncInfo();
        if(r.full) break;
        if(!r.left){ await IDB.put('meta', 1, key); break; }
        await new Promise(res => setTimeout(res, 300));
      }
    } finally { this.migrating = false; renderSyncInfo(); }
  }
};
/* =====================================================================
   Google Drive for pictures (since 1.30), optional per account. The person signs in to Google once (redirect, PKCE,
   scope drive.file = only files Inkwell made); the server keeps the refresh token (table gdrive) and hands out short
   access tokens, so their other devices use Drive without signing in. Pictures go into the folder "Inkwell pictures".
   ===================================================================== */
const GD_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GD_FILES = 'https://www.googleapis.com/drive/v3/files';
const GD_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
const GD = {
  ret: null, tok: null, moving: false,
  redirect(){ return location.origin + location.pathname.replace(/index\.html$/, ''); },
  catchRedirect(){
    const q = new URLSearchParams(location.search), st = q.get('state') || '';
    if(!st.startsWith('gd-') && !st.startsWith('gl-')) return;
    history.replaceState(null, '', location.pathname + location.hash);
    const saved = LSget('inkwell.gdrive.auth', null);
    LSset('inkwell.gdrive.auth', null);
    if(q.get('error')) this.ret = {error: q.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed (' + q.get('error') + ').'};
    else if(!saved || saved.s !== st || !q.get('code')) this.ret = {error: 'The Google sign-in did not finish. Try again.'};
    else this.ret = {code: q.get('code'), v: saved.v};
    this.ret.login = st.startsWith('gl-');
  },
  // Sign in with Google (1.34): one Google screen signs in to Inkwell and connects Drive
  login(){ $('gLoginMsg').textContent = 'Opening Google…'; return this.connect(true); },
  async connect(login){
    const cid = CFG.GOOGLE_CLIENT_ID || (Files.info && Files.info.google_client_id);
    if(!cid){ toast('Google sign-in is not set up yet.'); return; }
    const v = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const ch = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
    const s = (login ? 'gl-' : 'gd-') + b64url(crypto.getRandomValues(new Uint8Array(16)));
    LSset('inkwell.gdrive.auth', {v, s, at: Date.now()});
    await flushSaves();
    const p = new URLSearchParams({client_id: cid, response_type: 'code', redirect_uri: this.redirect(), scope: 'https://www.googleapis.com/auth/drive.file openid email',
      state: s, code_challenge: ch, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true'});
    location.assign(GD_AUTH + '?' + p);
  },
  // back from Google: hand the code to the server (it keeps the lasting access)
  async finish(){
    const r = this.ret; if(!r) return;
    if(r.login) return this.finishLogin(r);
    for(let i = 0; i < 40 && !(Sync.sb && Sync.user); i++) await new Promise(res => setTimeout(res, 250));
    this.ret = null;
    if(r.error){ toast(r.error); return; }
    try {
      const j = await Files.call('gconnect', {code: r.code, verifier: r.v, redirect: this.redirect()});
      this.tok = null;
      await Files.on(true);
      Files.full = null; Sync.soon();
      toast('Google Drive connected' + (j.email ? ' (' + j.email + ')' : '') + '. Your notes and pictures are saved there.');
      this.saveNotes(true);
      openSettings();
    } catch(e){
      const m = String(e.message || e);
      if(/client secret|invalid_client|unauthorized_client/i.test(m)) toast('Google Drive is not set up right on the server yet. Your pictures keep using the shared storage.');
      else if(/invalid_grant|expired|already (been )?(used|redeemed)/i.test(m)) toast('The Google sign-in took too long. Tap Connect again.', 'Settings', () => openSettings());
      else toast('Google Drive could not connect: ' + m);
    }
  },
  async finishLogin(r){
    for(let i = 0; i < 40 && !Sync.sb; i++) await new Promise(res => setTimeout(res, 250));
    this.ret = null;
    const fail = m => { authView = 'signin'; openSettings(); $('gLoginMsg').textContent = m; toast(m); };
    if(r.error) return fail(r.error);
    if(!Sync.sb) return fail('Sync could not start, so Inkwell cannot sign in right now.');
    toast('Signing in with Google…');
    let j = {}, res;
    try {
      res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/files', {method: 'POST',
        headers: {'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY},   // no session yet: the key goes only in apikey (1.35)
        body: JSON.stringify({action: 'glogin', code: r.code, verifier: r.v, redirect: this.redirect()})});
      j = await res.json().catch(() => ({}));
    } catch { return fail('No connection. Try again when you are online.'); }
    if(!res.ok || !j.token_hash){
      const m = String(j.message || j.error || res.status);
      return fail(/invalid_grant|expired|already/i.test(m) ? 'The Google sign-in took too long. Tap Sign in with Google again.' : /client secret|invalid_client/i.test(m) ? 'Google sign-in is not set up right on the server yet.' : m);
    }
    await clearStaleSession();
    this.tok = null; Files.full = null; Files.info = null;
    const {data, error} = await Sync.sb.auth.verifyOtp({token_hash: j.token_hash, type: 'magiclink'});
    if(error || !data || !data.session) return fail('Signing in did not finish: ' + ((error && error.message) || 'no session') + '. Try again.');
    Sync.fresh = {s: data.session, at: Date.now(), tries: 0};
    LSset('inkwell.gdNote', null);
    const note = j.created ? 'New Inkwell account made for ' + j.email + '. If your notes are under another Google account, sign out (Settings) and sign in with that one.'
      : 'Signed in as ' + j.email + '. Your notes and pictures are saved in your Google Drive.';
    // another account's notes were open: Inkwell reloads with this account's own notes and says it then (1.36)
    if(Acct.switching){ LSset('inkwell.note', note); return; }
    if(j.created) toast(note, 'Settings', () => openSettings()); else toast(note);
    setTimeout(() => { Files.on(true).then(() => { renderCloud(); this.saveNotes(true); this.autoMove(); }).catch(() => {}); }, 2500);
  },
  async token(force){
    if(!force && this.tok && this.tok.exp > Date.now() + 60000) return this.tok;
    const j = await Files.call('gtoken');
    this.tok = {at: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, folder: j.folder};
    return this.tok;
  },
  async upload(id, blob){
    for(let k = 0; k < 2; k++){
      const t = await this.token(k > 0);
      const b = 'inkwell' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const meta = JSON.stringify({name: id + '.jpg', parents: t.folder ? [t.folder] : undefined});
      const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`, blob, `\r\n--${b}--`]);
      let r;
      try { r = await fetch(GD_UPLOAD, {method: 'POST', headers: {Authorization: 'Bearer ' + t.at, 'Content-Type': 'multipart/related; boundary=' + b}, body}); }
      catch { throw Object.assign(new Error('Failed to fetch'), {code: 'offline'}); }
      if(r.status === 401 && k === 0) continue;
      const j = await r.json().catch(() => ({}));
      if(r.status === 403 && /storageQuota|quota/i.test(JSON.stringify(j))) throw Object.assign(new Error('Your Google Drive is full'), {code: 'gdrive_full'});
      if(!r.ok || !j.id) throw new Error('Google Drive upload failed (' + r.status + ')');
      return j.id;
    }
  },
  async download(gid){
    for(let k = 0; k < 2; k++){
      const t = await this.token(k > 0);
      const r = await fetch(GD_FILES + '/' + encodeURIComponent(gid) + '?alt=media', {headers: {Authorization: 'Bearer ' + t.at}});
      if(r.status === 401 && k === 0) continue;
      return r.ok ? await r.blob() : null;
    }
    return null;
  },
  lost(){
    this.tok = null;
    LSset('inkwell.gdNote', new Date().toDateString());
    if(Files.info && Files.info.gdrive){ Files.info.gdrive.broken = true; Files.info.gdrive.on = false; }
    toast('Google Drive is no longer connected. New pictures wait on this device until you connect it again in Settings → Google Drive.', 'Settings', () => openSettings());
  },
  async setOn(on){ await Files.call('gset', {on}); await Files.on(true); renderCloud(); },
  /* (1.33) A full copy of all notes in the Drive folder as "Inkwell notes.json" (same format as the backup's notes.json,
     so Settings → Restore backup reads it). Updated a few minutes after changes and when the app goes to the background.
     Sync itself still runs through Inkwell's server; this copy is so everything is also in the person's own Drive. */
  notesBusy: false,
  notesState(){ return LSget('inkwell.gdNotes', null) || {}; },
  async saveNotes(force){
    const g = Files.info && Files.info.gdrive;
    if(!g || g.broken || this.notesBusy || !navigator.onLine || !Sync.user || !Acct.mine()) return;
    const st = this.notesState();
    if(st.fail && Date.now() - st.fail < 60000) return;          // after a failure, wait a minute
    this.notesBusy = true;
    try {
      await flushSaves();
      const docsAll = (await IDB.all('docs')).filter(d => !d.deleted && d.data).map(d => ({id: d.id, kind: d.kind, data: d.data, updated: d.updated}));
      const sig = docsAll.length + ':' + docsAll.reduce((m, d) => Math.max(m, d.updated || 0), 0) + ':' + Sync.user.id;
      if(sig === st.sig && st.id) return;                         // nothing changed since the last copy
      if(!force && st.saved && Date.now() - st.saved < 3 * 60000) return;   // while writing: at most every 3 minutes
      const body = JSON.stringify({app: 'Inkwell', version: 2, exported: new Date().toISOString(), parts: 1, docs: docsAll});
      let id = st.uid === Sync.user.id ? st.id : null, remade = false;
      for(let k = 0; k < 2; k++){
        const t = await this.token(k > 0), H = {Authorization: 'Bearer ' + t.at};
        if(!id){
          const q = `name='Inkwell notes.json' and trashed=false` + (t.folder ? ` and '${t.folder}' in parents` : '');
          const r = await fetch(GD_FILES + '?fields=files(id)&q=' + encodeURIComponent(q), {headers: H});
          if(r.status === 401 && k === 0) continue;
          const j = await r.json().catch(() => ({}));
          id = j.files && j.files[0] && j.files[0].id || null;
        }
        let r;
        if(id){
          r = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(id) + '?uploadType=media&fields=id', {method: 'PATCH', headers: {...H, 'Content-Type': 'application/json'}, body});
          if(r.status === 404 && !remade){ id = null; remade = true; k--; continue; }   // the file was deleted in Drive: make it again (once)
        } else {
          const b = 'inkwell' + Math.random().toString(36).slice(2) + Date.now().toString(36);
          const meta = JSON.stringify({name: 'Inkwell notes.json', mimeType: 'application/json', description: 'A copy of all your Inkwell notes, kept up to date. Settings → Restore backup can read it.', parents: t.folder ? [t.folder] : undefined});
          r = await fetch(GD_UPLOAD, {method: 'POST', headers: {...H, 'Content-Type': 'multipart/related; boundary=' + b},
            body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`});
        }
        if(r.status === 401 && k === 0) continue;
        const j = await r.json().catch(() => ({}));
        if(!r.ok || !j.id) throw new Error('Google Drive (' + r.status + ')');
        LSset('inkwell.gdNotes', {id: j.id, uid: Sync.user.id, sig, saved: Date.now()});
        if(!$('settingsDlg').hidden) renderGD();
        return;
      }
    } catch(e){ console.warn('gdrive notes', e); LSset('inkwell.gdNotes', {...st, fail: Date.now()}); }
    finally { this.notesBusy = false; }
  },
  // (1.35) once a day: are all Drive pictures still in the folder? (deleted or in Drive's bin -> they would vanish from pages)
  async check(force){
    const i = Files.info, g = i && i.gdrive;
    if(!g || g.broken || this.moving || !navigator.onLine || !Sync.user) return null;
    const day = new Date().toDateString(), st = LSget('inkwell.gdCheck', null) || {};
    if(!force && st.day === day && st.uid === Sync.user.id) return st;
    try {
      const r = await Files.call('gcheck');
      const out = {day, uid: Sync.user.id, total: r.total, missing: r.missing, folder_ok: r.folder_ok, at: Date.now()};
      LSset('inkwell.gdCheck', out);
      if(!r.folder_ok) toast('The "Inkwell pictures" folder in your Google Drive was deleted or is in the bin. Restore it in Google Drive, or your pictures disappear from your pages.');
      else if(r.missing) toast(`${r.missing} picture${r.missing === 1 ? ' is' : 's are'} missing from your Google Drive (deleted or in the bin). Restore ${r.missing === 1 ? 'it' : 'them'} from Drive's bin to get ${r.missing === 1 ? 'it' : 'them'} back.`);
      if(!$('settingsDlg').hidden) renderGD();
      return out;
    } catch(e){ console.warn('gdrive check', e); return null; }
  },
  // (1.34) pictures still in the old shared storage move to the person's Drive by themselves
  autoMove(){
    const i = Files.info, g = i && i.gdrive;
    if(this.moving || !g || g.broken || document.visibilityState !== 'visible') return;
    if(!(i.used_mb > 0)){ this.check(); return; }
    this.move(true).then(() => this.check(true));
  },
  // move this person's pictures from the shared storage into their Drive
  async move(quiet){
    if(this.moving) return;
    this.moving = true;
    try {
      for(let guard = 0; guard < 2000; guard++){
        const r = await Files.call('gmove', {n: 5});
        this.moveLeft = r.left;
        $('gdState').textContent = r.left ? `Moving your pictures to your Drive: ${r.left} left. Keep Inkwell open.` : 'All your pictures are in your Google Drive now.';
        renderSyncInfo();
        if(!r.left || !r.moved || document.visibilityState !== 'visible') break;
      }
    } catch(e){ if(!quiet) toast('Moving stopped: ' + (e.message || e) + '. It continues by itself next time.'); console.warn('gdrive move', e); }
    this.moving = false; this.moveLeft = 0; renderSyncInfo();
    await Files.on(true).catch(() => {}); renderCloud();
  }
};
function syncError(e){
  if(e && e.code === 'gdrive_full') return 'Your Google Drive is full: new pictures stay on this device';
  if(e && e.code === 'need_drive') return 'Connect Google Drive: new pictures wait on this device';
  if(e && e.code === 'storage_full'){ const j = (e.j || Files.full || {}); return `Picture storage full (${j.used_mb ?? '?'} of ${j.limit_mb ?? '?'} MB): new pictures stay on this device`; }
  const m = String((e && (e.message || e.error_description || e.msg)) || e || '');
  if(/relation .*docs.* does not exist|Could not find the table/i.test(m)) return 'Run setup.sql in Supabase';
  if(/Bucket not found/i.test(m)) return 'Run setup.sql in Supabase (storage)';
  if(/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Offline, will sync later';
  if(/JWT|token/i.test(m)) return 'Sign in again';
  if(/row-level security/i.test(m)) return 'Sign in again';
  return 'Sync problem: ' + m.slice(0, 60);
}
let pendingCurrentReload = false, lastLocalEdit = 0;
/* Merging (since 1.26): when a page, section or notebook changed on two devices before they synced,
   both sides' changes are kept instead of the newer device overwriting the other.
   The base is the last version this device and the server agreed on: meta 'base:<id>' = {d: data, ts: server_ts}
   (ts null = seeded from an already synced copy, server time unknown).
   Pages (content docs) merge item by item; page/section/notebook docs merge field by field.
   Both sides changed the same item: the newer side wins, except text boxes, where the other version is kept as a copy. */
const MERGE_KINDS = new Set(['content', 'page', 'sec', 'nb']);
function stable(v){
  if(Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if(v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return v === undefined ? 'null' : JSON.stringify(v);
}
const baseGet = id => IDB.get('meta', 'base:' + id);
const baseSet = (id, d, ts) => IDB.put('meta', {d, ts: ts || null}, 'base:' + id);
const baseDel = id => IDB.del('meta', 'base:' + id);
function mergeKeys(b, l, r, lNew){
  b = b || {}; l = l || {}; r = r || {};
  const out = {};
  for(const k of new Set([...Object.keys(l), ...Object.keys(r)])){
    const sb = stable(b[k]), sl = stable(l[k]), sr = stable(r[k]);
    const v = sl === sr ? l[k] : sl === sb ? r[k] : sr === sb ? l[k] : lNew ? l[k] : r[k];
    if(v !== undefined) out[k] = v;
  }
  return out;
}
// b, l, r: content data with serialised items. lNew: the local side was edited more recently.
function mergeContent(b, l, r, lNew){
  const map = d => new Map(((d && d.items) || []).filter(it => it && it.id).map(it => [it.id, it]));
  const bi = map(b), li = map(l), ri = map(r);
  const pick = new Map(), extra = [];
  let copies = 0;
  for(const id of new Set([...li.keys(), ...ri.keys()])){
    const B = bi.get(id), L = li.get(id), R = ri.get(id);
    const kb = B ? stable(B) : null, kl = L ? stable(L) : null, kr = R ? stable(R) : null;
    let v;
    if(kl === kr) v = L;
    else if(kl === kb) v = R;          // changed (or deleted) only on the other device
    else if(kr === kb) v = L;          // changed (or deleted) only here
    else if(!L) v = R;                 // deleted here, changed there: keep the change
    else if(!R) v = L;
    else {
      v = lNew ? L : R;
      const o = lNew ? R : L;
      if(o.t === 'x'){                 // two different edits of one text box: keep both
        const cp = Object.assign({}, o, {id: (o.id[0] || 'x') + newId(), x: (o.x || 0) + 24, y: (o.y || 0) + 24});
        delete cp.g;
        extra.push(cp); copies++;
      }
    }
    if(v) pick.set(id, v);
  }
  // drawing order: this device's order, with the other device's new items slotted in after their neighbour there
  const order = [...li.keys()].filter(id => pick.has(id));
  const pos = new Set(order);
  let prev = null;
  for(const id of ri.keys()){
    if(!pick.has(id)) continue;
    if(!pos.has(id)){ order.splice(prev === null ? 0 : order.indexOf(prev) + 1, 0, id); pos.add(id); }
    prev = id;
  }
  const strip = d => { const o = Object.assign({}, d || {}); delete o.items; return o; };
  const data = mergeKeys(strip(b), strip(l), strip(r), lNew);
  data.items = order.map(id => pick.get(id)).concat(extra);
  return {data, copies};
}
let mergeToastT = 0;
function mergeNote(copies){
  if(!copies) return;
  clearTimeout(mergeToastT);
  mergeToastT = setTimeout(() => toast(copies === 1 ? 'A text box was edited on two devices: both versions are on the page' : `${copies} text boxes were edited on two devices: both versions are on the page`), 300);
}
// The open page: merge into what is on screen, so the next save does not drop the other device's changes.
async function mergeCurrent(row, base){
  const c = cur;
  if(editing) syncEditingHTML();
  const lrec = await IDB.get('docs', row.id);
  const busy = !!((lrec && lrec.dirty) || saveContentSoon.pending() || editing || (c.crec && c.crec.dirty));
  let data, copies = 0;
  if(!busy){
    if(!base && lrec && lrec.updated >= row.updated_at) return false;
    data = row.data;
  } else {
    const local = {bg: c.bg, items: [...c.items.values()].map(ser)};
    if(c.lastId) local.last = c.lastId;
    if(lrec && lrec.data) for(const k of Object.keys(lrec.data)) if(!(k in local)) local[k] = lrec.data[k];
    await saveVersion(c.id, local, 'merge').catch(e => console.warn('version', e));
    const m = mergeContent(base && base.d, local, row.data, (lrec ? lrec.updated : Date.now()) > row.updated_at || !!editing);
    data = m.data; copies = m.copies;
  }
  const next = new Map();
  for(const s of data.items || []){ const it = deser(s); if(it && it.id) next.set(it.id, it); }
  if(editing && c.items.has(editing.id)) next.set(editing.id, c.items.get(editing.id));   // never pull the box being typed in
  for(const [id, it] of next){
    const old = c.items.get(id);
    if(old && stable(ser(old)) === stable(ser(it))) next.set(id, old);
  }
  for(const id of c.items.keys()) if(!next.has(id)){ geo.delete(id); dropEl(id); }
  c.items = next;
  for(const it of next.values()) if(it.t !== 's') itemEl(it);
  if(stable(data.bg) !== stable(c.bg)){ c.bg = normBg(data.bg); renderPaper(); }
  if(typeof data.last === 'string') c.lastId = data.last;
  c.lx = undefined; slPages = null;
  if(sel){ computeSel(); if(sel) positionOverlays(); }
  invalidate(); refreshPaper();
  if(!busy){
    const rec = {id: row.id, kind: row.kind, data: row.data, deleted: false, updated: row.updated_at, dirty: 0};
    await IDB.put('docs', rec);
    c.crec = rec;
  } else {
    await saveContent();
  }
  await baseSet(row.id, row.data, row.server_ts);
  searchCache = null;
  mergeNote(copies);
  return true;
}
async function applyRemote(row){
  const local = await IDB.get('docs', row.id);
  const mk = MERGE_KINDS.has(row.kind);
  const base = mk ? await baseGet(row.id) : null;
  if(base && base.ts && base.ts === row.server_ts) return false;   // this device's own upload
  if(mk && local && local.data && row.data && !local.deleted && !row.deleted){
    if(row.kind === 'content' && cur && row.id === 'c_' + cur.id) return mergeCurrent(row, base);
    if(local.dirty){
      const lNew = local.updated > row.updated_at;
      if(row.kind === 'content') await saveVersion(row.id.slice(2), local.data, 'merge').catch(e => console.warn('version', e));
      const m = row.kind === 'content' ? mergeContent(base && base.d, local.data, row.data, lNew) : {data: mergeKeys(base && base.d, local.data, row.data, lNew), copies: 0};
      const rec = {id: row.id, kind: row.kind, data: m.data, deleted: false, updated: Math.max(local.updated, row.updated_at) + 1, dirty: 1};
      await IDB.put('docs', rec);
      if(inMap(rec.kind)) docs.set(rec.id, rec);
      await baseSet(row.id, row.data, row.server_ts);
      searchCache = null;
      mergeNote(m.copies);
      return true;
    }
    if(!base && local.updated >= row.updated_at) return false;
  } else if(local && local.updated >= row.updated_at) return false;
  const rec = {id: row.id, kind: row.kind, data: row.data ?? null, deleted: !!row.deleted, updated: row.updated_at, dirty: 0};
  await IDB.put('docs', rec);
  if(inMap(rec.kind)) docs.set(rec.id, rec);
  else if(cur && rec.id === 'c_' + cur.id) pendingCurrentReload = true;
  if(mk){ if(rec.data && !rec.deleted) await baseSet(row.id, rec.data, row.server_ts); else await baseDel(row.id); }
  searchCache = null;
  return true;
}
// once per device: docs already in sync get their current copy as the base for later merges
async function seedBases(){
  if(await IDB.get('meta', 'baseSeed')) return;
  for(const d of await IDB.all('docs')){
    if(!MERGE_KINDS.has(d.kind) || d.dirty || d.deleted || !d.data) continue;
    if(!(await baseGet(d.id))) await baseSet(d.id, d.data, null);
  }
  await IDB.put('meta', 1, 'baseSeed');
}
function remoteChanged(){
  renderNav(); renderList(); renderTemplates(); scanMarks().catch(() => {});
  if(!cur) return;
  const page = getDoc(cur.id);
  if(!page){ cur = null; showEmpty(); toast('This page was deleted on another device'); return; }
  if(document.activeElement !== $('title')) $('title').value = page.data.title || '';
  if(pendingCurrentReload && !act && !editing && !selDrag && Date.now() - lastLocalEdit > 2500 && !saveContentSoon.pending()){
    pendingCurrentReload = false;
    const keep = {...cam}, id = cur.id;
    cur = null;
    openPage(id, {keepStack: true}).then(() => { Object.assign(cam, keep); invalidate(); });
  }
}
function setStatus(){
  const el = $('status');
  let s = 'local', txt = 'On this device only';
  if(Sync.sb){
    if(!Sync.user){ s = 'local'; txt = 'Sync off: tap to sign in'; }
    else if(Sync.state === 'syncing'){ s = 'syncing'; txt = 'Syncing'; }
    else if(Sync.state === 'offline'){ s = 'local'; txt = 'Offline, will sync later'; }
    else if(Sync.state === 'warn'){ s = 'warn'; txt = Sync.msg || 'Sync problem'; }
    else if(Sync.state === 'synced'){ s = 'synced'; txt = 'Synced ' + hhmm(Sync.lastOk); }
  } else if(Sync.state === 'warn'){ s = 'warn'; txt = Sync.msg; }
  el.dataset.s = s;
  $('statusText').textContent = txt;
}

/* =====================================================================
   Ink geometry
   ===================================================================== */
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

function strokeShape(it){
  const p = it.p, n = p.length / 3, base = it.w / 2;
  const xs = new Array(n), ys = new Array(n), rs = new Array(n);
  for(let i = 0; i < n; i++){
    const mid = i > 0 && i < n - 1;
    xs[i] = mid ? (p[i*3-3] + 2*p[i*3] + p[i*3+3]) / 4 : p[i*3];
    ys[i] = mid ? (p[i*3-2] + 2*p[i*3+1] + p[i*3+4]) / 4 : p[i*3+1];
    const pr = mid ? (p[i*3-1] + 2*p[i*3+2] + p[i*3+5]) / 4 : p[i*3+2];
    rs[i] = it.hl ? base : Math.max(0.3, base * (0.3 + pr));
  }
  return {xs, ys, rs, n};
}
// Filled outline of a variable-width stroke, as a Path2D or an SVG path string.
function strokePath(it, svg){
  const {xs, ys, rs, n} = strokeShape(it);
  if(!n) return svg ? '' : new Path2D();
  let single = n === 1;
  if(!single){ let span = 0; for(let i = 1; i < n; i++) span = Math.max(span, Math.abs(xs[i]-xs[0]) + Math.abs(ys[i]-ys[0])); single = span < 0.6; }
  if(single){
    const r = rs[0];
    if(svg) return `M${r1(xs[0]-r)} ${r1(ys[0])}a${r1(r)} ${r1(r)} 0 1 0 ${r1(2*r)} 0a${r1(r)} ${r1(r)} 0 1 0 ${r1(-2*r)} 0Z`;
    const P = new Path2D(); P.arc(xs[0], ys[0], r, 0, Math.PI * 2); return P;
  }
  const L = [], R = [], A = [];
  let lnx = 0, lny = -1;
  for(let i = 0; i < n; i++){
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
  if(svg){
    let d = `M${r1(L[0][0])} ${r1(L[0][1])}`;
    for(let i = 1; i < n; i++) d += `L${r1(L[i][0])} ${r1(L[i][1])}`;
    const re = rs[n-1];
    d += `A${r1(re)} ${r1(re)} 0 0 0 ${r1(R[n-1][0])} ${r1(R[n-1][1])}`;
    for(let i = n - 2; i >= 0; i--) d += `L${r1(R[i][0])} ${r1(R[i][1])}`;
    d += `A${r1(rs[0])} ${r1(rs[0])} 0 0 0 ${r1(L[0][0])} ${r1(L[0][1])}Z`;
    return d;
  }
  const P = new Path2D();
  P.moveTo(L[0][0], L[0][1]);
  for(let i = 1; i < n; i++) P.lineTo(L[i][0], L[i][1]);
  P.arc(xs[n-1], ys[n-1], rs[n-1], A[n-1], A[n-1] - Math.PI, true);
  for(let i = n - 2; i >= 0; i--) P.lineTo(R[i][0], R[i][1]);
  P.arc(xs[0], ys[0], rs[0], A[0] + Math.PI, A[0], true);
  P.closePath();
  return P;
}
function strokeBox(it){
  const p = it.p; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for(let i = 0; i < p.length; i += 3){ const x = p[i], y = p[i+1]; if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; }
  const m = it.w / 2 + 1;
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}
const geo = new Map();
// imported pages/pictures (always shown light, also in dark mode)
function paperRects(){
  const r = [];
  if(cur) for(const it of cur.items.values()) if(it.t === 'i') r.push([it.x, it.y, it.x + it.w, it.y + it.h]);
  return r;
}
function onPaperAt(rects, x, y){ return rects.some(r => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]); }
function refreshPaper(){
  if(!cur) return;
  const rects = paperRects();
  for(const it of cur.items.values()){
    if(it.t !== 'x' && it.t !== 'm') continue;
    const el = elMap.get(it.id); if(!el) continue;
    const b = itemBox(it);
    el.classList.toggle('on-paper', onPaperAt(rects, (b[0] + b[2]) / 2, Math.min(b[1] + 14, (b[1] + b[3]) / 2)));
  }
}
function geoOf(it){
  let g = geo.get(it.id);
  if(g && g.it === it) return g;
  g = {it, path: strokePath(it, false), b: strokeBox(it)};
  geo.set(it.id, g);
  return g;
}

/* Colours: 'auto' ink is black on light paper and white on dark paper */
let tokens = {};
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => prefs.theme === 'dark' || (prefs.theme !== 'light' && darkMQ.matches);
function setThemeAttr(){
  const r = document.documentElement;
  if(prefs.theme === 'light' || prefs.theme === 'dark') r.dataset.theme = prefs.theme; else delete r.dataset.theme;
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m, i) => {
    if(prefs.theme === 'auto'){ m.media = i ? '(prefers-color-scheme: dark)' : '(prefers-color-scheme: light)'; m.content = i ? '#15191E' : '#F4F6F8'; }
    else { m.media = ''; m.content = prefs.theme === 'dark' ? '#15191E' : '#F4F6F8'; }
  });
}
setThemeAttr();
function readTokens(){
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  tokens = {fg: g('--fg'), rule: g('--rule'), ruleStrong: g('--rule-strong'), accent: g('--accent'), tape: g('--tape'), muted: g('--muted'), paper: g('--paper')};
}
function lum(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if(!m) return 0.5;
  const n = parseInt(m[1], 16);
  return 0.2126 * (n >> 16) / 255 + 0.7152 * (n >> 8 & 255) / 255 + 0.0722 * (n & 255) / 255;
}
// onPaper: drawn over an imported page/picture, which always stays light, so use light-mode ink there
function inkColor(c, print, onPaper){
  if(onPaper) print = true;
  const dark = !print && isDark();
  if(!c || c === 'auto') return print ? '#18212B' : tokens.fg;
  const l = lum(c);
  if(dark && l < 0.07) return tokens.fg;
  if(!dark && l > 0.93) return '#18212B';
  return c;
}

/* =====================================================================
   Stage, camera, rendering
   ===================================================================== */
const stage = $('stage'), bgCv = $('bg'), inkCv = $('ink'), liveCv = $('live');
const worldBack = $('worldBack'), worldFront = $('worldFront');
const bgCtx = bgCv.getContext('2d'), inkCtx = inkCv.getContext('2d'), liveCtx = liveCv.getContext('2d');
let W = 0, H = 0, dpr = 1, SR = {left: 0, top: 0};
const cam = {ox: 40, oy: 24, z: 1};
let cur = null;           // open page: {id, crec, bg, items: Map, undo, redo}
const elMap = new Map();  // item id -> DOM element (text, formula, image, tape)
const tHandle = document.createElement('div');
tHandle.id = 'tHandle'; tHandle.className = 't-handle'; tHandle.hidden = true; tHandle.title = 'Drag to change width';
stage.appendChild(tHandle);

const toWorld = (sx, sy) => [(sx - cam.ox) / cam.z, (sy - cam.oy) / cam.z];
const viewRect = () => [-cam.ox / cam.z, -cam.oy / cam.z, (W - cam.ox) / cam.z, (H - cam.oy) / cam.z];
const pt = e => [e.clientX - SR.left, e.clientY - SR.top];

function resize(){
  const r = stage.getBoundingClientRect();
  SR = r; W = r.width; H = r.height;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  for(const c of [bgCv, inkCv, liveCv]){
    c.width = Math.max(1, Math.round(W * dpr)); c.height = Math.max(1, Math.round(H * dpr));
    c.style.width = W + 'px'; c.style.height = H + 'px';
  }
  if(W > 0 && H > 0 && !rulerVisible()) centerRuler(false);
  renderRuler();
  invalidate();
}
new ResizeObserver(resize).observe(stage);
addEventListener('scroll', () => { SR = stage.getBoundingClientRect(); }, true);

let rafId = 0, need = {bg: 0, ink: 0, over: 0}, frontZ = 1;
function invalidate(bg = 1, ink = 1, over = 1){
  need.bg |= bg; need.ink |= ink; need.over |= over;
  if(!rafId) rafId = requestAnimationFrame(frame);
}
function frame(){
  rafId = 0;
  if(prefs.leftEdge && cur) clampLeft();
  const t = `translate(${cam.ox}px,${cam.oy}px) scale(${cam.z})`;
  worldBack.style.transform = t;
  // Typed text, formulas and tape are scaled one by one instead of as one big layer: iPad Safari
  // rasterises a big scaled layer at 1x and then stretches it, so text went blurry when zoomed in.
  worldFront.style.transform = `translate(${cam.ox}px,${cam.oy}px)`;
  if(cam.z !== frontZ){ frontZ = cam.z; for(const el of worldFront.children) frontXf(el); }
  $('zoomBtn').textContent = Math.round(cam.z * 100) + '%';
  if(need.bg) drawBg();
  if(need.ink) drawInk();
  if(need.over){ positionOverlays(); imgSoon(); renderSlider(); }
  need = {bg: 0, ink: 0, over: 0};
  if(act || WA.linger()) drawLive();   // the reference line follows the page while it is still showing
}
function drawBg(){
  bgCtx.setTransform(1, 0, 0, 1, 0, 0);
  bgCtx.clearRect(0, 0, bgCv.width, bgCv.height);
  if(!cur) return;
  const bg = cur.bg;
  if(bg.type === 'blank') return;
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let kx = 1, ky = 1;
  while(bg.sx * kx * cam.z < 7) kx *= 2;
  while(bg.sy * ky * cam.z < 7) ky *= 2;
  const stepX = bg.sx * kx, stepY = bg.sy * ky;
  const v = viewRect();
  const x0 = Math.floor(v[0] / stepX) * stepX, y0 = Math.floor(v[1] / stepY) * stepY;
  if(bg.type === 'dots'){
    bgCtx.fillStyle = tokens.ruleStrong;
    const r = clamp(cam.z * 1.1, 0.8, 1.8);
    for(let y = y0; y <= v[3]; y += stepY){
      const Y = y * cam.z + cam.oy;
      for(let x = x0; x <= v[2]; x += stepX) bgCtx.fillRect(x * cam.z + cam.ox - r, Y - r, 2 * r, 2 * r);
    }
    return;
  }
  bgCtx.strokeStyle = tokens.rule; bgCtx.lineWidth = 1;
  bgCtx.beginPath();
  for(let y = y0; y <= v[3]; y += stepY){ const Y = Math.round(y * cam.z + cam.oy) + 0.5; bgCtx.moveTo(0, Y); bgCtx.lineTo(W, Y); }
  if(bg.type === 'grid') for(let x = x0; x <= v[2]; x += stepX){ const X = Math.round(x * cam.z + cam.ox) + 0.5; bgCtx.moveTo(X, 0); bgCtx.lineTo(X, H); }
  bgCtx.stroke();
}
function drawInk(){
  inkCtx.setTransform(1, 0, 0, 1, 0, 0);
  inkCtx.clearRect(0, 0, inkCv.width, inkCv.height);
  if(!cur) return;
  inkCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
  const v = viewRect(), pages = paperRects();
  for(const pass of [1, 0]){
    for(const it of cur.items.values()){
      if(it.t !== 's' || (it.hl ? 1 : 0) !== pass) continue;
      const g = geoOf(it);
      if(g.b[2] < v[0] || g.b[0] > v[2] || g.b[3] < v[1] || g.b[1] > v[3]) continue;
      const paper = onPaperAt(pages, (g.b[0] + g.b[2]) / 2, (g.b[1] + g.b[3]) / 2);
      inkCtx.globalAlpha = (pass ? (isDark() && !paper ? 0.34 : 0.4) : 1) * opOf(it);
      inkCtx.fillStyle = inkColor(it.c, false, paper);
      inkCtx.fill(g.path);
    }
  }
  inkCtx.globalAlpha = 1;
  // one small bookmark at the top right of every marked spot
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  inkCtx.fillStyle = MARK_C;
  for(const g of clusterMarks([...cur.items.values()])){
    const b = g.b;
    if(b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3]) continue;
    const x = b[2] * cam.z + cam.ox - 4, y = b[1] * cam.z + cam.oy - 8;
    inkCtx.beginPath(); inkCtx.moveTo(x, y); inkCtx.lineTo(x + 10, y); inkCtx.lineTo(x + 10, y + 14); inkCtx.lineTo(x + 5, y + 10.5); inkCtx.lineTo(x, y + 14); inkCtx.closePath(); inkCtx.fill();
  }
}

/* Imported pages/photos: only the ones on or near the screen hold a decoded picture.
   A long imported book (100+ pages) would otherwise need several GB and crash the iPad. */
const MAX_IMGS = 8;
let imgTimer = 0;
function imgSoon(){ if(!imgTimer) imgTimer = setTimeout(() => { imgTimer = 0; updateImages(); }, 120); }
function updateImages(){
  if(!cur) return;
  const v = viewRect(), mw = (v[2] - v[0]) * 0.25, mh = (v[3] - v[1]) * 0.75, cx = (v[0] + v[2]) / 2, cy = (v[1] + v[3]) / 2;
  const cand = [];
  for(const it of cur.items.values()){
    if(it.t !== 'i') continue;
    const el = elMap.get(it.id); if(!el) continue;
    const near = !(it.x + it.w < v[0] - mw || it.x > v[2] + mw || it.y + it.h < v[1] - mh || it.y > v[3] + mh);
    cand.push([near ? Math.hypot(Math.max(it.x - cx, 0, cx - it.x - it.w), Math.max(it.y - cy, 0, cy - it.y - it.h)) : Infinity, el]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  cand.forEach(([d, el], i) => {
    el._want = d < Infinity && i < MAX_IMGS;
    if(el._want) loadImg(el);
    else if(el._loaded || el._img) unloadImg(el, d < Infinity);
  });
}
function loadImg(el){
  if(el._loaded || el._loading) return;
  const a = el._a; el._loading = true;
  if(el._msg){ el._msg.hidden = false; el._msg.textContent = 'Loading'; }
  assetURL(a).then(u => {
    el._loading = false;
    if(el._a !== a || !el._want || !el.isConnected) return;
    if(!u){ el._msg.textContent = 'Not downloaded yet'; return; }
    const img = new Image(); img.decoding = 'async'; img.src = u; img.draggable = false; img.alt = '';
    img.style.cssText = 'width:100%;height:100%;display:block;border-radius:2px';
    el.insertBefore(img, el.firstChild); el._img = img; el._loaded = true;
    if(el._msg) el._msg.hidden = true;
    el.classList.remove('missing');
    if(!lineReady.has(a)) setTimeout(() => { if(el._loaded) pageLines(a); }, 400);
  }, () => { el._loading = false; });
}
function unloadImg(el, visible){
  if(el._img){ el._img.removeAttribute('src'); el._img.remove(); el._img = null; }
  el._loaded = false; el.classList.add('missing');
  if(el._msg){ el._msg.hidden = false; el._msg.textContent = visible ? 'Zoom in to show this page' : 'Loading'; }
}

/* DOM items: text boxes, formulas, imported pages/photos, tape */
// Text box HTML (since 1.26 an allowlist): known formatting tags stay, unknown tags are unwrapped (their text stays),
// anything that can run code, load something or embed another document is removed with its contents.
const CLEAN_KEEP = new Set('A B STRONG I EM U S STRIKE DEL INS SUB SUP BR P DIV SPAN H1 H2 H3 H4 H5 H6 UL OL LI FONT MARK SMALL BIG TT TABLE THEAD TBODY TFOOT TR TD TH CAPTION COLGROUP COL BLOCKQUOTE PRE CODE HR Q CITE ABBR KBD SAMP VAR DFN CENTER WBR'.split(' '));
const CLEAN_DROP = new Set('SCRIPT STYLE IFRAME FRAME FRAMESET OBJECT EMBED APPLET LINK META BASE IMG PICTURE SOURCE VIDEO AUDIO TRACK CANVAS SVG MATH FORM INPUT BUTTON SELECT OPTION OPTGROUP TEXTAREA TEMPLATE NOSCRIPT NOEMBED NOFRAMES PORTAL TITLE HEAD XMP PLAINTEXT DIALOG SLOT'.split(' '));
const CLEAN_ATTR = new Set(['class', 'style', 'colspan', 'rowspan', 'color', 'face', 'size', 'align', 'valign', 'dir', 'title', 'start', 'type']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';
function cleanStyle(n){
  const keep = (n.getAttribute('style') || '').split(';').filter(d => d.trim() && !/url\s*\(|expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding|^\s*position\s*:/i.test(d));
  if(keep.length) n.setAttribute('style', keep.join(';')); else n.removeAttribute('style');
}
function cleanNode(parent){
  for(const n of [...parent.childNodes]){
    if(n.nodeType === 8){ n.remove(); continue; }
    if(n.nodeType !== 1) continue;
    const tag = n.tagName.toUpperCase();
    if(n.namespaceURI !== HTML_NS || CLEAN_DROP.has(tag)){ n.remove(); continue; }
    cleanNode(n);
    if(!CLEAN_KEEP.has(tag) || (tag === 'A' && !n.classList.contains('pl'))){ n.replaceWith(...n.childNodes); continue; }
    for(const a of [...n.attributes]){
      const k = a.name.toLowerCase();
      if(k.startsWith('data-') ? !/^data-[a-z0-9-]+$/.test(k) : !CLEAN_ATTR.has(k)) n.removeAttribute(a.name);
    }
    if(n.hasAttribute('style')) cleanStyle(n);
  }
}
function cleanHTML(html){
  const t = document.createElement('template');   // template content is inert: nothing loads or runs while cleaning
  t.innerHTML = html || '';
  cleanNode(t.content);
  return t.innerHTML;
}
function htmlText(html){
  const t = document.createElement('template'); t.innerHTML = html || '';
  t.content.querySelectorAll('li,p,h1,h2,h3,h4,h5,h6,div,br,tr,td,th').forEach(n => n.after(' '));
  return t.content.textContent.replace(/\s+/g, ' ').trim();
}
function prepTextEl(el){
  el.querySelectorAll('a.pl').forEach(a => { a.setAttribute('contenteditable', 'false'); a.classList.toggle('broken', !getDoc(a.dataset.page)); });
}
// place an element of the front layer: its left/top are world units, the camera zoom is applied here
function frontXf(el){
  const z = cam.z, x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
  el.style.transform = z === 1 ? '' : `translate(${(z - 1) * x}px,${(z - 1) * y}px) scale(${z})`;
}
function itemEl(it){
  let el = elMap.get(it.id);
  const layer = it.t === 'i' ? worldBack : worldFront;
  if(!el){
    el = document.createElement('div');
    el.dataset.id = it.id;
    el.className = 'it';
    layer.appendChild(el);
    elMap.set(it.id, el);
  }
  el.style.left = it.x + 'px';
  el.style.top = it.y + 'px';
  el.style.opacity = opOf(it) < 1 ? String(opOf(it)) : '';
  if(layer === worldFront) frontXf(el);
  if(it.t === 'i'){
    el.classList.add('it-img');
    el.classList.toggle('doc', !!it.doc);
    el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
    if(el._a !== it.a){
      // the picture itself is only loaded while it is near the screen (see updateImages)
      if(el._img){ el._img.remove(); el._img = null; }
      el._a = it.a; el._loaded = false; el.classList.add('missing');
      for(const n of [...el.childNodes]) if(n !== el._pf) n.remove();
      const msg = document.createElement('span'); msg.textContent = 'Loading'; el.insertBefore(msg, el.firstChild); el._msg = msg;
      imgSoon();
    }
    if(it.f && it.f.length) syncFields(el, it);
    else if(el._pf){ el._pf.remove(); el._pf = null; }
  } else if(it.t === 'x'){
    el.classList.add('it-text');
    el.style.width = it.w + 'px';
    el.style.fontSize = (17 * (it.fs || 1)) + 'px';
    el.style.lineHeight = it.lh ? it.lh + 'px' : '';   // lh: text placed on a worksheet's answer lines
    el.classList.toggle('lh', !!it.lh);
    el.classList.toggle('cell', !!it.ch);
    if(!(editing && editing.id === it.id) && el._html !== it.html){
      el.innerHTML = cleanHTML(it.html);
      el._html = it.html;
      prepTextEl(el);
    }
  } else if(it.t === 'm'){
    el.classList.add('it-math');
    el.style.fontSize = (it.fs || 24) + 'px';
    el.style.color = it.c && it.c !== 'auto' ? inkColor(it.c) : '';
    if(el._tex !== it.tex){
      el._tex = it.tex;
      try { katex.render(it.tex || '\\square', el, {throwOnError: true, displayMode: true}); el.classList.remove('err'); }
      catch(e){ el.textContent = it.tex; el.classList.add('err'); }
    }
  } else if(it.t === 'tp'){
    el.classList.add('it-tape');
    el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
  }
  return el;
}
function dropEl(id){ const el = elMap.get(id); if(el){ el.remove(); elMap.delete(id); } }

/* ---------- Fillable PDF form fields (on imported PDF pages) ----------
   Stored on the image item as it.f = [{k, n, x, y, w, h, v, ...}]; x/y/w/h are fractions of the page.
   k: 'tx' text, 'cb' checkbox, 'rb' radio (ev = its value), 'ch' dropdown, 'ls' list (o = [[value, label]]).
   Fields can be clicked and typed into with a mouse (PC); on the iPad they only show their values. */
function fieldFont(f, it){
  if(f.s) return f.s * it.w;
  if(f.k === 'tx' && !f.ml || f.k === 'ch') return Math.min(f.h * it.h * 0.62, it.w * 0.0235);
  return it.w * 0.0202;
}
function makeField(f, i){
  let c;
  if(f.k === 'tx'){
    c = document.createElement(f.ml ? 'textarea' : 'input');
    if(!f.ml) c.type = 'text';
    if(f.mx) c.maxLength = f.mx;
    if(f.al) c.style.textAlign = f.al === 1 ? 'center' : 'right';
    c.spellcheck = false; c.autocomplete = 'off';
  } else if(f.k === 'cb' || f.k === 'rb'){
    c = document.createElement('input'); c.type = 'checkbox';
  } else {
    c = document.createElement('select');
    if(f.k === 'ls'){ c.size = Math.max(2, (f.o || []).length); if(f.ms) c.multiple = true; }
    else { const o = document.createElement('option'); o.value = ''; o.textContent = ''; c.appendChild(o); }
    for(const [v, l] of f.o || []){ const o = document.createElement('option'); o.value = v; o.textContent = l; c.appendChild(o); }
  }
  c.className = 'pf pf-' + f.k;
  c.dataset.i = i;
  if(f.ro) c.disabled = true;
  c.tabIndex = 0;
  Object.assign(c.style, {left: f.x * 100 + '%', top: f.y * 100 + '%', width: f.w * 100 + '%', height: f.h * 100 + '%'});
  return c;
}
function setFieldValue(c, f){
  if(f.k === 'tx'){ const v = f.v || ''; if(c.value !== v) c.value = v; }
  else if(f.k === 'cb') c.checked = !!f.v;
  else if(f.k === 'rb') c.checked = !!f.v && f.v === f.ev;
  else if(c.multiple){ const vs = Array.isArray(f.v) ? f.v : f.v ? [f.v] : []; for(const o of c.options) o.selected = vs.includes(o.value); }
  else { const v = Array.isArray(f.v) ? (f.v[0] || '') : (f.v || ''); c.value = v; if(c.value !== v) c.selectedIndex = -1; }
}
function syncFields(el, it){
  let L = el._pf;
  if(!L || L._n !== it.f.length){
    if(L) L.remove();
    L = el._pf = document.createElement('div');
    L.className = 'pf-layer'; L._n = it.f.length;
    it.f.forEach((f, i) => L.appendChild(makeField(f, i)));
    el.appendChild(L);
  }
  const ch = L.children;
  for(let i = 0; i < ch.length; i++){
    const c = ch[i], f = it.f[i];
    c.style.fontSize = fieldFont(f, it) + 'px';
    if(c !== document.activeElement) setFieldValue(c, f);
  }
}
function fieldValueOf(c, f){
  if(f.k === 'tx') return c.value;
  if(f.k === 'cb') return c.checked;
  if(f.k === 'rb') return c.checked ? f.ev : '';
  if(c.multiple) return [...c.selectedOptions].map(o => o.value);
  return c.value;
}
function fieldText(it){
  let t = '';
  for(const f of it.f || []){
    if(f.k === 'tx' && f.v) t += ' ' + f.v;
    else if((f.k === 'ch' || f.k === 'ls') && f.v && f.v.length){
      const vs = Array.isArray(f.v) ? f.v : [f.v];
      t += ' ' + vs.map(v => { const o = (f.o || []).find(o => o[0] === v); return o ? o[1] : v; }).join(' ');
    }
  }
  return t;
}
let pfEdit = null;   // {id, before}: the item as it was when the field got focus (one undo step per field edit)
function pfTarget(e){
  const c = e.target && e.target.closest && e.target.closest('.pf');
  if(!c || !cur) return null;
  const host = c.closest('.it'); const it = host && cur.items.get(host.dataset.id);
  return it && it.f ? {c, it, i: +c.dataset.i} : null;
}
function pfUpdate(e){
  const t = pfTarget(e); if(!t) return;
  const f = t.it.f[t.i]; if(!f) return;
  let v = fieldValueOf(t.c, f);
  let list;
  if(f.k === 'rb'){
    if(!t.c.checked && f.v === f.ev) v = '';            // clicking the chosen radio again clears the group
    list = t.it.f.map(g => g.k === 'rb' && g.n === f.n ? Object.assign({}, g, {v}) : g);
  } else {
    if(JSON.stringify(v) === JSON.stringify(f.v)) return;
    list = t.it.f.slice(); list[t.i] = Object.assign({}, f, {v});
  }
  const nit = Object.assign({}, t.it, {f: list});
  if(!pfEdit || pfEdit.id !== nit.id) pfEdit = {id: nit.id, before: t.it};
  setItems([[nit.id, nit]]);
  if(f.k === 'rb'){ const L = elMap.get(nit.id); L && L._pf && [...L._pf.children].forEach((c, i) => setFieldValue(c, list[i])); }
}
function pfCommit(){
  if(!pfEdit || !cur) return;
  const now = cur.items.get(pfEdit.id);
  if(now && now !== pfEdit.before){ commit([[pfEdit.id, pfEdit.before]], [[pfEdit.id, now]]); pfEdit.before = now; }
}
worldBack.addEventListener('focusin', e => {
  const t = pfTarget(e); if(!t) return;
  pfEdit = {id: t.it.id, before: t.it};
  // keep the field on screen (Tab can jump to a field outside the view)
  const r = t.c.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  let dx = 0, dy = 0;
  if(r.right > sr.right - 20) dx = sr.right - 20 - r.right;
  if(r.left + dx < sr.left + 20) dx = sr.left + 20 - r.left;
  if(r.bottom > sr.bottom - 20) dy = sr.bottom - 20 - r.bottom;
  if(r.top + dy < sr.top + 20) dy = sr.top + 20 - r.top;
  if(dx || dy){ cam.ox += dx; cam.oy += dy; invalidate(); saveCamSoon(); }
});
worldBack.addEventListener('input', pfUpdate);
worldBack.addEventListener('change', e => { pfUpdate(e); if(pfTarget(e)) pfCommit(); });
worldBack.addEventListener('focusout', e => {
  const t = pfTarget(e); if(!t) return;
  pfCommit(); pfEdit = null;
  const it = cur.items.get(t.it.id); if(it && it.f && it.f[t.i]) setFieldValue(t.c, it.f[t.i]);
});
worldBack.addEventListener('keydown', e => {
  if(e.key === 'Enter' && e.target.matches && e.target.matches('input.pf')){ e.preventDefault(); e.target.blur(); }
});
// focusing a field must never scroll the stage itself
stage.addEventListener('scroll', () => { if(stage.scrollTop || stage.scrollLeft){ stage.scrollTop = 0; stage.scrollLeft = 0; } });
function itemBox(it){
  if(it.t === 's') return geoOf(it).b;
  if(it.t === 'i' || it.t === 'tp') return [it.x, it.y, it.x + it.w, it.y + it.h];
  const el = elMap.get(it.id);
  const w = el ? el.offsetWidth : (it.w || 100), h = el ? el.offsetHeight : 30;
  return [it.x, it.y, it.x + w, it.y + h];
}
function contentBox(){
  if(!cur || !cur.items.size) return null;
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for(const it of cur.items.values()){ const q = itemBox(it); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; }
  return b;
}

/* =====================================================================
   Edits and undo
   ===================================================================== */
function setItems(pairs){
  for(const [id, it] of pairs){
    if(it){ cur.items.set(id, it); if(it.t !== 's') itemEl(it); cur.lastId = id; }
    else { cur.items.delete(id); geo.delete(id); dropEl(id); }
  }
  changed();
}
function commit(before, after){
  cur.undo.push({b: before, a: after});
  if(cur.undo.length > 300) cur.undo.shift();
  cur.redo.length = 0;
  updUndo();
}
function apply(after, before){ setItems(after); commit(before, after); }
function addItems(list){ apply(list.map(it => [it.id, it]), list.map(it => [it.id, null])); }
function removeItems(ids){ const before = ids.map(id => [id, cur.items.get(id) || null]); apply(ids.map(id => [id, null]), before); }
function replaceItems(list){ const before = list.map(it => [it.id, cur.items.get(it.id) || null]); apply(list.map(it => [it.id, it]), before); }
function undo(){
  if(!cur) return;
  if(editing) finishEditing();
  const op = cur.undo.pop(); if(!op) return;
  setItems(op.b); cur.redo.push(op); clearSel(); updUndo();
}
function redo(){
  if(!cur) return;
  const op = cur.redo.pop(); if(!op) return;
  setItems(op.a); cur.undo.push(op); clearSel(); updUndo();
}
function updUndo(){ $('undo').disabled = !cur || !cur.undo.length; $('redo').disabled = !cur || !cur.redo.length; }
function changed(){ if(cur) cur.lx = undefined; slPages = null; lastLocalEdit = Date.now(); invalidate(0, 1, 1); saveContentSoon(); refreshPaper(); markBadgeSoon(); hwSoon(); }

async function saveContent(){
  if(!cur) return;
  const c = cur;
  const items = [...c.items.values()].map(ser);
  const rec = c.crec || {id: 'c_' + c.id, kind: 'content', deleted: false};
  const prev = rec.data;
  if(prev && c.verAt !== undefined && Date.now() - c.verAt > VER_GAP){ c.verAt = Date.now(); saveVersion(c.id, prev).catch(e => console.warn('version', e)); }
  rec.data = {bg: c.bg, items};
  if(c.lastId) rec.data.last = c.lastId;
  c.crec = rec;
  await writeDoc(rec);
  const page = getDoc(c.id);
  if(page){
    let snip = '';
    for(const it of items){ if(it.t === 'x') snip += ' ' + htmlText(it.html); else if(it.t === 'm') snip += ' ' + it.tex; if(snip.length > 200) break; }
    snip = snip.trim();
    const ttl = (page.data.title || '').trim();
    if(ttl && snip.toLowerCase().startsWith(ttl.toLowerCase())) snip = snip.slice(ttl.length).replace(/^[\s:.,\-–—]+/, '');
    await patchDoc(page, {snippet: snip.slice(0, 160)});
    refreshPageItem(c.id);
  }
}
const saveContentSoon = debounce(() => saveContent(), 700);
async function flushSaves(){
  if(editing) syncEditingHTML();
  await saveContentSoon.flush();
  await saveTitleSoon.flush();
  if(cur) LSset('inkwell.cam.' + cur.id, {ox: cam.ox, oy: cam.oy, z: cam.z});
}

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
  if(e.target.closest('.sel-menu,.fmt,.sel-rect,#tHandle')) return;
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
      if(performance.now() - t.t < 500) tapAt(t.target, sx, sy);
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
    if(act.kind === 'stroke' && act.pts.length >= 6) endTool(e); else cancelAct();
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
    act.kind = 'lasso'; act.poly = [sx, sy];
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
      if(Math.hypot(sx - act.anchor[0], sy - act.anchor[1]) > 3){ act.anchor = [sx, sy]; armHold(); }
    } else if(act.kind === 'erase'){ act.cursor = [sx, sy]; eraseAt(sx, sy); }
    else if(act.kind === 'space'){ moveSpace(toWorld(sx, sy)[1] - act.y0); }
    else if(act.kind === 'lasso'){ act.poly.push(sx, sy); }
    else if(act.kind === 'tape' || act.kind === 'place' || act.kind === 'pick'){ act.w1 = toWorld(sx, sy); if(act.kind === 'pick') compassTrack(act); }
  }
  drawLiveSoon();
}
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
function clearLive(){ liveCtx.setTransform(1, 0, 0, 1, 0, 0); liveCtx.clearRect(0, 0, liveCv.width, liveCv.height); }
function drawLive(){
  clearLive();
  if(!act){ WA.drawAfter(); return; }
  if(act.kind === 'stroke'){
    liveCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
    const paper = onPaperAt(paperRects(), act.pts[0], act.pts[1]);
    liveCtx.globalAlpha = act.hl ? (isDark() && !paper ? 0.34 : 0.4) : 1;
    liveCtx.fillStyle = inkColor(act.c, false, paper);
    liveCtx.fill(strokePath({t: 's', c: act.c, w: act.w, hl: act.hl, p: act.pts}, false));
    liveCtx.globalAlpha = 1;
    if(act.tool === 'pen' && !act.hl && !act.mk) WA.guide(act);
  } else if(act.kind === 'lasso'){
    const p = act.poly;
    liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    liveCtx.beginPath(); liveCtx.moveTo(p[0], p[1]);
    for(let i = 2; i < p.length; i += 2) liveCtx.lineTo(p[i], p[i+1]);
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

/* =====================================================================
   Reference line (1.42, pen options → Writing menu, prefs.refLine). Replaces the 1.41 "Keep lines level"
   and "Even word spacing", which moved your strokes; nothing is moved any more.
   While you write with the pen, a faint dashed line appears under the line you are writing, at the height
   of its first word, so you can keep the rest of the line straight yourself. It stays for a few seconds
   after you lift the pen, then fades. Strokes stay exactly as written. State lives on cur (cur.wa).
   ===================================================================== */
const REF_LINGER = 4000, REF_FADE = 1200;
const WA = {
  last: null,   // {page, L, at}: the line written on last, for the guide after the pen is lifted
  on(){ return !!prefs.refLine; },
  st(){ if(!cur) return null; if(!cur.wa) cur.wa = {lines: []}; return cur.wa; },
  q(arr, f){ if(!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * f)))]; },
  box(p){ let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for(let i = 0; i < p.length; i += 3){ const x = p[i], y = p[i+1]; if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; } return [x0, y0, x1, y1]; },
  // A line: base = where the letters sit (median bottom of its first few letter-sized strokes, so one
  // descender like g or y does not move it), h = typical letter height. Dots, i-dots and t-bars never set it.
  mid(L){ return L.base - 0.5 * L.h; },
  small(h, w, L){ return L ? h < 0.45 * L.h : (h * cam.z < 10 || (h < 0.35 * w && h * cam.z < 16)); },
  findLine(st, b){
    const m = (b[1] + b[3]) / 2, h = b[3] - b[1], w = b[2] - b[0]; let best = null, bd = Infinity;
    for(const L of st.lines){
      if(b[0] < L.left - 2 * L.h || b[0] > L.right + 12 * L.h) continue;
      const d = m - this.mid(L);
      // dots and crossbars may sit well above the letters
      const ok = this.small(h, w, L) ? d > -2.2 * L.h && d < 1.1 * L.h : Math.abs(d) <= 1.1 * L.h;
      if(ok && Math.abs(d) < bd){ bd = Math.abs(d); best = L; }
    }
    return best;
  },
  // each finished pen stroke: find or start its line (only read, never changed)
  stroke(it){
    if(!this.on() || !cur || it.p.length < 6) return;
    const st = this.st();
    const b = this.box(it.p), w = b[2] - b[0], h = b[3] - b[1];
    let L = this.findLine(st, b);
    if(!L){
      if(h * cam.z > 200 || w * cam.z > 500) return;   // a drawing, not writing
      if(this.small(h, w, null)) return;                // a dot or dash on its own does not start a line
      L = {base: b[3], bots: [b[3]], h, hs: [h], left: b[0], right: b[2]};
      st.lines.push(L); if(st.lines.length > 8) st.lines.shift();
    } else {
      if(h > 3 * L.h || w > 8 * L.h) return;   // a drawing or a line across: not part of the writing
      L.left = Math.min(L.left, b[0]); L.right = Math.max(L.right, b[2]);
      if(!this.small(h, w, L)){
        L.hs.push(h); if(L.hs.length > 40) L.hs.shift();
        L.h = Math.max(this.q(L.hs, 0.5), 6 / cam.z);
        if(L.bots.length < 5){ L.bots.push(b[3]); L.base = this.q(L.bots, 0.5); }
      }
    }
    this.last = {page: cur.id, L, at: Date.now()};
    drawLiveSoon();
  },
  // after the pen is lifted the guide stays a moment, then fades
  linger(){
    const l = this.last;
    if(!l || !this.on() || !cur || l.page !== cur.id) return 0;
    const t = Date.now() - l.at;
    return t < REF_LINGER ? 1 : t < REF_LINGER + REF_FADE ? 1 - (t - REF_LINGER) / REF_FADE : 0;
  },
  drawAfter(){
    const f = this.linger(); if(!f) return;
    liveCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
    this.line(this.last.L, this.last.L.right, f);
    clearTimeout(this.tm);
    this.tm = setTimeout(drawLiveSoon, f < 1 ? 50 : REF_LINGER - (Date.now() - this.last.at) + 10);
  },
  // while writing: the line under the stroke being written (live canvas already in world units)
  guide(a){
    if(!this.on() || !cur || !cur.wa || a.pts.length < 3) return;
    // the line this stroke is near; while a dot or bar is being drawn above, keep showing the line just written
    let L = this.findLine(cur.wa, [a.pts[0], a.pts[1], a.pts[0], a.pts[1]]);
    const l = this.last;
    if(l && l.page === cur.id){
      const d = a.pts[1] - this.mid(l.L);
      if(d > -2.5 * l.L.h && d < 1.2 * l.L.h && a.pts[0] > l.L.left - 2 * l.L.h && a.pts[0] < l.L.right + 12 * l.L.h) L = l.L;
    }
    if(!L) return;
    this.line(L, Math.max(L.right, a.pts[a.pts.length - 3]), 1);
  },
  line(L, right, f){
    const y = L.base + 2 / cam.z;   // just under the bottom of the letters
    liveCtx.save();
    liveCtx.globalAlpha = 0.45 * f; liveCtx.strokeStyle = tokens.accent; liveCtx.lineWidth = 1.2 / cam.z;
    liveCtx.setLineDash([6 / cam.z, 5 / cam.z]);
    liveCtx.beginPath(); liveCtx.moveTo(L.left - L.h, y); liveCtx.lineTo(right + 8 * L.h, y); liveCtx.stroke();
    liveCtx.restore();
  }
};

/* eraser: 'stroke' removes whole strokes it touches, 'area' (partial) rubs out only the ink under it */
function eraseAt(sx, sy){
  const R = eraserRadius() / cam.z;
  const [wx, wy] = toWorld(sx, sy);
  // fill the gap since the last position so fast moves don't skip ink
  const last = act.lastW; act.lastW = [wx, wy];
  if(last){
    const d = Math.hypot(wx - last[0], wy - last[1]), n = Math.floor(d / (R * 0.5));
    for(let k = 1; k <= n; k++){ const t = k / (n + 1); eraseWorld(last[0] + (wx - last[0]) * t, last[1] + (wy - last[1]) * t, R); }
  }
  eraseWorld(wx, wy, R);
}
// Formulas (graph numbers and labels too) are erased whole by both eraser modes.
function eraseFormulas(wx, wy, R){
  let hit = false;
  for(const it of [...cur.items.values()]){
    if(it.t !== 'm') continue;
    const b = itemBox(it), cx = clamp(wx, b[0], b[2]), cy = clamp(wy, b[1], b[3]);
    if((cx - wx) ** 2 + (cy - wy) ** 2 > R * R) continue;
    act.removed.push(it); cur.items.delete(it.id); dropEl(it.id); hit = true;
  }
  if(hit) changed();
}
// Text boxes (typed or made by Write to text): the Stroke eraser removes the whole box it touches,
// the Partial eraser removes only the words it passes over.
function eraseTexts(wx, wy, R){
  let hit = false;
  for(const it of [...cur.items.values()]){
    if(it.t !== 'x' || (editing && editing.id === it.id)) continue;
    const b = itemBox(it), cx = clamp(wx, b[0], b[2]), cy = clamp(wy, b[1], b[3]);
    if((cx - wx) ** 2 + (cy - wy) ** 2 > R * R) continue;
    const el = elMap.get(it.id); if(!el) continue;
    if(act.mode !== 'area'){
      act.removed.push(it); cur.items.delete(it.id); dropEl(it.id); act.added.delete(it.id); hit = true; continue;
    }
    // words under the eraser circle (centre and a ring of sample points), found from screen positions
    const sx0 = SR.left + cam.ox, sy0 = SR.top + cam.oy, rs = R * cam.z, cut = new Map();
    for(const [dx, dy] of [[0, 0]]){   // the word under the eraser's centre; fast moves are filled in by eraseAt
      const x = sx0 + (wx + dx * R) * cam.z, y = sy0 + (wy + dy * R) * cam.z;
      const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
      const node = r && r.startContainer;
      if(!node || node.nodeType !== 3 || !el.contains(node) || (node.parentElement && node.parentElement.closest('[data-er]'))) continue;
      const t = node.data, k = Math.min(r.startOffset, t.length);
      // the caret lands between letters: take the word around it, only if a letter is really under the point
      let a = k, z = k;
      while(a > 0 && !/\s/.test(t[a - 1])) a--;
      while(z < t.length && !/\s/.test(t[z])) z++;
      if(z <= a) continue;
      const rr = document.createRange(); rr.setStart(node, a); rr.setEnd(node, z);
      const box = rr.getBoundingClientRect();
      const tol = Math.min(rs * 0.35, 6);
      if(x < box.left - tol || x > box.right + tol || y < box.top - tol || y > box.bottom + tol) continue;
      if(!cut.has(node)) cut.set(node, []);
      cut.get(node).push([a, z]);
    }
    if(!cut.size) continue;
    // erased words are only hidden while the pen is down, so the rest of the line does not slide under it;
    // finishTextErase() removes them when the pen lifts
    for(const [node, spans] of cut){
      spans.sort((p, q) => q[0] - p[0]);
      let last = Infinity;
      for(const [a, z] of spans){
        if(z > last) continue;
        const rr = document.createRange(); rr.setStart(node, a); rr.setEnd(node, z);
        const sp = document.createElement('span'); sp.dataset.er = '1'; sp.style.visibility = 'hidden';
        try { rr.surroundContents(sp); } catch { continue; }
        last = a;
      }
    }
    const orig = act.removed.find(r => r.id === it.id) || it;
    if(!act.removed.includes(orig)) act.removed.push(orig);
    (act.texts || (act.texts = new Set())).add(it.id);
  }
  if(hit) changed();
}
function finishTextErase(a){
  if(!a.texts) return;
  for(const id of a.texts){
    const it = cur.items.get(id), el = elMap.get(id); if(!it || !el) continue;
    el.querySelectorAll('[data-er]').forEach(n => n.remove());
    el.normalize();
    // tidy the spaces the removed words leave behind
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for(let n = w.nextNode(); n; n = w.nextNode()) n.data = n.data.replace(/ {2,}/g, ' ');
    const html = cleanHTML(el.innerHTML).replace(/<p> /g, '<p>').replace(/ <\/p>/g, '</p>');
    if(!htmlText(html).trim()){ a.added.delete(id); cur.items.delete(id); dropEl(id); continue; }   // last word gone: the box goes
    const nx = Object.assign({}, it, {html});
    cur.items.set(id, nx); a.added.set(id, nx); el._html = null; itemEl(nx);
  }
  changed();
}
function eraseWorld(wx, wy, R){
  eraseFormulas(wx, wy, R);
  eraseTexts(wx, wy, R);
  if(act.mode === 'area'){ eraseArea(wx, wy, R); return; }
  let hit = false;
  for(const it of [...cur.items.values()]){
    if(it.t !== 's') continue;
    const g = geoOf(it), pad = R + it.w / 2;
    if(wx < g.b[0] - pad || wx > g.b[2] + pad || wy < g.b[1] - pad || wy > g.b[3] + pad) continue;
    const lim = pad * pad, p = it.p;
    let touched = false;
    for(let i = 0; i < p.length && !touched; i += 3){
      const dx = p[i] - wx, dy = p[i+1] - wy;
      if(dx * dx + dy * dy <= lim) touched = true;
      else if(i + 3 < p.length && segDist2(wx, wy, p[i], p[i+1], p[i+3], p[i+4]) <= lim) touched = true;
    }
    if(touched){ act.removed.push(it); cur.items.delete(it.id); geo.delete(it.id); hit = true; }
  }
  if(hit) changed();
}
function eraseArea(wx, wy, R){
  let hit = false;
  for(const it of [...cur.items.values()]){
    if(it.t !== 's') continue;
    const g = geoOf(it), pad = R + it.w / 2;
    if(wx < g.b[0] - pad || wx > g.b[2] + pad || wy < g.b[1] - pad || wy > g.b[3] + pad) continue;
    const cut = R + it.w * 0.35, lim = cut * cut, p = it.p;
    // densify only the segments near the eraser, so the cut is clean even on long straight lines
    const step = Math.max(0.4, cut * 0.35), q = [];
    let near = false;
    for(let i = 0; i < p.length; i += 3){
      q.push(p[i], p[i+1], p[i+2]);
      if(i + 3 >= p.length) break;
      const d2 = segDist2(wx, wy, p[i], p[i+1], p[i+3], p[i+4]);
      if(d2 > lim * 4) continue;
      near = true;
      const len = Math.hypot(p[i+3] - p[i], p[i+4] - p[i+1]), n = Math.floor(len / step);
      for(let k = 1; k < n; k++){ const t = k / n; q.push(p[i] + (p[i+3] - p[i]) * t, p[i+1] + (p[i+4] - p[i+1]) * t, p[i+2] + (p[i+5] - p[i+2]) * t); }
    }
    if(!near && p.length > 3) continue;
    // split into the runs of points that stay
    const pieces = []; let run = [], gone = false;
    for(let i = 0; i < q.length; i += 3){
      const dx = q[i] - wx, dy = q[i+1] - wy;
      if(dx * dx + dy * dy <= lim){ gone = true; if(run.length) pieces.push(run); run = []; }
      else run.push(q[i], q[i+1], q[i+2]);
    }
    if(run.length) pieces.push(run);
    if(!gone) continue;
    hit = true;
    cur.items.delete(it.id); geo.delete(it.id);
    if(act.added.has(it.id)) act.added.delete(it.id); else act.removed.push(it);
    for(const pp of pieces){
      if(pp.length < 6) continue;   // a lone point is just a crumb
      const np = {t: 's', id: 's' + newId(), c: it.c, w: it.w, hl: it.hl, p: pp};
      if(it.mk){ np.mk = 1; if(it.at) np.at = it.at; }
      if(it.g) np.g = it.g;
      if(it.o) np.o = it.o;
      cur.items.set(np.id, np); act.added.set(np.id, np);
    }
  }
  if(hit) changed();
}
function segDist2(px, py, ax, ay, bx, by){
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = clamp(t, 0, 1);
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}

/* ---------- shape snapping: hold the pen still at the end of a stroke ---------- */
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function trySnap(a){
  const p = a.pts; if(p.length < 15) return;
  const P = []; for(let i = 0; i < p.length; i += 3) P.push([p[i], p[i+1]]);
  const s = recognize(P);
  if(!s) return;
  a.snapped = s.kind;
  if(s.kind === 'line') a.lineStart = s.pts[0];
  a.pts = densify(s.pts, s.closed);
  drawLive();
}
function densify(V, closed){
  const step = 2 / cam.z, out = [];
  const pts = closed ? V.concat([V[0]]) : V;
  for(let i = 0; i < pts.length - 1; i++){
    const a = pts[i], b = pts[i + 1], d = dist(a, b), n = Math.max(1, Math.ceil(d / step));
    for(let k = 0; k < n; k++) out.push(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, 0.55);
  }
  const l = pts[pts.length - 1]; out.push(l[0], l[1], 0.55);
  return out;
}
function rdp(P, eps){
  if(P.length < 3) return P.slice();
  let idx = 0, dm = 0;
  const a = P[0], b = P[P.length - 1];
  for(let i = 1; i < P.length - 1; i++){ const d = Math.sqrt(segDist2(P[i][0], P[i][1], a[0], a[1], b[0], b[1])); if(d > dm){ dm = d; idx = i; } }
  if(dm > eps){ const l = rdp(P.slice(0, idx + 1), eps), r = rdp(P.slice(idx), eps); return l.slice(0, -1).concat(r); }
  return [a, b];
}
function cleanCorners(V){
  // remove vertices that are almost straight (closed polygon)
  let changedAny = true;
  while(changedAny && V.length > 3){
    changedAny = false;
    for(let i = 0; i < V.length; i++){
      const p = V[(i - 1 + V.length) % V.length], c = V[i], n = V[(i + 1) % V.length];
      const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]), a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
      let d = Math.abs(a2 - a1); if(d > Math.PI) d = 2 * Math.PI - d;
      if(d < 0.45 || dist(p, c) < 1e-3){ V.splice(i, 1); changedAny = true; break; }
    }
  }
  return V;
}
function recognize(P){
  const n = P.length;
  let L = 0; for(let i = 1; i < n; i++) L += dist(P[i-1], P[i]);
  if(L < 24 / cam.z) return null;
  const a = P[0], b = P[n - 1], chord = dist(a, b);
  let maxDev = 0; for(const q of P) maxDev = Math.max(maxDev, Math.sqrt(segDist2(q[0], q[1], a[0], a[1], b[0], b[1])));
  if(chord > 0.85 * L && maxDev < Math.max(6 / cam.z, chord * 0.06)) return {kind: 'line', pts: [a, b]};
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for(const q of P){ x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  const bw = x1 - x0, bh = y1 - y0, diag = Math.hypot(bw, bh);
  if(diag < 16 / cam.z) return null;
  if(chord < 0.22 * diag){
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(bw / 2, 1e-3), ry = Math.max(bh / 2, 1e-3);
    let err = 0; for(const q of P) err += Math.abs(Math.hypot((q[0] - cx) / rx, (q[1] - cy) / ry) - 1); err /= n;
    let V = rdp(P.concat([P[0]]), diag * 0.07); V.pop();
    V = cleanCorners(V);
    const k = V.length;
    if(err < 0.09 && k >= 4 || err < 0.06) return ellipse(cx, cy, rx, ry);
    if(k === 3) return {kind: 'tri', pts: V, closed: true};
    if(k === 4){
      let aligned = true;
      for(let i = 0; i < 4; i++){ const p = V[i], q = V[(i + 1) % 4]; const ang = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2); if(Math.min(ang, Math.PI / 2 - ang) > 0.21) aligned = false; }
      if(aligned){ let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity; for(const v of V){ ax0 = Math.min(ax0, v[0]); ay0 = Math.min(ay0, v[1]); ax1 = Math.max(ax1, v[0]); ay1 = Math.max(ay1, v[1]); } return {kind: 'rect', pts: [[ax0, ay0], [ax1, ay0], [ax1, ay1], [ax0, ay1]], closed: true}; }
      return {kind: 'quad', pts: V, closed: true};
    }
    if(err < 0.13) return ellipse(cx, cy, rx, ry);
    if(k >= 5 && k <= 8) return {kind: 'poly', pts: V, closed: true};
    return null;
  }
  const V = rdp(P, Math.max(5 / cam.z, diag * 0.05));
  if(V.length >= 3 && V.length <= 5){
    let dev = 0;
    for(const q of P){ let m = Infinity; for(let i = 0; i < V.length - 1; i++) m = Math.min(m, segDist2(q[0], q[1], V[i][0], V[i][1], V[i+1][0], V[i+1][1])); dev = Math.max(dev, Math.sqrt(m)); }
    if(dev < diag * 0.06) return {kind: 'polyline', pts: V};
  }
  return null;
}
function ellipse(cx, cy, rx, ry){
  if(Math.abs(rx - ry) / Math.max(rx, ry) < 0.15){ const r = (rx + ry) / 2; rx = ry = r; }
  const pts = [], N = 72;
  for(let i = 0; i < N; i++){ const t = i / N * Math.PI * 2; pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
  return {kind: 'ellipse', pts, closed: true};
}

/* ---------- ruler ---------- */
const RULER_HALF_W = 430, RULER_HALF_H = 38;
let rulerZ = 0;
function rulerLocal(sx, sy){
  const r = prefs.ruler, dx = sx - r.cx, dy = sy - r.cy, c = Math.cos(r.a), s = Math.sin(r.a);
  return [dx * c + dy * s, -dx * s + dy * c];
}
function onRuler(sx, sy){ const [lx, ly] = rulerLocal(sx, sy); return Math.abs(lx) <= RULER_HALF_W && Math.abs(ly) <= RULER_HALF_H; }
function rulerEdge(sx, sy){
  const [lx, ly] = rulerLocal(sx, sy);
  if(Math.abs(lx) > RULER_HALF_W + 20) return null;
  if(Math.abs(Math.abs(ly) - RULER_HALF_H) < 26) return {side: ly < 0 ? -1 : 1};
  return null;
}
function projectEdge(edge, sx, sy, w){
  const r = prefs.ruler, [lx] = rulerLocal(sx, sy);
  const ly = edge.side * (RULER_HALF_H + (w * cam.z) / 2 + 1);
  const c = Math.cos(r.a), s = Math.sin(r.a);
  return [r.cx + lx * c - ly * s, r.cy + lx * s + ly * c];
}
function startRulerGesture(){
  return {kind: 'ruler', r0: {...prefs.ruler}, t0: [...touches.values()].map(t => [t.x, t.y])};
}
function rulerMove(){
  const ts = [...touches.values()].map(t => [t.x, t.y]), g = gesture, r = prefs.ruler;
  if(ts.length === 1 || g.t0.length === 1){
    r.cx = g.r0.cx + ts[0][0] - g.t0[0][0]; r.cy = g.r0.cy + ts[0][1] - g.t0[0][1];
  } else {
    const a0 = Math.atan2(g.t0[1][1] - g.t0[0][1], g.t0[1][0] - g.t0[0][0]);
    const a1 = Math.atan2(ts[1][1] - ts[0][1], ts[1][0] - ts[0][0]);
    let a = g.r0.a + (a1 - a0);
    const step = Math.PI / 12, snapA = Math.round(a / step) * step;
    if(Math.abs(a - snapA) < 0.035) a = snapA;
    r.a = a;
    r.cx = g.r0.cx + (ts[0][0] + ts[1][0]) / 2 - (g.t0[0][0] + g.t0[1][0]) / 2;
    r.cy = g.r0.cy + (ts[0][1] + ts[1][1]) / 2 - (g.t0[0][1] + g.t0[1][1]) / 2;
  }
  renderRuler();
}
// ruler centre inside the visible stage (it used to be saved as 0,0 = top left when the stage had no size yet)
function rulerVisible(){ const r = prefs.ruler; return r.cx != null && r.cx > 20 && r.cy > 20 && r.cx < W - 20 && r.cy < H - 20; }
function centerRuler(straight){
  if(!(W > 0 && H > 0)) return;
  prefs.ruler.cx = W / 2; prefs.ruler.cy = H / 2;
  if(straight) prefs.ruler.a = 0;
}
// mouse: move with the hand grip, turn with the arrows at the ends
let rulerDrag = null;
for(const h of ['rulerGrip', 'rulerTurnL', 'rulerTurnR']){
  const el = $(h);
  el.addEventListener('pointerdown', e => {
    if(e.button !== 0 || !prefs.ruler.on) return;
    e.stopPropagation(); e.preventDefault();
    const [sx, sy] = pt(e), r = prefs.ruler;
    rulerDrag = {id: e.pointerId, turn: !!el.dataset.turn, sx, sy, r0: {...r}, m0: Math.atan2(sy - r.cy, sx - r.cx)};
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    const d = rulerDrag; if(!d || d.id !== e.pointerId) return;
    e.stopPropagation();
    const [sx, sy] = pt(e), r = prefs.ruler;
    if(d.turn){
      let a = d.r0.a + Math.atan2(sy - d.r0.cy, sx - d.r0.cx) - d.m0;
      const step = Math.PI / 12, snapA = Math.round(a / step) * step;   // clicks into 15° steps
      if(Math.abs(a - snapA) < 0.05) a = snapA;
      r.a = Math.atan2(Math.sin(a), Math.cos(a));
    } else { r.cx = d.r0.cx + sx - d.sx; r.cy = d.r0.cy + sy - d.sy; }
    renderRuler();
  });
  const end = e => { if(!rulerDrag || rulerDrag.id !== e.pointerId) return; e.stopPropagation(); rulerDrag = null; savePrefs(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
function renderRuler(){
  const el = $('ruler'), r = prefs.ruler;
  el.hidden = !r.on || !cur;
  $('rulerBtn').classList.toggle('on', !!r.on);
  if(!r.on) return;
  el.style.transform = `translate(${r.cx}px,${r.cy}px) rotate(${r.a}rad)`;
  el.style.setProperty('--turn-off', Math.round(Math.max(110, Math.min(RULER_HALF_W - 27, W / 2 - 50))) + 'px');   // turn handles stay on narrow screens
  let deg = ((Math.round(r.a * 180 / Math.PI) % 180) + 180) % 180; if(deg > 90) deg -= 180;   // same as shape rotation: clockwise positive, -89 … 90
  $('rulerAngle').textContent = deg + '°';
  if(rulerZ !== cam.z) renderRulerTicks();
}
function renderRulerTicks(){
  rulerZ = cam.z;
  const mm = MM * cam.z, box = $('rulerTicks');
  let every = 1; while(mm * every < 4) every *= 5;
  let h = '';
  for(let i = 0; i * mm <= RULER_HALF_W * 2 - 20; i += every){
    const x = 10 + i * mm, cm = i % 10 === 0, half = i % 5 === 0;
    h += `<i style="left:${x.toFixed(1)}px;height:${cm ? 16 : half ? 11 : 7}px"></i>`;
    if(cm && mm * 10 >= 22) h += `<b style="left:${x.toFixed(1)}px">${i / 10}</b>`;
  }
  box.innerHTML = h;
}

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
function hitItem(sx, sy, target){
  const el = target && target.closest && target.closest('.it');
  if(el && cur.items.has(el.dataset.id)) return el.dataset.id;
  for(const e2 of document.elementsFromPoint(SR.left + sx, SR.top + sy)){
    const it = e2.closest && e2.closest('.it');
    if(it && cur.items.has(it.dataset.id)) return it.dataset.id;
  }
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
  return null;
}
function finishLasso(a){
  const poly = a.poly;
  if(!a.moved || poly.length < 12){
    const id = hitItem(a.sx, a.sy, a.target) || groupAt(a.sx, a.sy);
    if(id) selectIds([id]); else { clearSel(); tapAt(a.target, a.sx, a.sy); }
    return;
  }
  const wp = [];
  for(let i = 0; i < poly.length; i += 2) wp.push(...toWorld(poly[i], poly[i+1]));
  const ids = [];
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
function clearSel(){ sel = null; $('selBox').hidden = true; if(!$('fadePop').hidden) closePop('fadePop'); }
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
    if(Math.abs(tot - snap) < 4) tot = snap;   // clicks into 15° steps (0, 45, 90 ...) of the total angle
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
  const noRot = its.length === 1 && its[0].t !== 's';
  $('selRot90').hidden = noRot; $('selRot').hidden = noRot;
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
  const list = sel.ids.map(id => cur.items.get(id)).filter(it => it && (it.t === 's' || it.t === 'm')).map(it => Object.assign({}, it, {c}));
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
$('selRot90').addEventListener('click', () => {
  if(!sel) return;
  const b = sel.b, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  replaceItems(sel.ids.map(id => cur.items.get(id)).filter(Boolean).map(it => rotateItem(it, Math.PI / 2, cx, cy)));
  computeSel(); positionOverlays();
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
$('pasteBtn').addEventListener('click', () => Clip.paste());
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

/* ---------- Answer lines on imported pages (typed text snaps onto them) ----------
   Found by scanning the page image for long thin horizontal lines; works for PDFs and pictures,
   old imports included. Cached per image; nothing is stored. */
const lineCache = new Map(), lineReady = new Map();   // asset id -> Promise / lines [{y, x1, x2}] as page fractions
let lineQ = Promise.resolve();
function pageLines(aId){
  let p = lineCache.get(aId);
  if(!p){
    // one page at a time: each scan decodes a full page picture
    const run = lineQ.then(() => detectLines(aId));
    lineQ = run.catch(() => {});
    p = run.catch(e => { console.warn(e); return null; }).then(r => {
      if(r) lineReady.set(aId, r); else lineCache.delete(aId);
      return r || [];
    });
    lineCache.set(aId, p);
  }
  return p;
}
async function detectLines(aId){
  const u = await assetURL(aId); if(!u) return null;
  const img = new Image(); img.src = u; await img.decode();
  const W0 = img.naturalWidth, H0 = img.naturalHeight; if(!W0 || !H0) return null;
  const sc = Math.min(1, 1400 / W0), w = Math.max(1, Math.round(W0 * sc)), h = Math.max(1, Math.round(H0 * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', {willReadFrequently: true}); ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data; c.width = c.height = 1;
  const lum = new Uint8Array(w * h), hist = new Uint32Array(256);
  for(let i = 0; i < w * h; i++){ const l = (px[4 * i] * 77 + px[4 * i + 1] * 150 + px[4 * i + 2] * 29) >> 8; lum[i] = l; hist[l]++; }
  let bg = 0; for(let acc = 0; bg < 255 && (acc += hist[bg]) < w * h / 2; bg++);   // median = paper colour (light or dark)
  const ink = new Uint8Array(w * h); for(let i = 0; i < w * h; i++) ink[i] = Math.abs(lum[i] - bg) > 60 ? 1 : 0;
  const gap = Math.max(2, Math.round(w * 0.004)), minLen = w * 0.1;
  // dotted and dashed lines: a row of short marks with regular gaps
  const maxMark = Math.max(4, w * 0.045), maxGapD = Math.max(6, w * 0.03);
  const segs = [];
  for(let y = 0; y < h; y++){
    const row = y * w; let s = -1, last = -1, n = 0;
    const flush = () => { if(s >= 0 && last - s + 1 >= minLen && n / (last - s + 1) >= 0.6) segs.push({y, x1: s, x2: last}); };
    const runs = []; let rs = -1;
    for(let x = 0; x < w; x++){
      if(ink[row + x]){ if(s < 0 || x - last > gap){ flush(); s = x; n = 0; } last = x; n++; if(rs < 0) rs = x; }
      else if(rs >= 0){ runs.push(rs, x - 1); rs = -1; }
    }
    if(rs >= 0) runs.push(rs, w - 1);
    flush();
    // short marks with small gaps form a chain; letters on the same baseline (e.g. "the 1........") join it too,
    // so the chain is cut wherever the spacing or mark size jumps, and each evenly spaced part is judged alone (1.43)
    const parts = [];
    for(let i = 0; i < runs.length;){
      let j = i;
      while(j + 2 < runs.length && runs[j + 1] - runs[j] + 1 <= maxMark && runs[j + 3] - runs[j + 2] + 1 <= maxMark && runs[j + 2] - runs[j + 1] - 1 <= maxGapD) j += 2;
      let a = i;
      for(let k = i + 2; k <= j; k += 2){
        const p0 = k - 2 > a ? runs[k - 2] - runs[k - 4] : -1, p1 = runs[k] - runs[k - 2];
        const l0 = runs[k - 1] - runs[k - 2] + 1, l1 = runs[k + 1] - runs[k] + 1;
        if((p0 >= 0 && Math.abs(p1 - p0) > Math.max(2, 0.3 * p0)) || Math.abs(l1 - l0) > Math.max(2, 0.5 * Math.max(l0, l1))){ parts.push(a, k - 2); a = k; }
      }
      parts.push(a, j);
      i = j + 2;
    }
    for(let q = 0; q < parts.length; q += 2){
      let i = parts[q], j = parts[q + 1];
      if(j - i >= 6){   // drop an end mark whose spacing is off (the digit or letter right before the dots)
        const ps = []; for(let k = i + 2; k <= j; k += 2) ps.push(runs[k] - runs[k - 2]);
        const pm = ps.slice().sort((x, y) => x - y)[ps.length >> 1];
        if(Math.abs(runs[i + 2] - runs[i] - pm) > 1) i += 2;
        if(Math.abs(runs[j] - runs[j - 2] - pm) > 1) j -= 2;
      }
      const cnt = (j - i) / 2 + 1, x1 = runs[i], x2 = runs[j + 1];
      if(cnt >= 6 && x2 - x1 + 1 >= minLen){
        let on = 0; const gaps = [], lens = [];
        for(let k = i; k <= j; k += 2){ lens.push(runs[k + 1] - runs[k] + 1); on += lens[lens.length - 1]; if(k > i) gaps.push(runs[k] - runs[k - 1] - 1); }
        const cv = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return [m, Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length)]; };
        const [gm, gs] = cv(gaps), [lm, ls] = cv(lens);
        const fill = on / (x2 - x1 + 1);
        // evenly spaced marks of about the same size; letters in a text row never are
        if(gs <= 0.35 * gm + 1 && ls <= 0.35 * lm + 1 && fill >= 0.12 && fill < 0.95) segs.push({y, x1, x2, d: 1});
      }
    }
  }
  // join touching rows into lines; keep only thin ones with clear paper above and below (not text, not filled boxes)
  const bands = [];
  for(const g of segs){
    const b = bands.find(b => g.y - b.y2 <= 1 && Math.min(b.x2, g.x2) - Math.max(b.x1, g.x1) > 0.5 * Math.min(b.x2 - b.x1, g.x2 - g.x1));
    if(b){ b.y2 = g.y; b.x1 = Math.min(b.x1, g.x1); b.x2 = Math.max(b.x2, g.x2); if(!g.d) b.d = 0; } else bands.push({y1: g.y, y2: g.y, x1: g.x1, x2: g.x2, d: g.d ? 1 : 0});
  }
  const clear = (y, x1, x2, lim = 0.3) => { if(y < 0 || y >= h) return true; let n = 0; for(let x = x1; x <= x2; x++) n += ink[y * w + x]; return n / (x2 - x1 + 1) < lim; };
  const maxT = Math.max(3, Math.round(Math.max(w, h) * 0.0065)), out = [];   // thickest line that still counts as a line
  for(const b of bands){
    if(b.y2 - b.y1 + 1 > maxT) continue;
    if(!clear(b.y1 - 3, b.x1, b.x2) || !clear(b.y2 + 3, b.x1, b.x2)) continue;
    // a dotted/dashed line needs empty paper just above and below it (text around it has letters there)
    // (1.43) the digit or letter right before the dots and the comma after them are cut off: the line is the longest
    // stretch with nothing above or below, shrunk to the dots inside it
    let x1 = b.x1, x2 = b.x2;
    if(b.d){
      const m = Math.max(4, Math.round(h * 0.003));
      const hit = x => { for(let k = 2; k <= m; k++){ const ya = b.y1 - k, yb = b.y2 + k; if((ya >= 0 && ink[ya * w + x]) || (yb < h && ink[yb * w + x])) return true; } return false; };
      let bs = -1, be = -2;
      for(let x = b.x1, s = -1; x <= b.x2 + 1; x++){
        if(x <= b.x2 && !hit(x)){ if(s < 0) s = x; }
        else if(s >= 0){ if(x - 1 - s > be - bs) bs = s, be = x - 1; s = -1; }
      }
      if(bs < 0) continue;
      const col = x => { for(let y = b.y1; y <= b.y2; y++) if(ink[y * w + x]) return true; return false; };
      while(bs < be && !col(bs)) bs++;
      while(be > bs && !col(be)) be--;
      if(be - bs + 1 < minLen) continue;
      x1 = bs; x2 = be;
    }
    out.push({y: (b.y1 + b.y2 + 1) / 2 / h, x1: x1 / w, x2: (x2 + 1) / w, _b: b, _x1: x1, _x2: x2});
    if(b.d){ out[out.length - 1].d = 1; out[out.length - 1].yb = (b.y2 + 1) / h; }   // dots sit on the text baseline
  }
  // (1.43) size of the printed text: rows of ink (without the solid lines) form text rows; a row's height from the
  // tops of tall letters to the bottoms of g/p/y is about 0.95 of the font size. Each line gets the size of the text
  // on it or just above it (fs, page fraction); out.fs0 = the page's usual text size
  const prof = new Int32Array(h);
  for(let y = 0; y < h; y++){ let n = 0; const r = y * w; for(let x = 0; x < w; x++) n += ink[r + x]; prof[y] = n; }
  for(const l of out) if(!l._b.d) for(let y = l._b.y1; y <= l._b.y2; y++){ const r = y * w; for(let x = l._x1; x <= l._x2; x++) prof[y] -= ink[r + x]; }
  // a frame or a dark page edge puts the same few ink pixels in every row: count only what is above that
  const pb = Array.from(prof).sort((x, y) => x - y)[Math.floor(h * 0.2)] || 0, rows = [];
  for(let y = 0, s = -1; y <= h; y++){
    if(y < h && prof[y] >= pb + 2){ if(s < 0) s = y; }
    else if(s >= 0){ if(y - s >= 4 && y - s <= h * 0.08) rows.push({y1: s, y2: y - 1, hh: y - s}); s = -1; }
  }
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
  const m0 = med(rows.map(r => r.hh)), txt = rows.filter(r => r.hh >= 0.5 * m0 && r.hh <= 1.8 * m0);
  const m1 = med(txt.map(r => r.hh));
  if(txt.length >= 3 && m1 >= 6) out.fs0 = m1 / 0.95 / h;
  for(const l of out){
    const yc = (l._b.y1 + l._b.y2) / 2;
    let r = txt.find(r => r.y1 <= yc && r.y2 >= yc);
    if(!r){ const up = txt.filter(r => r.y2 < yc && yc - r.y2 <= 3 * (m1 || 20)); r = up[up.length - 1]; }
    // a row without g/p/y (or without tall letters) measures smaller than its font, so the page's usual size is used
    // unless the row is clearly bigger (a heading-size line)
    const rf = r ? r.hh / 0.95 / h : 0;
    if(out.fs0) l.fs = rf > 1.3 * out.fs0 ? rf : out.fs0; else if(rf) l.fs = rf;
    delete l._b; delete l._x1; delete l._x2;
  }
  out.sort((a, b) => a.y - b.y);
  // table borders (since 1.29): thin solid vertical lines, for snapping text into table cells
  const vmin = Math.max(14, Math.round(h * 0.009)), vgap = Math.max(2, Math.round(h * 0.002)), vsegs = [];
  for(let x = 0; x < w; x++){
    let s = -1, last = -1, n = 0;
    const flush = () => { if(s >= 0 && last - s + 1 >= vmin && n / (last - s + 1) >= 0.85) vsegs.push({x, y1: s, y2: last}); };
    for(let y = 0; y < h; y++){
      if(ink[y * w + x]){ if(s < 0 || y - last > vgap){ flush(); s = y; n = 0; } last = y; n++; }
    }
    flush();
  }
  const vb = [];
  for(const g of vsegs){
    const b = vb.find(b => g.x - b.x2 <= 1 && Math.min(b.y2, g.y2) - Math.max(b.y1, g.y1) > 0.5 * Math.min(b.y2 - b.y1, g.y2 - g.y1));
    if(b){ b.x2 = g.x; b.y1 = Math.min(b.y1, g.y1); b.y2 = Math.max(b.y2, g.y2); } else vb.push({x1: g.x, x2: g.x, y1: g.y1, y2: g.y2});
  }
  const vclear = (x, y1, y2) => { if(x < 0 || x >= w) return true; let n = 0; for(let y = y1; y <= y2; y++) n += ink[y * w + x]; return n / (y2 - y1 + 1) < 0.3; };
  out.v = vb.filter(b => b.x2 - b.x1 + 1 <= maxT && vclear(b.x1 - 3, b.y1, b.y2) && vclear(b.x2 + 3, b.y1, b.y2))
    .map(b => ({x: (b.x1 + b.x2 + 1) / 2 / w, y1: b.y1 / h, y2: (b.y2 + 1) / h}));
  return out;
}
// The table cell (four border lines around it) at world point (wx, wy) on an imported page, or null.
function snapCellAt(wx, wy){
  if(!cur) return null;
  const imgs = [...cur.items.values()].filter(it => it.t === 'i' && wx >= it.x && wx <= it.x + it.w && wy >= it.y && wy <= it.y + it.h);
  for(const it of imgs.reverse()){
    const fr = lineReady.get(it.a);
    if(!fr){ pageLines(it.a); continue; }
    if(!fr.v || !fr.v.length) continue;
    const tol = 4;
    const H = fr.map(l => ({y: it.y + l.y * it.h, x1: it.x + l.x1 * it.w, x2: it.x + l.x2 * it.w})).filter(l => wx >= l.x1 - tol && wx <= l.x2 + tol);
    const top = H.filter(l => l.y <= wy).sort((a, b) => b.y - a.y)[0], bot = H.filter(l => l.y > wy).sort((a, b) => a.y - b.y)[0];
    if(!top || !bot) continue;
    const V = fr.v.map(l => ({x: it.x + l.x * it.w, y1: it.y + l.y1 * it.h, y2: it.y + l.y2 * it.h})).filter(l => l.y1 <= top.y + tol && l.y2 >= bot.y - tol);
    const left = V.filter(l => l.x <= wx).sort((a, b) => b.x - a.x)[0], right = V.filter(l => l.x > wx).sort((a, b) => a.x - b.x)[0];
    if(!left || !right) continue;
    const ch = bot.y - top.y, cw = right.x - left.x;
    if(ch < 8 || ch > 200 || cw < 16) continue;
    if(top.x1 > left.x + tol || top.x2 < right.x - tol || bot.x1 > left.x + tol || bot.x2 < right.x - tol) continue;
    return {x1: left.x, x2: right.x, y1: top.y, y2: bot.y};
  }
  return null;
}
// Text in a table cell shrinks (and wraps onto up to 3 lines) so it always fits inside the cell.
function fitCell(id){
  const it = cur && cur.items.get(id), el = elMap.get(id);
  if(!it || !it.ch || !el) return;
  const ch = it.ch, F0 = (it.fs0 || it.fs) * 17;
  let best = null;
  // one line filling the cell (a short answer), as before
  for(let F = Math.min(F0, ch * 0.82); F >= Math.min(F0, ch * 0.82) * 0.75 && F >= 6; F *= 0.92){
    el.style.fontSize = F + 'px'; el.style.lineHeight = ch + 'px';
    if(el.scrollHeight <= ch + 4.5){ best = {fs: F / 17, lh: ch}; break; }
  }
  // (1.44.1) more text (e.g. several pasted lines): normal line spacing, shrinking only down to a readable size;
  // if it still does not fit, the box runs past the cell instead of turning tiny (before: 6 px letters, 3 huge lines)
  if(!best){
    const floor = Math.max(7, F0 * 0.6);
    for(let F = Math.min(F0, ch * 0.82); ; F *= 0.92){
      if(F < floor) F = floor;
      const lh = Math.round(F * 1.3 * 100) / 100;
      el.style.fontSize = F + 'px'; el.style.lineHeight = lh + 'px';
      if(el.scrollHeight <= ch + 4.5 || F <= floor){ best = {fs: F / 17, lh}; break; }
    }
  }
  const r = n => Math.round(n * 1000) / 1000;
  if(r(best.fs) !== r(it.fs) || r(best.lh) !== r(it.lh || 0)) cur.items.set(id, Object.assign({}, it, {fs: r(best.fs), lh: r(best.lh)}));
}
// The answer line to write on for a tap/click at world point (wx, wy), or null.
function snapLineAt(wx, wy){
  if(!cur) return null;
  const imgs = [...cur.items.values()].filter(it => it.t === 'i' && wx >= it.x && wx <= it.x + it.w && wy >= it.y - 20 && wy <= it.y + it.h);
  for(const it of imgs.reverse()){
    const fr = lineReady.get(it.a);
    if(!fr){ pageLines(it.a); continue; }
    // world coordinates; skip the edges of fillable field boxes
    const ls = fr.map(l => ({y: it.y + l.y * it.h, x1: it.x + l.x1 * it.w, x2: it.x + l.x2 * it.w, f: l.fs ? l.fs * it.h : 0, yb: l.d ? it.y + l.yb * it.h : 0}))
      .filter(l => !(it.f || []).some(f => { const fx1 = it.x + f.x * it.w, fx2 = fx1 + f.w * it.w, fy1 = it.y + f.y * it.h, fy2 = fy1 + f.h * it.h;
        return Math.min(l.x2, fx2) - Math.max(l.x1, fx1) > 0 && (Math.abs(l.y - fy1) < 4 || Math.abs(l.y - fy2) < 4); }));
    const near = ls.filter(l => wx >= l.x1 - 24 && wx <= l.x2 + 24 && l.y >= wy - 10);
    if(!near.length) continue;
    const c = near[0], i = ls.indexOf(c), tol = it.w * 0.03;
    const same = (a, b) => Math.abs(a.x1 - b.x1) < tol && Math.abs(a.x2 - b.x2) < tol;
    let d = 0;
    const nx = ls[i + 1], pv = ls[i - 1];
    if(nx && same(c, nx) && nx.y - c.y > 8 && nx.y - c.y < 90) d = nx.y - c.y;
    else if(pv && same(c, pv) && c.y - pv.y > 8 && c.y - pv.y < 90) d = c.y - pv.y;
    const dd = d || 30;
    if(c.y - wy > Math.max(dd * 1.3, 26)) continue;   // too far above the line (e.g. on the question text)
    return {x1: c.x1, x2: c.x2, y: c.y, d: dd, rep: !!d, f: c.f, yb: c.yb};
  }
  return null;
}
// Font size (world px) of the printed text on the imported page at (wx, wy), or 0 if not known (yet).
function pageTextAt(wx, wy){
  if(!cur) return 0;
  const imgs = [...cur.items.values()].filter(it => it.t === 'i' && wx >= it.x && wx <= it.x + it.w && wy >= it.y && wy <= it.y + it.h);
  for(const it of imgs.reverse()){
    const fr = lineReady.get(it.a);
    if(!fr){ pageLines(it.a); continue; }
    if(fr.fs0) return fr.fs0 * it.h;
  }
  return 0;
}
// distance from the top of the first line to the text baseline, for font size F and line height lh
function baselineOf(F, lh){
  const p = document.createElement('div');
  p.className = 'it it-text lh';
  p.style.cssText = `visibility:hidden;left:0;top:0;width:300px;padding:0;font-size:${F}px;line-height:${lh}px`;
  p.innerHTML = '<p>Xg<span style="display:inline-block;width:0;height:0"></span></p>';
  worldFront.appendChild(p);
  const b = p.querySelector('span').offsetTop;
  p.remove();
  return b;
}

/* ---------- text boxes ---------- */
let editing = null, keepEditing = false;
function placeAt(a){
  const id = hitItem(a.sx, a.sy, a.target), it = id && cur.items.get(id);
  if(a.tool === 'text'){
    if(it && it.t === 'x'){ startEditing(id, SR.left + a.sx, SR.top + a.sy); return; }
    if(it && it.t === 'm'){ openMath(it); return; }
    // (1.43) on an imported page, new text is as big as the page's printed text
    const pf = prefs.snapLines ? pageTextAt(a.w0[0], a.w0[1]) : 0;
    const fs = pf ? clamp(pf / 17, 0.25, 6) : clamp(1 / cam.z, 0.25, 6);
    let nt = {t: 'x', id: 'x' + newId(), x: a.w0[0] - 4 * fs, y: a.w0[1] - 16 * fs, w: clamp((W - a.sx - 16) / cam.z, 160 * fs, 460 * fs), fs, html: ''};
    const cell = prefs.snapLines ? snapCellAt(a.w0[0], a.w0[1]) : null;
    const sn = !cell && prefs.snapLines ? snapLineAt(a.w0[0], a.w0[1]) : null;
    if(cell){
      // inside a table cell: one line filling the cell, text shrinks to fit as it is typed (fitCell)
      const ch = Math.round((cell.y2 - cell.y1 - 2) * 100) / 100, F = clamp(pf ? Math.min(pf, ch * 0.62) : ch * 0.62, 6, 28);
      nt = {t: 'x', id: nt.id, x: cell.x1 - 3, y: cell.y1 - 1, w: Math.max(30, cell.x2 - cell.x1 + 6), fs: F / 17, fs0: F / 17, lh: ch, ch, html: ''};
    } else if(sn){
      // sit on the answer line; every further line of text lands on the next ruled line
      const F = sn.f ? clamp(sn.f, 6, 60) : clamp(sn.d * 0.55, 8, 40);
      const lh = Math.round((sn.rep ? sn.d : Math.max(sn.d, F * 1.35)) * 100) / 100;
      // on a ruled line the letters sit just above it; on a dotted line they stand on the dots, like the printed words
      const base = sn.yb ? sn.yb : sn.y - 2 - F * 0.2;
      nt = {t: 'x', id: nt.id, x: sn.x1 - 6 + (sn.yb ? F * 0.3 : 0), y: base - baselineOf(F, lh), w: Math.max(60, sn.x2 - sn.x1 + 12), fs: F / 17, lh, html: ''};
    }
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
  $('fmtBar').hidden = false;
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
  $('fmtBar').hidden = true; tHandle.hidden = true; closePop('tcolorPop');
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
  else if(ed.before.html !== html || ed.before.w !== nit.w) commit([[ed.id, ed.before]], [[ed.id, nit]]);
  changed();
}
worldFront.addEventListener('input', e => {
  if(!editing) return;
  syncEditingHTML();
  fitCell(editing.id);
  lastLocalEdit = Date.now();
  saveContentSoon();
  invalidate(0, 0, 1);
});
worldFront.addEventListener('focusout', () => {
  setTimeout(() => {
    if(!editing || keepEditing) return;
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
  const b = e.target.closest('button'); if(!b || !editing) return;
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
  const b = e.target.closest('[data-tc]'); if(!b || !editing) return;
  const el = elMap.get(editing.id);
  if(!getSelection().isCollapsed) applySentinelColor('color', b.dataset.tc, el);
  closePop('tcolorPop');
  syncEditingHTML(); saveContentSoon();
});

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
      const fw = fmtBar.offsetWidth || 420, fh = fmtBar.offsetHeight || 44;
      let fy = y - fh - 10;
      if(fy < 6) fy = Math.min(y + r.height + 10, H - fh - 6);
      fmtBar.style.left = clamp(x, 8, Math.max(8, W - fw - 8)) + 'px';
      fmtBar.style.top = fy + 'px';
      tHandle.hidden = false;
      tHandle.style.left = (x + r.width - 5) + 'px';
      tHandle.style.top = (y + Math.min(r.height / 2, 40) - 16) + 'px';
    }
  }
  if(prefs.ruler.on && rulerZ !== cam.z) renderRulerTicks();
}

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
  if(t.dataset.editnb){ const nb = getDoc(t.dataset.editnb); editState = {kind: 'nb', id: nb.id, color: nb.data.color || 0}; renderNav(); return; }
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
  const paste = t === 'lasso' && !!Clip.get();
  $('opts').hidden = !(ink || t === 'eraser' || t === 'mark' || paste);
  $('pasteBtn').hidden = !paste; $('sizeWrap').hidden = t === 'lasso';
  $('swatches').hidden = !ink; $('colorBtn').hidden = !ink;
  $('eraseMode').hidden = t !== 'eraser';
  $('assistBtn').hidden = t !== 'pen';
  $('assistBtn').classList.toggle('on', !!(prefs.refLine || prefs.autoText));
  if(t === 'eraser') $('eraseMode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === (prefs.eraser.mode === 'area' ? 'area' : 'stroke')));
  if(ink){
    const favs = t === 'pen' ? prefs.penFavs : prefs.hlFavs, c = prefs[t].c;
    $('swatches').innerHTML = favs.map((f, i) => `<button class="swatch ${t === 'hl' ? 'hl' : ''} ${f === c ? 'on' : ''}" data-i="${i}" aria-label="Colour"><span style="--c:${f === 'auto' ? 'var(--fg)' : f}"></span></button>`).join('');
    const other = !favs.includes(c);
    $('colorBtn').classList.toggle('cur', other);
    $('colorBtn').style.setProperty('--c', other ? (c === 'auto' ? 'var(--fg)' : c) : '');
  }
  barFade();
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
    const gone = new Set(e.g.ids), before = rec.data.items;
    rec.data = Object.assign({}, rec.data, {items: (before || []).filter(s => !gone.has(s.id))});
    await writeDoc(rec);
    toast('Mark removed', 'Undo', async () => {
      const r = await IDB.get('docs', 'c_' + e.pid); if(!r || !r.data) return;
      const have = new Set(r.data.items.map(s => s.id));
      r.data = Object.assign({}, r.data, {items: r.data.items.concat(before.filter(s => gone.has(s.id) && !have.has(s.id)))});
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
  const sv = prefs[sizeT].s, best = WHEEL_SIZES.reduce((a, b) => Math.abs(b - sv) < Math.abs(a - sv) ? b : a);
  WHEEL_SIZES.forEach((v, i) => outer.push({w: 's', v, label: ['Thin', 'Medium', 'Thick'][i], cls: 'wh-size', icon: `<span style="--d:${4 + v / 7}px"></span>`, on: best === v}));
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
      const data = `data-w="${o.w}"${o.v !== undefined ? ` data-v="${esc(String(o.v))}"` : ''} data-i="${k}" aria-label="${esc(o.label)}"`;
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
// the option under the Pencil grows, fills in and is named above the menu
function wheelHover(b){
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
function closeWheel(){ const w = $('wheel'); if(w && !w.hidden){ w.hidden = true; w.innerHTML = ''; w.classList.remove('picking'); } wheelDrag = null; wheelPress = null; wheelGeo = null; }
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
  const start = wheelPress.b; wheelPress = null;
  const b = wheelAt(e.clientX, e.clientY);
  wheelHover(null);
  // slid from one option to another: choose where the Pencil was lifted (a plain tap is handled by click)
  if(b && b !== start) wheelPick(b);
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
  const z = clamp(Math.min((W - 48) / (b[2] - b[0]), (H - 48) / (b[3] - b[1])), 0.1, 2);
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
function closePops(){ for(const id of ['paperPop', 'morePop', 'newPop', 'colorPop', 'tcolorPop', 'shapePop', 'laterPop', 'fadePop', 'assistPop']) closePop(id); }
document.addEventListener('pointerdown', e => {
  if(e.target.closest('.pop') || e.target.closest('#paperBtn,#moreBtn,#newMore,#colorBtn,#shapeBtn,#laterBtn,#selFade,#assistBtn,[data-act="tcolor"]')) return;
  closePops();
}, true);
let modalAt = 0;
function showModal(id){ closePops(); $(id).hidden = false; modalAt = Date.now(); }
function hideModal(id){
  $(id).hidden = true;
  if(id === 'exportDlg' && typeof Pdf !== 'undefined') Pdf.abort = true;
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

/* =====================================================================
   Import PDFs and images ("print onto page")
   ===================================================================== */
let imp = null;
if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
$('insertBtn').addEventListener('click', () => {
  if(!cur){ toast('Open a page first'); return; }
  resetImport(); showModal('importDlg');
});
function resetImport(){
  imp = null;
  $('importPick').hidden = false; $('importSetup').hidden = true;
  $('importFile').value = ''; $('importPreview').innerHTML = ''; $('impStatus').textContent = '';
  $('impGo').disabled = false;
}
$('impOther').addEventListener('click', resetImport);
$('importFile').addEventListener('change', async () => {
  const f = $('importFile').files[0]; if(!f) return;
  $('importPick').hidden = true; $('importSetup').hidden = false; $('impStatus').textContent = 'Reading file';
  try { await loadImport(f); $('impStatus').textContent = ''; }
  catch(e){ console.warn(e); $('impStatus').textContent = e && e.name === 'OldWord' ? 'This is an old Word file (.doc). Open it in Word and save it as .docx or PDF, then import that.' : 'This file could not be opened. ' + (e && e.name === 'PasswordException' ? 'It is password protected.' : /\.docx$/i.test(f.name) ? (e && /load/i.test(e.message) ? e.message : 'Try saving it again in Word, or as PDF.') : 'Try saving it as PDF again.'); $('impGo').disabled = true; }
});
// Reads a PDF page's fillable fields. Returns {f: fields for the item, blank: [[annotationId, emptyValue]]}.
async function pdfFields(page){
  let an;
  try { an = await page.getAnnotations({intent: 'display'}); } catch(e){ console.warn(e); return {f: [], blank: []}; }
  const vp = page.getViewport({scale: 1}), r4 = v => Math.round(v * 1e4) / 1e4;
  const f = [], blank = [];
  for(const a of an || []){
    if(a.subtype !== 'Widget' || a.hidden) continue;
    let k;
    if(a.fieldType === 'Tx') k = 'tx';
    else if(a.fieldType === 'Btn') k = a.checkBox ? 'cb' : a.radioButton ? 'rb' : null;
    else if(a.fieldType === 'Ch') k = a.combo ? 'ch' : 'ls';
    if(!k || !a.rect) continue;
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
    const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if(w < 3 || h < 3) continue;
    const o = {k, n: a.fieldName || '', x: r4(x / vp.width), y: r4(y / vp.height), w: r4(w / vp.width), h: r4(h / vp.height)};
    const fv = a.fieldValue;
    if(k === 'tx'){
      o.v = typeof fv === 'string' ? fv : Array.isArray(fv) ? fv.join(' ') : '';
      if(a.multiLine) o.ml = 1;
      if(a.maxLen > 0) o.mx = a.maxLen;
      if(a.textAlignment === 1 || a.textAlignment === 2) o.al = a.textAlignment;
    } else if(k === 'cb'){
      o.v = !!fv && fv !== 'Off';
    } else if(k === 'rb'){
      o.ev = String(a.buttonValue == null ? '' : a.buttonValue);
      o.v = fv && fv !== 'Off' ? String(fv) : '';
    } else {
      o.o = (a.options || []).map(p => { const ev = Array.isArray(p.exportValue) ? p.exportValue[0] : p.exportValue, dv = Array.isArray(p.displayValue) ? p.displayValue[0] : p.displayValue; return [String(ev == null ? dv : ev), String(dv == null ? ev : dv)]; });
      const vs = (Array.isArray(fv) ? fv : fv ? [fv] : []).map(String);
      if(k === 'ls' && a.multiSelect){ o.ms = 1; o.v = vs; } else o.v = vs[0] || '';
    }
    const ds = a.defaultAppearanceData && a.defaultAppearanceData.fontSize;
    if((k === 'tx' || k === 'ch' || k === 'ls') && ds > 0) o.s = r4(ds / vp.width);
    if(a.readOnly) o.ro = 1;
    f.push(o);
    if(!a.readOnly) blank.push([a.id, k === 'tx' ? '' : k === 'cb' || k === 'rb' ? false : []]);
  }
  // read-only fields keep their printed look; drop their overlay so nothing is drawn twice
  return {f: f.filter(o => !o.ro), blank};
}
async function renderPdfPage(pdf, n, targetW, blank){
  const page = await pdf.getPage(n);
  const v1 = page.getViewport({scale: 1});
  const vp = page.getViewport({scale: targetW / v1.width});
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  const opts = {canvasContext: ctx, viewport: vp};
  if(blank && blank.length){
    // fillable fields: print them empty, their values live in Inkwell's own field layer on top
    for(const [id, value] of blank) pdf.annotationStorage.setValue(id, {value});
    opts.annotationMode = pdfjsLib.AnnotationMode.ENABLE_STORAGE;
  }
  await page.render(opts).promise;
  page.cleanup();
  return {canvas: c, w: v1.width, h: v1.height};
}
async function loadImport(f){
  const prev = $('importPreview'); prev.innerHTML = '';
  const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  if(isPdf){
    if(!window.pdfjsLib) throw new Error('PDF reader missing');
    const pdf = await pdfjsLib.getDocument({data: new Uint8Array(await f.arrayBuffer())}).promise;
    imp = {kind: 'pdf', pdf, n: pdf.numPages, name: f.name.replace(/\.pdf$/i, '').trim()};
    $('impPagesWrap').hidden = false; $('impPages').value = '';
    $('impCount').textContent = `(${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'})`;
    for(let i = 1; i <= Math.min(5, pdf.numPages); i++){ const r = await renderPdfPage(pdf, i, 120); prev.appendChild(r.canvas); }
    if(pdf.numPages > 5){ const m = document.createElement('span'); m.className = 'more'; m.textContent = `+ ${pdf.numPages - 5} more`; prev.appendChild(m); }
  } else if(/\.docx$/i.test(f.name) || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'){
    const pages = await renderDocx(f, t => { $('impStatus').textContent = t; });
    imp = {kind: 'docx', pages, n: pages.length, name: f.name.replace(/\.docx$/i, '').trim()};
    $('impPagesWrap').hidden = false; $('impPages').value = '';
    $('impCount').textContent = `(${pages.length} page${pages.length === 1 ? '' : 's'})`;
    for(const pg of pages.slice(0, 5)){ const t = document.createElement('canvas'), k = 120 / pg.canvas.width; t.width = 120; t.height = Math.round(pg.canvas.height * k); t.getContext('2d').drawImage(pg.canvas, 0, 0, t.width, t.height); prev.appendChild(t); }
    if(pages.length > 5){ const m = document.createElement('span'); m.className = 'more'; m.textContent = `+ ${pages.length - 5} more`; prev.appendChild(m); }
  } else if(/\.doc$/i.test(f.name) || f.type === 'application/msword'){
    throw Object.assign(new Error('old Word'), {name: 'OldWord'});
  } else if(f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp|gif)$/i.test(f.name)){
    const url = URL.createObjectURL(f);
    const img = new Image(); img.src = url;
    await img.decode();
    imp = {kind: 'img', img, url, w: img.naturalWidth, h: img.naturalHeight};
    $('impPagesWrap').hidden = true;
    const t = img.cloneNode(); prev.appendChild(t);
  } else {
    throw new Error('Unsupported file');
  }
  $('impGo').disabled = false;
}
$('impSize').addEventListener('input', () => { $('impSizeVal').textContent = $('impSize').value + '%'; });
function parsePages(str, n){
  str = (str || '').trim().toLowerCase();
  if(!str || str === 'all') return Array.from({length: n}, (_, i) => i + 1);
  const out = new Set();
  for(const part of str.split(/[,;\s]+/)){
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part); if(!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for(let i = Math.min(a, b); i <= Math.max(a, b); i++) if(i >= 1 && i <= n) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
function canvasBlob(c){ return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.86)); }
$('impGo').addEventListener('click', async () => {
  if(!imp || !cur) return;
  const size = +$('impSize').value / 100, go = $('impGo');
  go.disabled = true;
  // place below everything already on the page, then scroll there
  const cb = contentBox();
  // empty, untitled page + PDF: the page takes the PDF's file name
  const pageDoc = getDoc(cur.id), nameAfterPdf = (imp.kind === 'pdf' || imp.kind === 'docx') && !cb && !!imp.name && !!pageDoc && !(pageDoc.data.title || '').trim() && !$('title').value.trim();
  const [vx, vy] = toWorld(W > 600 ? 48 : 16, 24);
  const x0 = cb ? cb[0] : vx, y0 = cb ? cb[3] + 48 : vy;
  let y = y0, nFields = 0; const items = [];
  try {
    if(imp.kind === 'pdf'){
      const pages = parsePages($('impPages').value, imp.n);
      if(!pages.length){ $('impStatus').textContent = 'No pages match that range.'; go.disabled = false; return; }
      for(let k = 0; k < pages.length; k++){
        $('impStatus').textContent = `Printing page ${k + 1} of ${pages.length}`;
        const page = await imp.pdf.getPage(pages[k]); const v1 = page.getViewport({scale: 1});
        const pf = await pdfFields(page), lines = await pdfLines(page); page.cleanup();
        const wWorld = v1.width / 595.28 * A4W * size, hWorld = wWorld * v1.height / v1.width;
        const px = Math.round(clamp(wWorld * 2.4, 900, 2000));
        const r = await renderPdfPage(imp.pdf, pages[k], px, pf.f.length ? pf.blank : null);
        const a = await saveAsset(await canvasBlob(r.canvas));
        r.canvas.width = r.canvas.height = 1;
        const item = {t: 'i', id: 'i' + newId(), x: x0, y, w: wWorld, h: hWorld, a, doc: 1};
        if(hasRealText(lines)) await savePtxt(a, 'pdf', lines);   // searchable right away; scans are read by Claude later
        if(pf.f.length){ item.f = pf.f; nFields += pf.f.length; }
        items.push(item);
        y += hWorld + 24;
      }
    } else if(imp.kind === 'docx'){
      const pages = parsePages($('impPages').value, imp.n);
      if(!pages.length){ $('impStatus').textContent = 'No pages match that range.'; go.disabled = false; return; }
      for(let k = 0; k < pages.length; k++){
        $('impStatus').textContent = `Printing page ${k + 1} of ${pages.length}`;
        const pg = imp.pages[pages[k] - 1];
        const wWorld = pg.w / A4W * A4W * size, hWorld = wWorld * pg.h / pg.w;
        const a = await saveAsset(await canvasBlob(pg.canvas));
        items.push({t: 'i', id: 'i' + newId(), x: x0, y, w: wWorld, h: hWorld, a, doc: 1});
        y += hWorld + 24;
      }
    } else {
      $('impStatus').textContent = 'Placing image';
      const wWorld = A4W * size, hWorld = wWorld * imp.h / imp.w;
      const scale = Math.min(1, 2400 / Math.max(imp.w, imp.h));
      const c = document.createElement('canvas');
      c.width = Math.round(imp.w * scale); c.height = Math.round(imp.h * scale);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(imp.img, 0, 0, c.width, c.height);
      const a = await saveAsset(await canvasBlob(c));
      items.push({t: 'i', id: 'i' + newId(), x: x0, y, w: wWorld, h: hWorld, a});
    }
  } catch(e){
    console.warn(e);
    $('impStatus').textContent = 'Import stopped: ' + (e.message || e);
    go.disabled = false;
    if(!items.length) return;
  }
  const pd = nameAfterPdf && items.length && getDoc(cur.id);
  if(pd && !(pd.data.title || '').trim() && !$('title').value.trim()){ $('title').value = imp.name; await patchDoc(pd, {title: imp.name}); refreshPageItem(cur.id); }
  if(items.length){ addItems(items); setTool('pen'); cam.ox = (W > 600 ? 48 : 16) - x0 * cam.z; cam.oy = 24 - y0 * cam.z; invalidate(); saveCamSoon(); PT.soon(); }
  hideModal('importDlg');
  toast((items.length === 1 ? 'Placed on the page' : `Placed ${items.length} pages`) + (nFields ? ` · ${nFields} fillable field${nFields === 1 ? '' : 's'}` : ''));
});

/* =====================================================================
   Export as PDF (system print dialog -> Save as PDF / Share)
   ===================================================================== */
// filled-in values of a PDF form, as HTML placed at origin (ox, oy) in world units; box = world rows they cover
function fieldParts(it, ox, oy){
  const out = [];
    for(const f of it.f || []){
      let txt = '', mark = false;
      const fbox = [0, it.y + f.y * it.h, 0, it.y + (f.y + f.h) * it.h];
      if(f.k === 'ls'){
        // list box: show all options with the chosen ones highlighted, like on screen
        const vs = Array.isArray(f.v) ? f.v : f.v ? [f.v] : [], fs = fieldFont(f, it);
        const rows = (f.o || []).map(([v, l]) => `<div style="padding:0 ${fs * 0.15}px;${vs.includes(v) ? 'background:#9fbbe8;' : ''}white-space:pre;overflow:hidden">${esc(l)}</div>`).join('');
        out.push({box: fbox, h: `<div style="position:absolute;left:${ox + f.x * it.w}px;top:${oy + f.y * it.h}px;width:${f.w * it.w}px;height:${f.h * it.h}px;overflow:hidden;box-sizing:border-box;background:#fff;box-shadow:inset 0 0 0 1px #888;font:${fs}px/1.2 Helvetica,Arial,sans-serif;color:#111">${rows}</div>`});
        continue;
      }
      if(f.k === 'tx') txt = f.v || '';
      else if(f.k === 'cb'){ txt = f.v ? '✓' : ''; mark = true; }
      else if(f.k === 'rb'){ txt = f.v && f.v === f.ev ? '●' : ''; mark = true; }
      else txt = fieldText({f: [f]}).trim();
      if(!txt) continue;
      const fx = ox + f.x * it.w, fy = oy + f.y * it.h, fw = f.w * it.w, fh = f.h * it.h;
      const fs = mark ? fh * 0.8 : fieldFont(f, it);
      const align = mark ? 'center' : f.al === 1 ? 'center' : f.al === 2 ? 'right' : 'left';
      const lay = mark || !(f.ml || f.k === 'ls') ? `display:flex;align-items:center;justify-content:${mark ? 'center' : align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start'};white-space:pre` : `white-space:pre-wrap;text-align:${align}`;
      out.push({box: fbox, h: `<div style="position:absolute;left:${fx}px;top:${fy}px;width:${fw}px;height:${fh}px;overflow:hidden;box-sizing:border-box;padding:0 ${fs * 0.15}px;font:${fs}px/1.15 Helvetica,Arial,sans-serif;color:#111;${lay}">${esc(txt)}</div>`});
    }
  return out;
}
// paper lines, grid or dots for a world rectangle, as one SVG path (world units)
function paperPath(bg, ya, yb, xa, xb){
  if(!bg || bg.type === 'blank') return '';
  let d = '';
  const gx0 = Math.floor(xa / bg.sx) * bg.sx, gy0 = Math.floor(ya / bg.sy) * bg.sy;
  if(bg.type === 'dots'){
    for(let y = gy0; y <= yb; y += bg.sy) for(let x = gx0; x <= xb; x += bg.sx) d += `M${r1(x - .8)} ${r1(y)}h1.6`;
    return d;
  }
  for(let y = gy0; y <= yb; y += bg.sy) d += `M${r1(xa)} ${r1(y)}H${r1(xb)}`;
  if(bg.type === 'grid') for(let x = gx0; x <= xb; x += bg.sx) d += `M${r1(x)} ${r1(ya)}V${r1(yb)}`;
  return d;
}
// Long pages are printed in parts so the iPad never holds too many page pictures at once
const EXPORT_MAX_SHEETS = 100, EXPORT_MAX_IMGS = 25;
let exportJob = null;
async function exportPdf(){
  if(!cur) return;
  finishEditing();
  const b = contentBox();
  if(!b){ toast('This page is empty'); return; }
  const margin = 40, pw = A4W - 2 * margin, ph = A4H - 2 * margin;
  const x0 = b[0] - 12, y0 = b[1] - 12, cw = b[2] - b[0] + 24, ch = b[3] - b[1] + 24;
  const s = Math.min(1, pw / cw), slice = ph / s;
  const n = Math.max(1, Math.ceil(ch / slice));
  // every sheet only gets the things that reach into it
  const parts = [];   // {a, b, h} or {a, b, img}: world top, world bottom, html or image item
  const add = (box, h) => parts.push({a: box[1], b: box[3], h});
  for(const it of cur.items.values()){
    if(it.t !== 'i') continue;
    parts.push({a: it.y, b: it.y + it.h, img: it});
    for(const fp of fieldParts(it, it.x, it.y)) add(fp.box, fp.h);
  }
  const inks = [];   // highlighter first, so pen ink sits on top
  for(const pass of [1, 0]) for(const it of cur.items.values()){
    if(it.t !== 's' || it.mk || (it.hl ? 1 : 0) !== pass) continue;
    const q = itemBox(it);
    const fo = (pass ? 0.4 : 1) * opOf(it);
    inks.push({a: q[1], b: q[3], h: `<path d="${strokePath(it, true)}" fill="${inkColor(it.c, true)}"${fo < 1 ? ` fill-opacity="${+fo.toFixed(3)}"` : ''}/>`});
  }
  const tops = [];
  for(const it of cur.items.values()){
    if(it.t !== 'x' && it.t !== 'm') continue;
    const el = elMap.get(it.id); if(!el) continue;
    const c = el.cloneNode(true); c.removeAttribute('contenteditable'); c.style.transform = '';
    if(it.t === 'm') c.style.color = it.c && it.c !== 'auto' ? inkColor(it.c, true) : '#18212B';
    const q = itemBox(it);
    tops.push({a: q[1], b: q[3], h: c.outerHTML});
  }
  const hit = (list, k) => { const ya = y0 + k * slice, yb = ya + slice; return list.filter(p => p.b >= ya - 4 && p.a <= yb + 4); };
  // split into parts: at most EXPORT_MAX_SHEETS sheets and EXPORT_MAX_IMGS page pictures each
  const groups = [];
  let g = null;
  for(let k = 0; k < n; k++){
    const ids = hit(parts, k).filter(p => p.img).map(p => p.img.id);
    if(g){
      const more = ids.filter(id => !g.imgs.has(id)).length;
      if(k - g.from >= EXPORT_MAX_SHEETS || (g.imgs.size + more > EXPORT_MAX_IMGS && g.imgs.size)) g = null;
    }
    if(!g){ g = {from: k, to: k, imgs: new Set()}; groups.push(g); }
    g.to = k; ids.forEach(id => g.imgs.add(id));
  }
  exportJob = {cur, title: $('title').value || 'Inkwell page', margin, pw, ph, s, x0, y0, cw, slice, bg: cur.bg, parts, inks, tops, hit, groups};
  if(groups.length === 1){ printSheets(0); return; }
  $('exportTitle').textContent = 'Print in parts'; $('exportActs').hidden = true;
  $('exportInfo').textContent = `This page makes ${n} A4 sheets. It is too long to print in one go, so it is split into ${groups.length} parts. Print each part on its own.`;
  $('exportParts').innerHTML = groups.map((g, i) => `<button class="btn ghost" data-part="${i}">Part ${i + 1} <span class="hint">sheets ${g.from + 1}–${g.to + 1}</span></button>`).join('');
  showModal('exportDlg');
}
$('exportParts').addEventListener('click', e => {
  const btn = e.target.closest('[data-part]'); if(!btn) return;
  btn.classList.add('done');
  printSheets(+btn.dataset.part);
});
async function printSheets(gi){
  const J = exportJob; if(!J || J.cur !== cur) return;
  const grp = J.groups[gi], bg = J.bg;
  const paper = (ya, yb, xa, xb) => {
    const d = paperPath(bg, ya, yb, xa, xb); if(!d) return '';
    return bg.type === 'dots' ? `<svg style="position:absolute;left:0;top:0;overflow:visible" width="1" height="1"><path d="${d}" stroke="#AEBBC9" stroke-width="1.6" stroke-linecap="round"/></svg>`
      : `<svg style="position:absolute;left:0;top:0;overflow:visible" width="1" height="1"><path d="${d}" stroke="#D5DFEA" stroke-width="0.8" fill="none"/></svg>`;
  };
  let html = '';
  for(let k = grp.from; k <= grp.to; k++){
    const ya = J.y0 + k * J.slice, yb = ya + J.slice, xb = J.x0 + J.cw;
    let body = paper(ya, yb, J.x0, xb);
    for(const p of J.hit(J.parts, k)){
      if(!p.img){ body += p.h; continue; }
      const it = p.img, u = await assetURL(it.a);
      if(u) body += `<img src="${u}" style="position:absolute;left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px${opOf(it) < 1 ? ';opacity:' + opOf(it) : ''}">`;
    }
    body += `<svg style="position:absolute;left:0;top:0;overflow:visible" width="1" height="1">${J.hit(J.inks, k).map(p => p.h).join('')}</svg>` + J.hit(J.tops, k).map(p => p.h).join('');
    html += `<div class="print-sheet"><div style="position:absolute;left:${J.margin}px;top:${J.margin}px;width:${J.pw}px;height:${J.ph}px;overflow:hidden"><div class="print-inner" style="transform:scale(${J.s}) translate(${-J.x0}px,${-ya}px)">${body}</div></div></div>`;
  }
  const root = $('printRoot');
  root.innerHTML = html;
  await Promise.all([...root.querySelectorAll('img')].map(i => i.decode().catch(() => {})));
  const oldTitle = document.title;
  document.title = J.title + (J.groups.length > 1 ? ` (part ${gi + 1} of ${J.groups.length})` : '');
  let over = false;
  const done = () => { if(over) return; over = true; root.innerHTML = ''; document.title = oldTitle; removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { try { window.print(); } catch(e){ toast('Printing is not available here'); } setTimeout(done, 60000); }, 50);
}

/* =====================================================================
   Export as one PDF file, built in the app with pdf-lib (lib/pdf-lib.min.js, loaded on first use).
   Same layout as printing: content scaled to A4 width (never up), cut into A4 sheets with 40 px margins.
   Ink and paper are vector; imported pages are embedded as they are stored (JPEG, never decoded);
   text boxes and formulas are rendered at about 240 dpi with html2canvas. Any length gives one file.
   ===================================================================== */
async function pdfLibs(){
  if(!window.PDFLib) await loadScript('lib/pdf-lib.min.js');
  if(!window.html2canvas) await loadScript('lib/docx/html2canvas.min.js');
}
const hexRgb = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const v = m ? parseInt(m[1], 16) : 0x18212B; return PDFLib.rgb((v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255); };
// one element (text box, formula or form overlay) as a PNG, light colours, no zoom transform
async function renderPng(el, w, h, scale){
  const box = document.createElement('div');
  box.className = 'pdf-render';
  box.style.cssText = `position:fixed;left:-30000px;top:0;width:${Math.ceil(w) + 2}px;height:${Math.ceil(h) + 2}px;overflow:hidden`;
  el.style.left = '0px'; el.style.top = '0px'; el.style.transform = '';
  box.appendChild(el); document.body.appendChild(box);
  try {
    const c = await html2canvas(box, {scale, backgroundColor: null, logging: false, useCORS: true});
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    c.width = c.height = 1;
    return new Uint8Array(await blob.arrayBuffer());
  } finally { box.remove(); }
}
const Pdf = {abort: false, file: null};
async function exportPdfFile(){
  if(!cur) return;
  finishEditing();
  const b = contentBox();
  if(!b){ toast('This page is empty'); return; }
  const page0 = cur, title = ($('title').value || 'Inkwell page').trim();
  Pdf.abort = false; Pdf.file = null;
  $('exportTitle').textContent = 'Export as PDF'; $('exportParts').innerHTML = ''; $('exportActs').hidden = false;
  $('exportSave').disabled = true; $('exportInfo').textContent = 'Making the PDF…';
  showModal('exportDlg');
  const say = t => { $('exportInfo').textContent = t; };
  const tick = () => new Promise(r => setTimeout(r, 0));
  try {
    await pdfLibs();
    const {PDFDocument, LineCapStyle, pushGraphicsState, popGraphicsState, rectangle, clip, endPath} = PDFLib;
    const margin = 40, pw = A4W - 2 * margin, ph = A4H - 2 * margin;
    const x0 = b[0] - 12, y0 = b[1] - 12, cw = b[2] - b[0] + 24, ch = b[3] - b[1] + 24;
    const s = Math.min(1, pw / cw), slice = ph / s, n = Math.max(1, Math.ceil(ch / slice));
    const PW = 595.28, PH = 841.89, k = PW / A4W;
    const doc = await PDFDocument.create();
    doc.setTitle(title); doc.setCreator('Inkwell'); doc.setProducer('Inkwell');
    const items = [...page0.items.values()];
    const box = it => itemBox(it);
    // text boxes and formulas: rendered once each, placed on every sheet they reach
    const tops = [];
    const texts = items.filter(it => (it.t === 'x' || it.t === 'm') && elMap.get(it.id));
    for(let i = 0; i < texts.length; i++){
      if(Pdf.abort) return;
      if(i % 4 === 0){ say(`Preparing text ${i + 1} of ${texts.length}…`); await tick(); }
      const it = texts[i], el = elMap.get(it.id), w = el.offsetWidth, h = el.offsetHeight;
      if(!w || !h) continue;
      const c = el.cloneNode(true); c.removeAttribute('contenteditable'); c.style.opacity = '';
      if(it.t === 'm') c.style.color = it.c && it.c !== 'auto' ? inkColor(it.c, true) : '#18212B';
      const sc = Math.max(1, Math.min(s * 2.5, Math.sqrt(12e6 / (w * h))));
      const png = await doc.embedPng(await renderPng(c, w, h, sc));
      tops.push({it, png, x: it.x, y: it.y, w: w + 2, h: h + 2, b: [it.x, it.y, it.x + w, it.y + h]});
    }
    // form values on imported pages: one transparent overlay per page picture
    const overlays = new Map();
    for(const it of items.filter(i => i.t === 'i' && i.f && i.f.length)){
      if(Pdf.abort) return;
      const html = fieldParts(it, 0, 0).map(p => p.h).join(''); if(!html) continue;
      const d = document.createElement('div'); d.style.cssText = `position:absolute;width:${it.w}px;height:${it.h}px`; d.innerHTML = html;
      const sc = Math.max(1, Math.min(s * 2.5, Math.sqrt(12e6 / (it.w * it.h))));
      overlays.set(it.id, await doc.embedPng(await renderPng(d, it.w, it.h, sc)));
    }
    const pics = items.filter(it => it.t === 'i' && it.a), embedded = new Map();
    const inks = [1, 0].flatMap(pass => items.filter(it => it.t === 's' && !it.mk && (it.hl ? 1 : 0) === pass));
    const inkBoxes = new Map(inks.map(it => [it.id, box(it)]));
    const X = wx => (margin + (wx - x0) * s) * k;
    for(let sh = 0; sh < n; sh++){
      if(Pdf.abort) return;
      say(`Making page ${sh + 1} of ${n}…`); await tick();
      const ya = y0 + sh * slice, yb = ya + slice;
      const Y = wy => PH - (margin + (wy - ya) * s) * k;
      const reach = (top, bottom) => bottom >= ya - 4 && top <= yb + 4;
      const page = doc.addPage([PW, PH]);
      page.pushOperators(pushGraphicsState(), rectangle(margin * k, PH - (margin + ph) * k, pw * k, ph * k), clip(), endPath());
      const at = {x: X(0), y: Y(0), scale: s * k};
      const d = paperPath(page0.bg, ya, yb, x0, x0 + cw);
      if(d) page.drawSvgPath(d, page0.bg.type === 'dots' ? {...at, borderColor: hexRgb('#AEBBC9'), borderWidth: 1.6, borderLineCap: LineCapStyle.Round} : {...at, borderColor: hexRgb('#D5DFEA'), borderWidth: 0.8});
      for(const it of pics){
        if(!reach(it.y, it.y + it.h)) continue;
        let img = embedded.get(it.a);
        if(img === undefined){
          img = null;
          try {
            let rec = await IDB.get('assets', it.a);
            if(!rec) rec = await Sync.fetchAsset(it.a);
            if(rec){
              const bytes = new Uint8Array(await rec.blob.arrayBuffer());
              img = bytes[0] === 0x89 && bytes[1] === 0x50 ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
            }
          } catch(e){ console.warn('pdf image', e); }
          embedded.set(it.a, img);
        }
        const r = {x: X(it.x), y: Y(it.y + it.h), width: it.w * s * k, height: it.h * s * k};
        if(img) page.drawImage(img, opOf(it) < 1 ? {...r, opacity: opOf(it)} : r);
        const ov = overlays.get(it.id); if(ov) page.drawImage(ov, r);
      }
      for(const it of inks){
        const q = inkBoxes.get(it.id); if(!reach(q[1], q[3])) continue;
        page.drawSvgPath(strokePath(it, true), {...at, color: hexRgb(inkColor(it.c, true)), opacity: (it.hl ? 0.4 : 1) * opOf(it)});
      }
      for(const t of tops){
        if(!reach(t.b[1], t.b[3])) continue;
        page.drawImage(t.png, {x: X(t.x), y: Y(t.y + t.h), width: t.w * s * k, height: t.h * s * k, opacity: opOf(t.it)});
      }
      page.pushOperators(popGraphicsState());
    }
    say('Saving…'); await tick();
    const bytes = await doc.save();
    if(Pdf.abort) return;
    const name = (title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Inkwell page') + '.pdf';
    Pdf.file = new File([bytes], name, {type: 'application/pdf'});
    const mb = bytes.length / 1048576;
    say(`Ready: ${n} page${n === 1 ? '' : 's'}, ${mb < 0.1 ? '< 0.1' : mb.toFixed(1)} MB.`);
    $('exportSave').disabled = false;
  } catch(e){
    console.warn('pdf export', e);
    say('The PDF could not be made: ' + (e.message || e) + '. Try Print instead.');
  }
}
async function savePdfFile(){
  const f = Pdf.file; if(!f) return;
  // iPad / phone: the share sheet (Save to Files, Mail, …); computer: a normal download
  if(matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({files: [f]})){
    try { await navigator.share({files: [f], title: f.name}); return; }
    catch(e){ if(e.name === 'AbortError') return; console.warn('share', e); }
  }
  const u = URL.createObjectURL(f), a = document.createElement('a');
  a.href = u; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
$('exportSave').addEventListener('click', savePdfFile);
$('exportPrint').addEventListener('click', () => { Pdf.abort = true; hideModal('exportDlg'); exportPdf(); });

/* =====================================================================
   Settings: sign in, backup, restore
   ===================================================================== */
$('status').addEventListener('click', openSettings);
$('settingsBtn').addEventListener('click', openSettings);
function openSettings(){ Clean.plan = null; $('cleanBtn').textContent = 'Free up space'; $('cleanBtn').classList.remove('danger'); $('cleanBtn').disabled = false; $('cleanInfo').textContent = 'Images nothing uses any more'; renderSettings(); showModal('settingsDlg'); }
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
  const walk = v => {
    if(!v || typeof v !== 'object') return;
    if(Array.isArray(v)){ for(const x of v) walk(x); return; }
    for(const k in v){ const x = v[k]; if(k === 'a' && typeof x === 'string') used.add(x); else if(x && typeof x === 'object') walk(x); }
  };
  for(const d of await IDB.all('docs')) if(d.kind !== 'ptxt' && d.data) walk(d.data);
  if(cur){ for(const it of cur.items.values()) walk(it); walk(cur.undo); walk(cur.redo); }   // Undo can still bring a deleted picture back
  walk(Ask.msgs);
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
async function updTrashInfo(){
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
  const v = await appVersion();
  $('verInfo').textContent = 'Inkwell' + (v ? ' ' + v.replace(/^inkwell-/, '') : '');
}
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
    let n = 0, p = 0;
    for(const d of docsIn || []){
      const local = await IDB.get('docs', d.id);
      if(local && local.updated >= d.updated && !local.deleted) continue;
      await IDB.put('docs', {id: d.id, kind: d.kind, data: d.data, deleted: false, updated: Math.max(d.updated, local ? local.updated + 1 : 0), dirty: 1});
      n++;
    }
    const pend = (await IDB.get('meta', 'pendingAssets')) || [];
    for(const a of pics){
      if(await IDB.get('assets', a.id)) continue;
      const blob = await a.get();
      await IDB.put('assets', {id: a.id, blob, type: a.type || blob.type || 'image/jpeg'}); pend.push(a.id); p++;
    }
    await IDB.put('meta', pend, 'pendingAssets');
    await loadDocs(); ensureUi(); renderNav(); renderList(); Sync.soon();
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

/* =====================================================================
   Box picking: draw a box on the page to place a shape or scan a question
   ===================================================================== */
let pick = null;   // {kind: 'shape', shape} | {kind: 'scan'}
function startPick(p, msg){
  if(!cur){ toast('Open a page first'); return; }
  clearSel(); pick = p; stage.classList.add('picking');
  if(p.kind === 'scan'){
    // the Claude panel steps aside so the whole page is visible; a bar at the bottom says what to do
    $('askPanel').classList.add('away'); document.body.classList.add('scanning');
    $('scanBarText').textContent = msg || 'Drag a box around the question';
    $('scanBar').hidden = false; $('toast').hidden = true;
  } else if(msg) toast(msg);
}
function endPick(){
  pick = null; stage.classList.remove('picking');
  $('askPanel').classList.remove('away'); document.body.classList.remove('scanning'); $('scanBar').hidden = true;
}
function pickBox(a){
  const [x0, y0] = a.w0, [x1, y1] = a.w1 || a.w0;
  return {x0, y0, x1, y1, tap: Math.abs(x1 - x0) * cam.z < 10 && Math.abs(y1 - y0) * cam.z < 10, a0: a.cmp ? a.cmp.a0 : null, sweep: a.cmp ? a.cmp.sweep : 0};
}
// Compass: once the pointer is a little away from the centre, add up how far it has gone around (radians, either way)
function compassTrack(a){
  if(!pick || pick.shape !== 'compass' || !a.w1) return;
  const dx = a.w1[0] - a.w0[0], dy = a.w1[1] - a.w0[1];
  if(Math.hypot(dx, dy) * cam.z < 14) return;
  const ang = Math.atan2(dy, dx);
  if(!a.cmp){ a.cmp = {a0: ang, prev: ang, sweep: 0}; return; }
  let d = ang - a.cmp.prev;
  if(d > Math.PI) d -= 2 * Math.PI; else if(d < -Math.PI) d += 2 * Math.PI;
  a.cmp.sweep += d; a.cmp.prev = ang;
}
// [cx, cy, r, start angle, sweep]; a sweep under 15° or past 345° is a full circle
function compassGeo(b){
  if(b.tap || b.a0 == null) return [b.x0, b.y0, b.tap ? 60 / cam.z : Math.hypot(b.x1 - b.x0, b.y1 - b.y0), 0, 2 * Math.PI];
  const r = Math.hypot(b.x1 - b.x0, b.y1 - b.y0), s = Math.abs(b.sweep);
  if(s < Math.PI / 12 || s > Math.PI * 23 / 12) return [b.x0, b.y0, r, b.a0, 2 * Math.PI];
  return [b.x0, b.y0, r, b.a0, b.sweep];
}
function moveSpace(dy){
  act.dy = dy;
  if(act.orig.length) setItems(act.orig.map(it => [it.id, dy ? transformItem(it, {ax: 0, ay: 0, s: 1, dx: 0, dy}) : it]));
}
function finishPick(a){
  const p = pick; endPick();
  if(!p) return;
  const b = pickBox(a);
  if(p.kind === 'shape') insertShape(p.shape, b);
  else if(p.kind === 'scan'){
    if(b.tap){ startPick(p, 'Drag a box, not just a tap, around the question'); return; }
    Ask.scan(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
  }
}
function drawPickPreview(a){
  liveCtx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.ox, dpr * cam.oy);
  if(pick && pick.kind === 'shape'){
    const b = pickBox(a);
    liveCtx.fillStyle = inkColor(prefs.pen.c, false, false);
    for(const it of shapeItems(pick.shape, b)) liveCtx.fill(strokePath(it, false));
    if(pick.shape === 'compass'){
      // needle point, dashed radius line and the radius in cm (paper scale, as on the ruler)
      const [cx, cy, r] = compassGeo(b), ex = b.x1, ey = b.y1;
      liveCtx.strokeStyle = tokens.accent; liveCtx.fillStyle = tokens.accent; liveCtx.lineWidth = 1.5 / cam.z;
      liveCtx.setLineDash([6 / cam.z, 5 / cam.z]); liveCtx.beginPath(); liveCtx.moveTo(cx, cy); liveCtx.lineTo(ex, ey); liveCtx.stroke(); liveCtx.setLineDash([]);
      liveCtx.beginPath(); liveCtx.arc(cx, cy, 3.5 / cam.z, 0, Math.PI * 2); liveCtx.fill();
      liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sx = ex * cam.z + cam.ox, sy = ey * cam.z + cam.oy, txt = 'r = ' + (r / MM / 10).toFixed(1).replace('.', ',') + ' cm';
      liveCtx.font = '600 13px system-ui, sans-serif'; const tw = liveCtx.measureText(txt).width;
      // outside the circle, past the pointer, so it never sits on the line or under the hand
      const d = Math.hypot(ex - cx, ey - cy) || 1;
      const lx = clamp(sx + (ex - cx) / d * (tw / 2 + 26), tw / 2 + 10, W - tw / 2 - 10), ly = clamp(sy + (ey - cy) / d * 30, 16, H - 16);
      liveCtx.fillStyle = tokens.accent; liveCtx.fillRect(lx - tw / 2 - 6, ly - 11, tw + 12, 22);
      liveCtx.fillStyle = '#fff'; liveCtx.fillText(txt, lx - tw / 2, ly + 5);
    }
  } else {
    const x = Math.min(a.w0[0], a.w1[0]), y = Math.min(a.w0[1], a.w1[1]), w = Math.abs(a.w1[0] - a.w0[0]), h = Math.abs(a.w1[1] - a.w0[1]);
    liveCtx.globalAlpha = 0.08; liveCtx.fillStyle = tokens.accent; liveCtx.fillRect(x, y, w, h); liveCtx.globalAlpha = 1;
    liveCtx.setLineDash([6 / cam.z, 5 / cam.z]); liveCtx.lineWidth = 1.5 / cam.z; liveCtx.strokeStyle = tokens.accent; liveCtx.strokeRect(x, y, w, h); liveCtx.setLineDash([]);
  }
}

/* =====================================================================
   Shapes (inserted as ink strokes, so lasso, recolour, eraser and sync all just work)
   ===================================================================== */
function polyPts(V, closed, step = 2.5){
  const out = [], pts = closed ? V.concat([V[0]]) : V;
  for(let i = 0; i < pts.length - 1; i++){
    const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(dist(a, b) / step));
    for(let k = 0; k < n; k++) out.push(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, 0.55);
  }
  const l = pts[pts.length - 1]; out.push(l[0], l[1], 0.55);
  return out;
}
function arrowHead(from, tip, size){
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]), s = 0.45;
  return [[tip[0] - size * Math.cos(ang - s), tip[1] - size * Math.sin(ang - s)], tip, [tip[0] - size * Math.cos(ang + s), tip[1] - size * Math.sin(ang + s)]];
}
const LINE_SHAPES = ['line', 'arrow', 'darrow', 'spring', 'dline'];
// Returns the polylines of a shape: [[points, closed], ...]
function shapePolys(shape, b, w){
  if(shape === 'compass'){
    const [cx, cy, r, a0, sw] = compassGeo(b), full = Math.abs(sw) >= 2 * Math.PI - 1e-9;
    if(r * cam.z < 2) return [];
    const n = Math.max(24, Math.ceil(Math.abs(sw) * r / 2.5)), V = [];
    for(let i = 0; i < (full ? n : n + 1); i++){ const t = a0 + sw * i / n; V.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
    return [[V, full]];
  }
  let {x0, y0, x1, y1} = b;
  const line = LINE_SHAPES.includes(shape);
  if(b.tap){
    const d = 120 / cam.z;
    if(line){ x0 -= d / 2; x1 = x0 + d; y1 = y0; } else { x0 -= d / 2; y0 -= d / 2; x1 = x0 + d; y1 = y0 + d * (shape === 'rect' ? 0.66 : 1); }
  }
  if(line){
    // snap the angle to 15° steps when close
    let len = Math.hypot(x1 - x0, y1 - y0), ang = Math.atan2(y1 - y0, x1 - x0);
    const sn = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
    if(Math.abs(sn - ang) < 0.06){ ang = sn; x1 = x0 + len * Math.cos(ang); y1 = y0 + len * Math.sin(ang); }
    const p0 = [x0, y0], p1 = [x1, y1], hs = clamp(Math.max(10, w * 5), 0, len * 0.45);
    if(shape === 'line') return [[[p0, p1], false]];
    if(shape === 'arrow') return [[[p0, p1], false], [arrowHead(p0, p1, hs), false]];
    if(shape === 'darrow') return [[[p0, p1], false], [arrowHead(p0, p1, hs), false], [arrowHead(p1, p0, hs), false]];
    if(shape === 'dline'){
      const out = [], dash = Math.max(6, w * 4), gap = dash * 0.7;
      for(let t = 0; t < len; t += dash + gap){ const e = Math.min(len, t + dash); out.push([[[x0 + Math.cos(ang) * t, y0 + Math.sin(ang) * t], [x0 + Math.cos(ang) * e, y0 + Math.sin(ang) * e]], false]); }
      return out;
    }
    // spring: straight ends, zigzag middle
    const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux, amp = clamp(len * 0.07, 5, 18), lead = len * 0.12, coils = Math.max(4, Math.round((len - 2 * lead) / (amp * 1.1)));
    const P = [p0, [x0 + ux * lead, y0 + uy * lead]];
    for(let i = 0; i < coils; i++){ const t = lead + (len - 2 * lead) * (i + 0.5) / coils, sgn = i % 2 ? -1 : 1; P.push([x0 + ux * t + nx * amp * sgn, y0 + uy * t + ny * amp * sgn]); }
    P.push([x1 - ux * lead, y1 - uy * lead], p1);
    return [[P, false]];
  }
  let L = Math.min(x0, x1), T = Math.min(y0, y1), R = Math.max(x0, x1), B = Math.max(y0, y1);
  let bw = R - L, bh = B - T;
  if(Math.abs(bw - bh) < 0.08 * Math.max(bw, bh)){ const m = Math.max(bw, bh); bw = bh = m; if(x1 < x0) L = R - m; else R = L + m; if(y1 < y0) T = B - m; else B = T + m; }
  const cx = (L + R) / 2, cy = (T + B) / 2;
  if(shape === 'rect') return [[[[L, T], [R, T], [R, B], [L, B]], true]];
  if(shape === 'ellipse'){ const V = []; for(let i = 0; i < 96; i++){ const t = i / 96 * Math.PI * 2; V.push([cx + bw / 2 * Math.cos(t), cy + bh / 2 * Math.sin(t)]); } return [[V, true]]; }
  if(shape === 'triangle') return [[[[cx, T], [R, B], [L, B]], true]];
  if(shape === 'rtri') return [[[[L, T], [L, B], [R, B]], true]];
  if(shape === 'diamond') return [[[[cx, T], [R, cy], [cx, B], [L, cy]], true]];
  if(shape === 'hexagon') return [[[[L + bw * 0.25, T], [R - bw * 0.25, T], [R, cy], [R - bw * 0.25, B], [L + bw * 0.25, B], [L, cy]], true]];
  if(shape === 'star'){
    const V = [];
    for(let i = 0; i < 10; i++){ const r = i % 2 ? 0.4 : 1, t = -Math.PI / 2 + i * Math.PI / 5; V.push([cx + bw / 2 * r * Math.cos(t), cy + bh / 2 * r * Math.sin(t) + bh * 0.05]); }
    return [[V, true]];
  }
  return [];
}
function shapeItems(shape, b){
  const w = penWidth(), polys = shapePolys(shape, b, w), g = polys.length > 1 ? 'g' + newId() : null;
  return polys.map(([V, closed]) => { const it = {t: 's', id: 's' + newId() + Math.random().toString(36).slice(2, 5), c: prefs.pen.c, w, hl: 0, p: polyPts(V, closed)}; if(g) it.g = g; return it; });
}
function insertShape(shape, b){
  const items = shapeItems(shape, b);
  if(!items.length) return;
  addItems(items);
  setTool('lasso'); selectIds(items.map(it => it.id));
}
$('shapeBtn').addEventListener('click', e => { if(!cur){ toast('Open a page first'); return; } openPop('shapePop', e.currentTarget); });
$('shapeGrid').addEventListener('click', e => {
  const b = e.target.closest('button[data-shape]'); if(!b) return;
  closePops();
  startPick({kind: 'shape', shape: b.dataset.shape}, 'Drag on the page to draw the ' + (b.title || 'shape').toLowerCase());
});
$('compassOpen').addEventListener('click', () => {
  closePops();
  startPick({kind: 'shape', shape: 'compass'}, 'Put the point on the centre, drag out to the radius, then go around for an arc. Let go without going around for a full circle.');
});

/* =====================================================================
   Graphs: axes with ticks, numbers, grid and an optional plotted function
   ===================================================================== */
// Small safe formula parser for y = f(x): numbers, x (or t), + - * / ^, brackets, implicit multiplication,
// sin cos tan asin acos atan sqrt abs exp ln log, pi, e
function parseFn(src){
  const s = String(src || '').replace(/^\s*[yf]\s*(\(\s*[xt]\s*\))?\s*=/i, '').replace(/·|×/g, '*').replace(/−/g, '-').replace(/,/g, '.').trim();
  if(!s) return null;
  const toks = []; let i = 0;
  while(i < s.length){
    const c = s[i];
    if(/\s/.test(c)){ i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if(num && !(num[2] && /^e[a-z]/i.test(s.slice(i + num[1].length)))){ toks.push({t: 'n', v: parseFloat(num[0])}); i += num[0].length; continue; }
    const id = /^[a-z]+/i.exec(s.slice(i));
    if(id){ toks.push({t: 'i', v: id[0].toLowerCase()}); i += id[0].length; continue; }
    if('+-*/^()'.includes(c)){ toks.push({t: c}); i++; continue; }
    throw new Error('Unknown sign "' + c + '"');
  }
  const F = {sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10};
  let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const startsPrimary = t => t && (t.t === 'n' || t.t === 'i' || t.t === '(');
  function expr(){ let a = term(); while(peek() && (peek().t === '+' || peek().t === '-')){ const op = next().t, l = a, r = term(); a = op === '+' ? x => l(x) + r(x) : x => l(x) - r(x); } return a; }
  function term(){
    let a = unary();
    for(;;){
      const t = peek();
      if(t && (t.t === '*' || t.t === '/')){ next(); const l = a, r = unary(); a = t.t === '*' ? x => l(x) * r(x) : x => l(x) / r(x); }
      else if(startsPrimary(t)){ const l = a, r = power(); a = x => l(x) * r(x); }
      else return a;
    }
  }
  function unary(){ const t = peek(); if(t && (t.t === '-' || t.t === '+')){ next(); const a = unary(); return t.t === '-' ? x => -a(x) : a; } return power(); }
  function power(){ const b = primary(); if(peek() && peek().t === '^'){ next(); const e = unary(); return x => Math.pow(b(x), e(x)); } return b; }
  function primary(){
    const t = next();
    if(!t) throw new Error('The formula ends too early');
    if(t.t === 'n'){ const v = t.v; return () => v; }
    if(t.t === '('){ const a = expr(); if(!peek() || next().t !== ')') throw new Error('A bracket is not closed'); return a; }
    if(t.t === 'i'){
      if(t.v === 'x' || t.v === 't') return x => x;
      if(t.v === 'pi') return () => Math.PI;
      if(t.v === 'e') return () => Math.E;
      if(F[t.v]){
        const f = F[t.v];
        if(peek() && peek().t === '('){ next(); const a = expr(); if(!peek() || next().t !== ')') throw new Error('A bracket is not closed'); return x => f(a(x)); }
        const a = power(); return x => f(a(x));
      }
      throw new Error('Unknown name "' + t.v + '"');
    }
    throw new Error('Unexpected "' + t.t + '"');
  }
  const f = expr();
  if(p < toks.length) throw new Error('Unexpected "' + (toks[p].v ?? toks[p].t) + '"');
  return f;
}
function labelTex(s){
  s = String(s || '').trim();
  if(!s) return '';
  if(/[\\^_{}]/.test(s) || /^[a-zA-Z](\s*\(\s*[a-zA-Z]\s*\))?$/.test(s)) return s;
  // "v in m/s" -> italic variable + upright rest
  const m = /^([a-zA-Z])(\s+.*|\s*[\[(].*)$/.exec(s);
  const txt = t => '\\text{' + t.replace(/[\\{}$&#%~^_]/g, '') + '}';
  return m ? m[1] + '\\ ' + txt(m[2].trim()) : txt(s);
}
const fmtNum = v => { const r = Math.round(v * 1e6) / 1e6; return String(r).replace('-', '-'); };
// Look (1.40), o.look: size (scale), axC (axes + labels colour), fnC / fnW / fnS (curve colour, width factor,
// 'solid' | 'dash' | 'dot'), gridO / allO (fade in %, 10–100), arrows. Missing = the look from before 1.40.
const GRAPH_LOOK = {size: 1, axC: 'auto', fnC: '#1F4FCF', fnW: 1.15, fnS: 'solid', gridO: 100, allO: 100, arrows: true};
// cuts a polyline into dashes along its length: [[points], …]
function dashPolys(V, dash, gap){
  const out = []; let cur = [V[0]], on = true, left = dash;
  for(let i = 1; i < V.length; i++){
    let a = V[i - 1]; const b = V[i]; let d = dist(a, b);
    while(d > left){
      const t = left / d, m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if(on){ cur.push(m); out.push(cur); } else cur = [m];
      on = !on; d -= left; a = m; left = on ? dash : gap;
    }
    left -= d; if(on) cur.push(b);
  }
  if(on && cur.length > 1) out.push(cur);
  return out;
}
function buildGraph(o, gx, gy){
  const L = Object.assign({}, GRAPH_LOOK, o.look || {}), S = L.size > 0 ? L.size : 1;
  const items = [], w = penWidth(), axisC = L.axC || 'auto', id = p => p + newId() + Math.random().toString(36).slice(2, 5);
  const grp = 'g' + newId();
  const stroke = (V, c = axisC, ww = w, op = 1) => { const it = {t: 's', id: id('s'), c, w: ww, hl: 0, p: polyPts(V, false)}; if(op < 1) it.o = op; items.push(it); };
  const formula = (tex, x, y, fs) => { if(tex) items.push({t: 'm', id: id('m'), x, y, tex, fs, c: axisC}); };
  const hs = Math.max(10, w * 5);
  const arrow = (from, tip) => { if(L.arrows !== false) stroke(arrowHead(from, tip, hs)); };
  const finish = () => {
    const all = clamp((+L.allO || 100) / 100, 0.1, 1);
    items.forEach(it => { it.g = grp; if(all < 1){ const v = Math.round(opOf(it) * all * 100) / 100; it.o = Math.max(0.05, v); } });
    return items;
  };
  if(o.type === '3d'){
    const Ox = gx + 120 * S, Oy = gy + 200 * S, Ln = 210 * S;
    const ends = {y: [Ox + Ln, Oy], z: [Ox, Oy - Ln], x: [Ox - Ln * 0.55, Oy + Ln * 0.55]};
    for(const k of ['x', 'y', 'z']){
      const e = ends[k];
      stroke([[Ox, Oy], e]); arrow([Ox, Oy], e);
      for(let i = 1; i <= 4; i++){
        const t = i / 5, px = Ox + (e[0] - Ox) * t, py = Oy + (e[1] - Oy) * t;
        if(k === 'z') stroke([[px - 4, py], [px + 4, py]]); else stroke([[px, py - 4], [px, py + 4]]);
      }
    }
    formula(labelTex(o.ly), ends.y[0] + 6, ends.y[1] + 4, 18);
    formula(labelTex(o.lz), ends.z[0] + 10, ends.z[1] - 6, 18);
    formula(labelTex(o.lx), ends.x[0] - 26, ends.x[1] - 6, 18);
    return finish();
  }
  const GW = 380 * S, GH = 270 * S;
  let {x0, x1, xs, y0, y1, ys} = o;
  const X = v => gx + (v - x0) / (x1 - x0) * GW, Y = v => gy + GH - (v - y0) / (y1 - y0) * GH;
  const ax = X(clamp(0, x0, x1)), ay = Y(clamp(0, y0, y1));
  const ticks = (a, b, st) => { const out = []; if(!(st > 0)) return out; const n0 = Math.ceil(a / st - 1e-9), n1 = Math.floor(b / st + 1e-9); if(n1 - n0 > 200) return out; for(let n = n0; n <= n1; n++) out.push(n * st); return out; };
  const tx = ticks(x0, x1, xs), ty = ticks(y0, y1, ys);
  if(o.grid){
    const go = clamp((+L.gridO || 100) / 100, 0.1, 1);
    for(const v of tx) if(Math.abs(X(v) - ax) > 0.5) stroke([[X(v), Y(y0)], [X(v), Y(y1)]], '#8A97A4', w * 0.45, go);
    for(const v of ty) if(Math.abs(Y(v) - ay) > 0.5) stroke([[X(x0), Y(v)], [X(x1), Y(v)]], '#8A97A4', w * 0.45, go);
  }
  const xe = [X(x1) + 22, ay], ye = [ax, Y(y1) - 22];
  stroke([[X(x0), ay], xe]); arrow([X(x0), ay], xe);
  stroke([[ax, Y(y0)], ye]); arrow([ax, Y(y0)], ye);
  const every = arr => Math.max(1, Math.ceil(arr.length / Math.max(4, Math.round(12 * S))));
  const ex = every(tx), ey = every(ty);
  tx.forEach((v, i) => {
    if(Math.abs(X(v) - ax) < 0.5) return;
    stroke([[X(v), ay - 4], [X(v), ay + 4]]);
    if(o.nums && i % ex === 0){ const t = fmtNum(v); formula(t, X(v) - t.length * 4.3, ay + 7, 12); }
  });
  ty.forEach((v, i) => {
    if(Math.abs(Y(v) - ay) < 0.5) return;
    stroke([[ax - 4, Y(v)], [ax + 4, Y(v)]]);
    if(o.nums && i % ey === 0){ const t = fmtNum(v); formula(t, ax - 14 - t.length * 8.5, Y(v) - 9, 12); }
  });
  if(o.nums && x0 <= 0 && x1 >= 0 && y0 <= 0 && y1 >= 0) formula('0', ax - 14, ay + 5, 12);
  formula(labelTex(o.lx), xe[0] - 4, ay + 10, 18);
  formula(labelTex(o.ly), ax + 10, ye[1] - 8, 18);
  if(o.fn){
    const N = 600, segs = []; let seg = [];
    for(let i = 0; i <= N; i++){
      const xv = x0 + (x1 - x0) * i / N, yv = o.fn(xv);
      if(isFinite(yv) && yv >= y0 - (y1 - y0) * 1e-3 && yv <= y1 + (y1 - y0) * 1e-3) seg.push([X(xv), Y(clamp(yv, y0, y1))]);
      else { if(seg.length > 1) segs.push(seg); seg = []; }
    }
    if(seg.length > 1) segs.push(seg);
    const fw = w * (L.fnW > 0 ? L.fnW : 1.15), fc = L.fnC || '#1F4FCF';
    for(const sg of segs){
      const pieces = L.fnS === 'dash' ? dashPolys(sg, Math.max(8, fw * 4), Math.max(6, fw * 3))
        : L.fnS === 'dot' ? dashPolys(sg, Math.max(0.6, fw * 0.3), Math.max(5, fw * 2.6)) : [sg];
      for(const pc of pieces){
        // thin out points that lie on a straight line
        const V = pc.length > 2 ? rdp(pc, 0.25) : pc;
        items.push({t: 's', id: id('s'), c: fc, w: fw, hl: 0, p: polyPts(V, false)});
      }
    }
  }
  return finish();
}
const GRAPH_DEFAULTS = {q1: {x0: 0, x1: 10, xs: 1, y0: 0, y1: 10, ys: 1}, q4: {x0: -5, x1: 5, xs: 1, y0: -5, y1: 5, ys: 1}};
let graphType = 'q1';
// the dialog's look choices are remembered per device (prefs.graph); grid lines start half faded
const gLook = () => { if(!prefs.graph || typeof prefs.graph !== 'object') prefs.graph = {}; return Object.assign({}, GRAPH_LOOK, {gridO: 50}, prefs.graph); };
function setGLook(k, v){ if(!prefs.graph || typeof prefs.graph !== 'object') prefs.graph = {}; prefs.graph[k] = v; savePrefs(); renderGLook(); }
function renderGLook(){
  const L = gLook();
  const seg = (box, v) => $(box).querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === +v || b.dataset.v === String(v)));
  seg('gSize', L.size); seg('gFnW', L.fnW); seg('gFnS', L.fnS);
  const sw = (box, list, v) => { $(box).innerHTML = list.map(c => `<button class="swatch${c === v ? ' on' : ''}" data-c="${c}" aria-label="${c === 'auto' ? 'Automatic (black or white)' : c}"><span style="--c:${c === 'auto' ? 'var(--fg)' : c}"></span></button>`).join(''); };
  const favs = [...new Set(['auto', ...prefs.penFavs, '#8A97A4'])];
  sw('gAxC', favs, L.axC);
  sw('gFnC', [...new Set(['#1F4FCF', ...prefs.penFavs])], L.fnC);
  $('gGridO').value = L.gridO; $('gGridOv').textContent = L.gridO + ' %';
  $('gAllO').value = L.allO; $('gAllOv').textContent = L.allO + ' %';
  $('gArrows').checked = L.arrows !== false;
  drawGraphPreview();
}
function setGraphType(t){
  graphType = t;
  $('gType').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === t));
  document.querySelectorAll('#graphDlg .g2d').forEach(el => el.hidden = t === '3d');
  document.querySelectorAll('#graphDlg .g3').forEach(el => el.hidden = t !== '3d');
  const d = GRAPH_DEFAULTS[t];
  if(d) for(const [k, v] of Object.entries({gX0: d.x0, gX1: d.x1, gXs: d.xs, gY0: d.y0, gY1: d.y1, gYs: d.ys})) $(k).value = v;
  drawGraphPreview();
}
// reads the dialog: {o} or {err}
function readGraph(){
  const num = id => { const v = parseFloat(String($(id).value).replace(',', '.')); return isFinite(v) ? v : NaN; };
  const o = {type: graphType, lx: $('gLx').value, ly: $('gLy').value, lz: $('gLz').value, nums: $('gNums').checked, grid: $('gGrid').checked, look: gLook()};
  if(graphType !== '3d'){
    Object.assign(o, {x0: num('gX0'), x1: num('gX1'), xs: Math.abs(num('gXs')), y0: num('gY0'), y1: num('gY1'), ys: Math.abs(num('gYs'))});
    if(!(o.x1 > o.x0) || !(o.y1 > o.y0)) return {err: 'Each "to" must be bigger than its "from".'};
    try { o.fn = parseFn($('gFn').value); } catch(err){ return {err: err.message}; }
  }
  return {o};
}
// small picture of the graph in the dialog; formulas drawn as plain text
function drawGraphPreview(){
  const cv = $('gPrev'); if(!cv || $('graphDlg').hidden) return;
  const r = cv.getBoundingClientRect(); if(!r.width) return;
  const d = Math.min(2, devicePixelRatio || 1), CW = Math.round(r.width * d), CH = Math.round(r.height * d);
  if(cv.width !== CW || cv.height !== CH){ cv.width = CW; cv.height = CH; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, CW, CH);
  const g = readGraph(); if(g.err) return;
  const items = buildGraph(g.o, 0, 0);
  const tw = it => texPlain(it.tex).length * it.fs * 0.55;
  let b = null;
  for(const it of items){
    const q = it.t === 's' ? strokeBox(it) : [it.x, it.y, it.x + tw(it), it.y + it.fs * 1.3];
    b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q;
  }
  if(!b) return;
  const kk = Math.min(1.6 * d, (CW - 24 * d) / (b[2] - b[0]), (CH - 16 * d) / (b[3] - b[1]));
  ctx.setTransform(kk, 0, 0, kk, CW / 2 - (b[0] + b[2]) / 2 * kk, CH / 2 - (b[1] + b[3]) / 2 * kk);
  for(const it of items){
    ctx.globalAlpha = opOf(it);
    if(it.t === 's'){ ctx.fillStyle = inkColor(it.c, false); ctx.fill(strokePath(it, false)); }
    else { ctx.fillStyle = it.c && it.c !== 'auto' ? inkColor(it.c) : tokens.fg; ctx.font = `italic ${it.fs * 0.9}px "Times New Roman", serif`; ctx.fillText(texPlain(it.tex), it.x, it.y + it.fs); }
  }
  ctx.globalAlpha = 1;
}
$('graphOpen').addEventListener('click', () => {
  closePops();
  if(!$('gLx').value) $('gLx').value = 'x';
  if(!$('gLy').value) $('gLy').value = 'y';
  if(!$('gLz').value) $('gLz').value = 'z';
  if(!$('gX1').value){ $('gNums').checked = true; setGraphType('q1'); }
  $('gFnMsg').textContent = '';
  showModal('graphDlg');
  renderGLook();
});
$('gType').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if(b) setGraphType(b.dataset.v); });
$('gFn').addEventListener('input', () => {
  try { parseFn($('gFn').value); $('gFnMsg').textContent = ''; } catch(err){ $('gFnMsg').textContent = err.message; }
});
$('graphDlg').addEventListener('input', e => { if(e.target.id !== 'gGridO' && e.target.id !== 'gAllO') drawGraphPreview(); });
$('graphDlg').addEventListener('change', e => { if(e.target.matches('input[type=checkbox]') && e.target.id !== 'gArrows') drawGraphPreview(); });
for(const [box, key, num] of [['gSize', 'size', 1], ['gFnW', 'fnW', 1], ['gFnS', 'fnS', 0]])
  $(box).addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if(b) setGLook(key, num ? +b.dataset.v : b.dataset.v); });
for(const [box, key] of [['gAxC', 'axC'], ['gFnC', 'fnC']])
  $(box).addEventListener('click', e => { const b = e.target.closest('[data-c]'); if(b) setGLook(key, b.dataset.c); });
for(const [inp, key] of [['gGridO', 'gridO'], ['gAllO', 'allO']])
  $(inp).addEventListener('input', () => setGLook(key, clamp(+$(inp).value || 100, 10, 100)));
$('gArrows').addEventListener('change', () => setGLook('arrows', $('gArrows').checked));
$('gInsert').addEventListener('click', () => {
  if(!cur) return;
  const g = readGraph();
  if(g.err){ $('gFnMsg').textContent = g.err; return; }
  const S = g.o.look.size || 1;
  const [gx, gy] = toWorld(Math.max(40, W / 2 - 240 * S * cam.z), Math.max(40, H / 2 - 170 * S * cam.z));
  const items = buildGraph(g.o, gx, gy);
  hideModal('graphDlg');
  addItems(items);
  setTool('lasso'); setTimeout(() => selectIds(items.map(it => it.id)), 60);
});

/* =====================================================================
   Word documents: rendered to page images, like a PDF
   ===================================================================== */
function loadScript(src){
  return new Promise((res, rej) => {
    if(document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.dataset.src = src;
    s.onload = () => res(); s.onerror = () => rej(new Error('Could not load ' + src + ' (offline?)'));
    document.head.appendChild(s);
  });
}
async function wordLibs(){
  if(!window.JSZip) await loadScript('lib/docx/jszip.min.js');
  if(!window.docx || !window.docx.renderAsync) await loadScript('lib/docx/docx-preview.min.js');
  if(!window.html2canvas) await loadScript('lib/docx/html2canvas.min.js');
}
// Renders every page of a .docx to a canvas (about 2 px per CSS px). Long sections without page breaks are
// cut into page-sized pieces at blank rows between lines of text.
async function renderDocx(file, onStatus){
  await wordLibs();
  const box = document.createElement('div');
  box.className = 'docx-render';
  box.style.cssText = 'position:absolute;left:0;top:0;z-index:-5;background:#fff;color:#000;color-scheme:light;width:max-content;pointer-events:none';
  document.body.appendChild(box);
  try {
    await window.docx.renderAsync(await file.arrayBuffer(), box, box, {inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, ignoreWidth: false, ignoreHeight: false, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true, experimental: true});
    if(document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise(r => setTimeout(r, 60));
    const sections = [...box.querySelectorAll('section.docx')];
    if(!sections.length) throw new Error('No pages found in this Word file');
    const pages = [], scale = 2;
    for(let si = 0; si < sections.length; si++){
      const sec = sections[si];
      // only this section in the layout, so it sits at the top of the document while it is captured
      sections.forEach(o => { o.style.display = o === sec ? '' : 'none'; });
      const cs = getComputedStyle(sec);
      const pw = sec.offsetWidth, padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
      const ph = Math.max(parseFloat(cs.minHeight) || 0, 100) || pw * 1.414;
      const total = sec.scrollHeight, r = sec.getBoundingClientRect(), top = r.top + scrollY, left = r.left + scrollX;
      let srcY = 0, first = true;
      while(srcY < total - padB - 2 || first){
        onStatus && onStatus(`Reading page ${pages.length + 1}`);
        const avail = Math.max(50, first ? ph - padB : ph - padT - padB);
        const take = Math.min(avail, total - srcY);
        const cv = await html2canvas(sec, {scale, backgroundColor: '#ffffff', logging: false, useCORS: true,
          x: left, y: top + srcY, width: pw, height: take, scrollX: 0, scrollY: 0, windowWidth: Math.max(pw + 40, innerWidth),
          ignoreElements: el => el !== document.body && el !== document.documentElement && el.tagName !== 'HEAD' && !box.contains(el) && !el.contains(box)});
        let cut = take;
        if(srcY + take < total - padB - 2){
          // find a blank row in the lowest quarter so no line of text is cut in half
          const ctx = cv.getContext('2d'), y0 = Math.floor(cv.height * 0.72), data = ctx.getImageData(0, y0, cv.width, cv.height - y0).data, rowW = cv.width * 4;
          for(let y = cv.height - y0 - 1; y >= 0; y--){
            let blank = true;
            for(let x = 0; x < rowW; x += 16){ if(data[y * rowW + x] < 235 || data[y * rowW + x + 1] < 235 || data[y * rowW + x + 2] < 235){ blank = false; break; } }
            if(blank){ cut = (y0 + y) / scale; break; }
          }
        }
        const page = document.createElement('canvas');
        page.width = Math.round(pw * scale); page.height = Math.round(ph * scale);
        const pc = page.getContext('2d');
        pc.fillStyle = '#fff'; pc.fillRect(0, 0, page.width, page.height);
        pc.drawImage(cv, 0, 0, cv.width, Math.round(cut * scale), 0, Math.round((first ? 0 : padT) * scale), cv.width, Math.round(cut * scale));
        cv.width = cv.height = 1;
        pages.push({canvas: page, w: pw, h: ph});
        srcY += Math.max(cut, 20); first = false;
        if(pages.length > 300) break;
      }
    }
    return pages;
  } finally { box.remove(); }
}

/* =====================================================================
   Ask Claude: scan a question (or just type) and get help in a floating window
   ===================================================================== */
const Ask = {
  msgs: [],        // API messages for this chat; scanned images are kept as assets: {type:'image', a: assetId}
  view: [],        // what the chat shows: {who:'user', text, a?, box?, page?} / {who:'bot', text, model?}
  chatId: null,    // doc id of this chat in the history (kind 'chat')
  b64: new Map(),  // asset id -> base64 of scans, so they are not read back for every message
  busy: false,
  ctrl: null,
  mode: null,      // 'practice' while a practice chat is open; otherwise the Tutor/Solve choice (prefs.askMode) is used
  open(){
    const p = $('askPanel');
    p.hidden = false; p.classList.remove('min');
    const pos = LSget('inkwell.askPos', null);
    if(pos){ p.style.left = clamp(pos.x, 4, innerWidth - 120) + 'px'; p.style.top = clamp(pos.y, 4, innerHeight - 60) + 'px'; p.style.right = 'auto'; p.style.bottom = 'auto'; }
    this.renderMode();
    if(!this.msgs.length) this.empty();
  },
  close(){ $('askPanel').hidden = true; if(this.ctrl) this.ctrl.abort(); },
  empty(){
    $('askLog').innerHTML = `<div class="ask-empty">Tap <b>scan</b> (the frame icon) and draw a box around a question on your page, or just type. Claude also gets the typed text of the page you have open.<br><br><b>Tutor</b> explains and gives hints so you solve it yourself. <b>Solve</b> shows the full worked solution.<br><br><b>Practice</b> (same menu): pick pages with learning objectives, exercises or notes, and Claude quizzes you one exercise at a time.</div>`;
  },
  chats(){ return [...docs.values()].filter(d => d.kind === 'chat' && live(d)).sort((a, b) => (b.data.at || 0) - (a.data.at || 0)); },
  showHistory(){
    this.histOpen = true; $('askPanel').classList.add('hist');
    const list = this.chats();
    const day = ms => { const d = new Date(ms), now = new Date(); const same = d.toDateString() === now.toDateString(); return same ? d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : d.toLocaleDateString([], {day: 'numeric', month: 'short'}) + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : ''); };
    $('askLog').innerHTML = `<div class="ah-head"><b>History</b><button class="btn ghost ah-back">Back to chat</button></div>` + (list.length ? list.map(c => {
      const pg = c.data.page && docs.get(c.data.page), n = (c.data.view || []).filter(v => v.who === 'user').length;
      return `<div class="ah-row ${c.id === this.chatId ? 'on' : ''}" data-chat="${c.id}"><button class="ah-open"><b>${esc(c.data.title || 'Chat')}</b><span>${esc(day(c.data.at || 0))}${pg && live(pg) ? ' · ' + esc(pg.data.title || 'Untitled page') : ''} · ${n} question${n === 1 ? '' : 's'} · ${c.data.mode === 'solve' ? 'Solve' : c.data.mode === 'practice' ? 'Practice' : 'Tutor'}</span></button><button class="ah-del" title="Delete this chat" aria-label="Delete chat"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button></div>`;
    }).join('') : '<div class="ask-empty">No saved chats yet. Every chat with Claude is kept here.</div>');
  },
  showChat(){
    this.histOpen = false; $('askPanel').classList.remove('hist');
    $('askLog').innerHTML = '';
    if(!this.view.length){ this.empty(); return; }
    for(const v of this.view){
      if(v.who === 'user'){
        const d = this.bubble('user', (v.a ? '<img alt="Scanned question">' : '') + esc(v.text || '').replace(/\n/g, '<br>'));
        if(v.a){ const img = d.querySelector('img'); const b = this.b64.get(v.a); if(b) img.src = 'data:image/jpeg;base64,' + b; else assetURL(v.a).then(u => { if(u) img.src = u; else img.replaceWith(Object.assign(document.createElement('div'), {className: 'am-noimg', textContent: 'Scan not downloaded yet'})); }); }
      } else this.botBubble(v.text, v.model);
    }
    $('askLog').scrollTop = $('askLog').scrollHeight;
  },
  load(id){
    const c = docs.get(id); if(!c || !live(c)) return;
    if(this.ctrl) this.ctrl.abort();
    this.busy = false; $('askSend').disabled = false;
    this.chatId = id; this.msgs = structuredClone(c.data.msgs || []); this.view = structuredClone(c.data.view || []);
    this.mode = c.data.mode === 'practice' ? 'practice' : null;
    if(!this.mode && c.data.mode && c.data.mode !== prefs.askMode){ prefs.askMode = c.data.mode; savePrefs(); }
    this.renderMode();
    this.showChat();
  },
  renderMode(){
    const sel = $('askModeSel');
    sel.value = this.mode === 'practice' ? 'practice' : (prefs.askMode === 'solve' ? 'solve' : 'tutor');
    sel.title = {tutor: 'Tutor: explains and gives hints, you solve it', solve: 'Solve: shows the full worked solution', practice: 'Practice: Claude quizzes you on pages you pick'}[sel.value];
    this.renderPending && this.renderPending();
  },
  reset(){ if(this.ctrl) this.ctrl.abort(); this.mode = null; this.renderMode(); this.pending = null; this.renderPending(); this.msgs = []; this.view = []; this.chatId = null; this.busy = false; this.histOpen = false; $('askPanel').classList.remove('hist'); this.empty(); $('askSend').disabled = false; },
  bubble(cls, html){
    const log = $('askLog');
    const em = log.querySelector('.ask-empty'); if(em) em.remove();
    const d = document.createElement('div'); d.className = 'am ' + cls; d.innerHTML = html;
    log.appendChild(d); log.scrollTop = log.scrollHeight;
    return d;
  },
  // what is typed on the open page (text boxes, formulas, form fields), top to bottom
  pageText(box){
    if(!cur) return '';
    const parts = [];
    for(const it of cur.items.values()){
      if(box){ const b = itemBox(it); if(b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]) continue; }
      let t = '';
      if(it.t === 'x') t = htmlText(it.html);
      else if(it.t === 'm') t = '$' + it.tex + '$';
      else if(it.t === 'i' && it.f) t = fieldText(it).trim();
      if(t) parts.push([it.y, it.x, t]);
    }
    parts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return parts.map(p => p[2]).join('\n').slice(0, 8000);
  },
  async capture(x0, y0, x1, y1){
    const pad = 6; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const w = x1 - x0, h = y1 - y0, s = clamp(1500 / Math.max(w, h), 0.2, 3);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
    const inBox = it => { const b = itemBox(it); return !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1); };
    const all = [...cur.items.values()].filter(inBox);
    for(const it of all.filter(i => i.t === 'i')){
      try {
        const img = new Image(); img.src = await assetURL(it.a); await img.decode();
        ctx.drawImage(img, it.x, it.y, it.w, it.h);
      } catch {}
      if(it.f){ ctx.fillStyle = '#18212B'; for(const f of it.f){ if(f.k === 'tx' && f.v){ ctx.font = `${Math.max(8, f.h * it.h * 0.6)}px sans-serif`; ctx.fillText(String(f.v), it.x + f.x * it.w + 2, it.y + (f.y + f.h * 0.75) * it.h); } } }
    }
    for(const it of all.filter(i => i.t === 's').sort((a, b) => (b.hl || 0) - (a.hl || 0))){
      ctx.globalAlpha = (it.hl ? 0.4 : 1) * opOf(it); ctx.fillStyle = inkColor(it.c, true, true); ctx.fill(strokePath(it, false));
    }
    ctx.globalAlpha = 1;
    for(const it of all.filter(i => i.t === 'x' || i.t === 'm')){
      const fsz = it.t === 'x' ? 16 * (it.fs || 1) : (it.fs || 22) * 0.8, maxW = it.t === 'x' ? it.w : 2000;
      ctx.fillStyle = '#18212B'; ctx.font = (it.t === 'm' ? 'italic ' : '') + fsz + 'px sans-serif';
      const words = (it.t === 'x' ? htmlText(it.html) : it.tex).split(/\s+/); let line = '', y = it.y + fsz;
      for(const wd of words){ const tl = line ? line + ' ' + wd : wd; if(ctx.measureText(tl).width > maxW && line){ ctx.fillText(line, it.x, y); y += fsz * 1.35; line = wd; } else line = tl; }
      if(line) ctx.fillText(line, it.x, y);
    }
    // hide-answer tape stays closed for Claude too
    for(const it of all.filter(i => i.t === 'tp')){ ctx.fillStyle = '#E9B949'; ctx.fillRect(it.x, it.y, it.w, it.h); }
    return c.toDataURL('image/jpeg', 0.85);
  },
  async scan(x0, y0, x1, y1){
    this.open();
    let url;
    try { url = await this.capture(x0, y0, x1, y1); } catch(e){ this.bubble('err', 'Could not read that part of the page: ' + esc(e.message || e)); return; }
    const typed = this.pageText([x0, y0, x1, y1]);
    // attach the scan to the message box; it goes out when Send is tapped, with whatever is typed
    this.pending = {url, typed, box: [x0, y0, x1, y1]};
    this.renderPending();
    if(this.histOpen) this.showChat();
    try { $('askIn').focus({preventScroll: true}); } catch {}
  },
  renderPending(){
    const a = $('askAtt'), p = this.pending;
    a.hidden = !p;
    if(p) a.querySelector('img').src = p.url;
    $('askIn').placeholder = this.mode === 'practice' ? (p ? 'Add a note, or just Send' : 'Your answer, or scan your work') : p ? 'Ask about the scan, or just Send' : 'Ask about your notes…';
    $('askSend').disabled = this.busy;
  },
  // Send button / Enter: typed text, plus the attached scan if there is one
  submit(){
    const t = $('askIn').value.trim(), p = this.pending;
    if(!t && !p) return;
    if(this.busy) return;
    $('askIn').value = ''; autoGrow();
    this.pending = null; this.renderPending();
    if(p) this.send(t || (this.mode === 'practice' ? 'Here is my answer.' : prefs.askMode === 'solve' ? 'Solve this question.' : 'Help me with this question.'), p.url, p.typed, p.box);
    else this.send(t);
  },
  // API form of the chat: scans stored as assets go back in as base64
  async apiMsgs(){
    const out = [];
    for(const m of this.msgs){
      const content = [];
      for(const c of m.content){
        if(c.type === 'image' && c.a){
          let b = this.b64.get(c.a);
          if(!b){ b = await assetB64(c.a); if(b) this.b64.set(c.a, b); }
          if(b) content.push({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: b}});
        } else content.push(c);
      }
      out.push({role: m.role, content});
    }
    return out;
  },
  async saveChat(){
    const first = this.view.find(v => v.who === 'user');
    const auto = /^(Solve this question\.|Help me with this question\.)$/;
    const page = first && first.page && getDoc(first.page);
    const title = first ? (first.text && !auto.test(first.text) ? first.text.split('\n')[0] : 'Scanned question' + (page && page.data.title ? ' · ' + page.data.title : '')) : 'Chat';
    const data = {title: title.slice(0, 80), at: Date.now(), page: first && first.page || null, mode: this.mode || prefs.askMode || 'tutor', msgs: this.msgs, view: this.view};
    const rec = this.chatId && docs.get(this.chatId);
    if(rec && live(rec)){ rec.data = data; await writeDoc(rec); }
    else { const r = await newDoc('chat', data); this.chatId = r.id; }
  },
  botBubble(text, model){
    const out = this.bubble('bot', renderMd(text));
    this.decorateBot(out, text, model);
    return out;
  },
  decorateBot(out, text, model){
    if(model) out.insertAdjacentHTML('beforeend', `<div class="am-model">${esc(model)}</div>`);
    const bar = document.createElement('div'); bar.className = 'am-acts';
    bar.innerHTML = `<button class="am-put" title="Put this answer on the page next to the question"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Put on page</button>`;
    bar.querySelector('.am-put').addEventListener('click', () => putAnswer(text, this.boxFor(out)));
    out.appendChild(bar);
  },
  // the scan box of the question this answer belongs to
  boxFor(el){
    const bots = [...$('askLog').querySelectorAll('.am.bot')], i = bots.indexOf(el);
    const answers = this.view.filter(v => v.who === 'bot');
    const v = answers[i]; if(!v) return null;
    const k = this.view.indexOf(v);
    for(let j = k - 1; j >= 0; j--) if(this.view[j].who === 'user') return this.view[j].box && this.view[j].page ? {box: this.view[j].box, page: this.view[j].page} : null;
    return null;
  },
  async send(text, imgURL, typedInScan, box, opts){
    if(this.busy) return;
    if(!text && !imgURL) return;
    opts = opts || {};
    if(this.histOpen) this.showChat();
    if(!Sync.sb){ this.bubble('err', 'Claude works through your sync account. Sync is not set up on this device.'); return; }
    const {data} = await Sync.sb.auth.getSession();
    const session = data && data.session;
    if(!session){ this.bubble('err', 'Sign in first: Settings (gear, top left) → Sync.'); return; }
    const content = [];
    let assetId = null;
    if(imgURL){
      // keep the scan as an asset so the chat history can show it and send it again later
      try { assetId = await saveAsset(await (await fetch(imgURL)).blob()); this.b64.set(assetId, imgURL.split(',')[1]); content.push({type: 'image', a: assetId}); }
      catch { content.push({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: imgURL.split(',')[1]}}); }
    }
    let full = text;
    if(typedInScan) full += '\n\n[Typed text inside the scanned area]\n' + typedInScan;
    if(opts.content){ content.push(...opts.content); full = null; }
    else if(!this.msgs.length && cur){
      const page = getDoc(cur.id), title = page ? (page.data.title || '').trim() : '';
      const pt = this.pageText(null);
      full += `\n\n[Open page in my notes${title ? ': "' + title + '"' : ''}]` + (pt ? '\nTyped text on the page:\n' + pt : '\n(no typed text on this page, only handwriting or imported pages)');
    }
    if(full !== null) content.push({type: 'text', text: full});
    this.msgs.push({role: 'user', content});
    const uv = {who: 'user', text}; if(assetId) uv.a = assetId; if(box && cur){ uv.box = box.map(v => Math.round(v * 10) / 10); uv.page = cur.id; } else if(cur) uv.page = cur.id;
    this.view.push(uv);
    this.bubble('user', (imgURL ? `<img src="${imgURL}" alt="Scanned question">` : '') + esc(text).replace(/\n/g, '<br>'));
    const out = this.bubble('bot', '<span class="typing"></span>');
    this.busy = true; $('askSend').disabled = true;
    let acc = '', last = 0;
    const paint = force => { const now = performance.now(); if(!force && now - last < 120) return; last = now; out.innerHTML = renderMd(acc) || '<span class="typing"></span>'; const log = $('askLog'); if(log.scrollHeight - log.scrollTop - log.clientHeight < 140) log.scrollTop = log.scrollHeight; };
    try {
      this.ctrl = new AbortController();
      const res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/ask', {
        method: 'POST', signal: this.ctrl.signal,
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token, apikey: CFG.SUPABASE_ANON_KEY},
        body: JSON.stringify({mode: this.mode || prefs.askMode || 'tutor', model: prefs.askModel || 'auto', messages: await this.apiMsgs()})
      });
      if(!res.ok){
        let j = {}; try { j = await res.json(); } catch {}
        const why = {not_allowed: 'This account is not allowed to use Claude yet. Your email has to be added to ASK_ALLOWED_EMAILS in Supabase (Edge Functions → Secrets).', no_key: 'Claude is not set up yet: the Anthropic API key is missing in Supabase (Edge Functions → Secrets → ANTHROPIC_API_KEY).', too_big: 'That was too much at once. Start a new chat (+) and scan a smaller part.', limit_reached: j.message || 'This month\'s Claude limit is used up.'}[j.error];
        throw new Error(why || (res.status === 404 ? 'The Claude helper is not installed on the server yet.' : (j.message || j.error || 'Server error ' + res.status)));
      }
      const used = res.headers.get('x-ask-model') || '';
      const usedName = /haiku/i.test(used) ? 'Haiku (fast)' : /sonnet/i.test(used) ? 'Sonnet (smart)' : used;
      await readSSE(res, t => { acc += t; paint(); });
      paint(true);
      if(!acc) throw new Error('No answer came back');
      const modelLine = usedName ? usedName + ((prefs.askModel || 'auto') === 'auto' ? ', picked automatically' : '') : '';
      this.decorateBot(out, acc, modelLine);
      this.msgs.push({role: 'assistant', content: [{type: 'text', text: acc}]});
      this.view.push({who: 'bot', text: acc, model: modelLine});
      this.saveChat().catch(e => console.warn('chat save', e));
    } catch(e){
      this.msgs.pop(); this.view.pop();   // let the question be asked again
      if(e.name === 'AbortError'){ out.remove(); }
      else { out.className = 'am err'; out.textContent = /Failed to fetch|Load failed|NetworkError/i.test(e.message) ? 'No connection to the server. Check the internet and try again.' : e.message; }
    }
    this.busy = false; this.ctrl = null; $('askSend').disabled = false;
  }
};
// Small Markdown renderer for answers: paragraphs, lists, headings, bold/italic, code, and $math$ via KaTeX.
function renderMd(src){
  const math = [];
  const keep = (tex, display) => { math.push([tex, display]); return '\u0000' + (math.length - 1) + '\u0000'; };
  let s = String(src || '')
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => keep(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => keep(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => keep(t, false))
    .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, pre, t) => pre + keep(t, false));
  s = esc(s);
  const inline = t => t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  const out = []; let list = null, para = [];
  const flushP = () => { if(para.length){ out.push('<p>' + inline(para.join('<br>')) + '</p>'); para = []; } };
  const flushL = () => { if(list){ out.push(`<${list.t}>` + list.items.map(i => '<li>' + inline(i) + '</li>').join('') + `</${list.t}>`); list = null; } };
  for(const raw of s.split('\n')){
    const line = raw.trimEnd();
    let m;
    if(!line.trim()){ flushP(); flushL(); continue; }
    if((m = /^\s*#{1,6}\s+(.*)$/.exec(line))){ flushP(); flushL(); out.push('<h4>' + inline(m[1]) + '</h4>'); continue; }
    if((m = /^\s*[-*•]\s+(.*)$/.exec(line))){ flushP(); if(!list || list.t !== 'ul'){ flushL(); list = {t: 'ul', items: []}; } list.items.push(m[1]); continue; }
    if((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))){ flushP(); if(!list || list.t !== 'ol'){ flushL(); list = {t: 'ol', items: []}; } list.items.push(m[1]); continue; }
    if(list && /^\s{2,}/.test(raw)){ list.items[list.items.length - 1] += '<br>' + line.trim(); continue; }
    flushL(); para.push(line);
  }
  flushP(); flushL();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const [tex, display] = math[+i];
    try { return window.katex ? katex.renderToString(tex, {displayMode: display, throwOnError: false}) : esc(tex); } catch { return esc(tex); }
  });
}
$('askBtn').addEventListener('click', () => {
  if(!cur){ Ask.open(); return; }
  Ask.open();
  startPick({kind: 'scan'}, 'Drag a box around the question');
});
$('askScan').addEventListener('click', () => startPick({kind: 'scan'}, 'Drag a box around the question'));
$('scanBarX').addEventListener('click', () => endPick());
$('askClose').addEventListener('click', () => { if(pick && pick.kind === 'scan') endPick(); Ask.close(); });
$('askMin').addEventListener('click', () => $('askPanel').classList.toggle('min'));
$('askNew').addEventListener('click', () => Ask.reset());
$('askHist').addEventListener('click', () => { if(Ask.histOpen) Ask.showChat(); else Ask.showHistory(); });
$('askLog').addEventListener('click', async e => {
  if(e.target.closest('.ah-back')){ Ask.showChat(); return; }
  const row = e.target.closest('.ah-row'); if(!row) return;
  const id = row.dataset.chat;
  if(e.target.closest('.ah-del')){
    if(id === Ask.chatId){ Ask.reset(); }
    await removeDoc(id, 'chat', null, true);
    Ask.showHistory(); toast('Chat deleted');
    return;
  }
  if(e.target.closest('.ah-open')) Ask.load(id);
});
// one dropdown: Tutor / Solve change how Claude answers; Practice opens the practice setup.
// Leaving a practice chat for Tutor or Solve starts a new chat (the practice stays in the history).
$('askModeSel').addEventListener('change', () => {
  const v = $('askModeSel').value;
  if(v === 'practice'){
    if(Ask.mode !== 'practice') Prac.open();
    Ask.renderMode();   // switches to Practice only when a practice actually starts
    return;
  }
  prefs.askMode = v; savePrefs();
  if(Ask.mode === 'practice') Ask.reset(); else Ask.renderMode();
});
$('askSend').addEventListener('click', () => Ask.submit());
$('askAttX').addEventListener('click', () => { Ask.pending = null; Ask.renderPending(); });
function autoGrow(){ const t = $('askIn'); t.style.height = 'auto'; t.style.height = Math.min(120, t.scrollHeight) + 'px'; }
$('askIn').addEventListener('input', autoGrow);
$('askIn').addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); $('askSend').click(); } });
{
  // drag the window by its title bar
  let drag = null;
  $('askHead').addEventListener('pointerdown', e => {
    if(e.target.closest('button')) return;
    const r = $('askPanel').getBoundingClientRect();
    drag = {dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId};
    $('askHead').setPointerCapture(e.pointerId);
  });
  $('askHead').addEventListener('pointermove', e => {
    if(!drag || e.pointerId !== drag.id) return;
    const p = $('askPanel'), x = clamp(e.clientX - drag.dx, 4, innerWidth - 120), y = clamp(e.clientY - drag.dy, 4, innerHeight - 50);
    Object.assign(p.style, {left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto'});
  });
  const up = () => { if(!drag) return; drag = null; const r = $('askPanel').getBoundingClientRect(); LSset('inkwell.askPos', {x: r.left, y: r.top}); };
  $('askHead').addEventListener('pointerup', up); $('askHead').addEventListener('pointercancel', up);
}

/* =====================================================================
   Practice: tick pages (learning objectives, exercise sheets, notes) and/or add files; Claude quizzes you
   one exercise at a time and checks the answers. Runs as an Ask Claude chat with mode 'practice'.
   The material goes in the first message (marked for prompt caching, so later turns cost little).
   ===================================================================== */
const PRAC_MAX = 60000;
const Prac = {
  nb: null, picked: new Set(), files: [], busy: false,
  open(){
    if(!Sync.sb || !Sync.user){ toast('Practice works through your sync account: sign in first (Settings → Sync).'); return; }
    this.nb = ui.nb && getDoc(ui.nb) ? ui.nb : (notebooks()[0] || {}).id;
    if(cur && !this.picked.size) this.picked.add(cur.id);
    this.render(); showModal('practiceDlg');
  },
  render(){
    const nbs = notebooks();
    $('pracNb').innerHTML = nbs.map(n => `<option value="${n.id}" ${n.id === this.nb ? 'selected' : ''}>${esc(n.data.name)}</option>`).join('');
    let h = '';
    for(const s of sectionsOf(this.nb)){
      const pages = pagesOf(s.id); if(!pages.length) continue;
      const all = pages.every(p => this.picked.has(p.id));
      h += `<label class="prac-sec"><input type="checkbox" data-sec="${s.id}" ${all ? 'checked' : ''}><span class="tab" style="--c:var(--t${(s.data.color || 0) % TABS})"></span>${esc(s.data.name)}</label>`;
      h += pages.map(p => `<label class="prac-page"><input type="checkbox" data-pg="${p.id}" ${this.picked.has(p.id) ? 'checked' : ''}><span>${esc(p.data.title || 'Untitled page')}</span></label>`).join('');
    }
    $('pracList').innerHTML = h || '<div class="hint" style="padding:10px">No pages in this notebook.</div>';
    $('pracFiles').innerHTML = this.files.map((f, i) => `<span class="prac-file">${esc(f.name)}<button data-rmfile="${i}" aria-label="Remove ${esc(f.name)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></span>`).join('');
    this.info();
  },
  async info(){
    if(this.busy) return;
    const n = this.picked.size, f = this.files.length;
    if(!n && !f){ $('pracInfo').textContent = 'Tick at least one page or add a file.'; $('pracGo').disabled = true; return; }
    $('pracGo').disabled = false;
    const text = await this.material(false);
    const len = text.length;
    $('pracInfo').textContent = `${n} page${n === 1 ? '' : 's'}${f ? `, ${f} file${f === 1 ? '' : 's'}` : ''} · about ${len.toLocaleString('de-CH')} characters` + (len > PRAC_MAX ? `. That is more than Claude gets (${PRAC_MAX.toLocaleString('de-CH')}); the rest is cut off, so pick fewer pages for better exercises.` : '.') + (this.unread ? ` ${this.unread} part${this.unread === 1 ? '' : 's'} (handwriting or scans) will be read first.` : '');
  },
  // the text of the picked pages and files; read = true first lets Claude read handwriting and scans not read yet
  async material(read){
    let out = '', unread = 0, step = 0;
    const ids = [...this.picked].filter(id => getDoc(id));
    for(const pid of ids){
      const page = getDoc(pid), sec = getDoc(page.data.sec);
      let items;
      if(cur && cur.id === pid) items = [...cur.items.values()];
      else { const rec = await IDB.get('docs', 'c_' + pid); items = rec && !rec.deleted && rec.data ? (rec.data.items || []).map(deser).filter(Boolean) : []; }
      const pics = pagePictures(items), strokes = items.filter(it => it.t === 's' && !it.hl);
      if(read){
        step++; $('pracInfo').textContent = `Reading page ${step} of ${ids.length}…`;
        try { if(strokes.length && HW.stale(page, strokes)) await HW.readPage(pid); } catch(e){ console.warn('practice hw', e); }
        for(const it of pics) if(!ptxtOf(it.a)){ try { await savePtxt(it.a, 'ocr', await ocrAsset(it.a)); } catch(e){ console.warn('practice ocr', e); } }
      } else {
        if(strokes.length && HW.stale(page, strokes)) unread++;
        unread += pics.filter(it => !ptxtOf(it.a)).length;
      }
      const typed = items.filter(it => it.t === 'x' || it.t === 'm' || (it.t === 'i' && it.f)).sort((a, b) => a.y - b.y || a.x - b.x)
        .map(it => it.t === 'x' ? htmlText(it.html) : it.t === 'm' ? '$' + it.tex + '$' : fieldText(it).trim()).filter(Boolean).join('\n');
      const fresh = getDoc(pid);
      let block = `\n\n### Page: ${fresh.data.title || 'Untitled page'}${sec ? ' (section ' + sec.data.name + ')' : ''}\n`;
      if(typed) block += `Typed:\n${typed}\n`;
      const hw = HW.text(fresh); if(hw) block += `Handwriting (read by Claude):\n${hw}\n`;
      pics.forEach((it, i) => { const t = ptxtText(ptxtOf(it.a)); if(t) block += `Imported page ${i + 1}:\n${t}\n`; });
      out += block;
    }
    for(const f of this.files) out += `\n\n### File: ${f.name}\n${f.text}\n`;
    if(!read) this.unread = unread;
    return out.trim();
  },
  async addFiles(list){
    for(const file of list){
      const entry = {name: file.name, text: ''};
      this.busy = true; $('pracGo').disabled = true;
      try {
        if(file.type === 'application/pdf' || /\.pdf$/i.test(file.name)){
          const pdf = await pdfjsLib.getDocument({data: new Uint8Array(await file.arrayBuffer())}).promise;
          const n = Math.min(pdf.numPages, 40), parts = [];
          for(let i = 1; i <= n; i++){
            $('pracInfo').textContent = `Reading ${file.name}: page ${i} of ${n}…`;
            const page = await pdf.getPage(i);
            let l = await pdfLines(page);
            if(!hasRealText(l)){
              page.cleanup();
              const r = await renderPdfPage(pdf, i, 1400);
              const url = r.canvas.toDataURL('image/jpeg', 0.82); r.canvas.width = r.canvas.height = 1;
              l = parseOcr(await claudeJob('ocr', url, 'Transcribe this page.'));
            } else page.cleanup();
            parts.push(l.map(x => x[1]).join('\n'));
          }
          entry.text = parts.map((t, i) => `Page ${i + 1}:\n${t}`).join('\n');
          if(pdf.numPages > n) entry.text += `\n(only the first ${n} of ${pdf.numPages} pages)`;
        } else if(file.type.startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(file.name)){
          $('pracInfo').textContent = `Reading ${file.name}…`;
          const bmp = await createImageBitmap(file), k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
          const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
          const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height); if(bmp.close) bmp.close();
          entry.text = parseOcr(await claudeJob('ocr', c.toDataURL('image/jpeg', 0.82), 'Transcribe this page.')).map(x => x[1]).join('\n');
          c.width = c.height = 1;
        } else { toast(file.name + ': only PDFs and photos can be added.'); continue; }
        if(entry.text.trim()) this.files.push(entry); else toast('No text found in ' + file.name);
      } catch(e){ console.warn('practice file', e); toast(file.name + ': ' + (e.code ? jobWhy(e.code) : 'could not be read.')); }
      finally { this.busy = false; }
    }
    this.render();
  },
  async start(){
    if(this.busy) return;
    this.busy = true; $('pracGo').disabled = true;
    let text;
    try { text = await this.material(true); } finally { this.busy = false; $('pracGo').disabled = false; }
    if(!text.trim()){ $('pracInfo').textContent = 'Nothing to practise from: the picked pages have no text that Claude can use yet.'; return; }
    const cut = text.length > PRAC_MAX;
    if(cut) text = text.slice(0, PRAC_MAX) + '\n(… cut off here, the material was too long)';
    const focus = $('pracFocus').value.trim();
    const names = [...this.picked].map(id => getDoc(id)).filter(Boolean).map(p => p.data.title || 'Untitled page').concat(this.files.map(f => f.name));
    const label = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
    hideModal('practiceDlg');
    Ask.reset(); Ask.mode = 'practice'; Ask.open();
    const content = [
      {type: 'text', text: '<material>\n' + text + '\n</material>', cache_control: {type: 'ephemeral'}},
      {type: 'text', text: (focus ? 'Focus: ' + focus + '\n' : '') + 'Quiz me on this material. Start with Exercise 1.'}
    ];
    Ask.send('Practice: ' + label + (focus ? '\nFocus: ' + focus : ''), null, null, null, {content});
  }
};
$('pracNb').addEventListener('change', () => { Prac.nb = $('pracNb').value; Prac.render(); });
$('pracList').addEventListener('change', e => {
  const t = e.target;
  if(t.dataset.pg){ if(t.checked) Prac.picked.add(t.dataset.pg); else Prac.picked.delete(t.dataset.pg); }
  if(t.dataset.sec){ for(const p of pagesOf(t.dataset.sec)){ if(t.checked) Prac.picked.add(p.id); else Prac.picked.delete(p.id); } }
  Prac.render();
});
$('pracFiles').addEventListener('click', e => { const b = e.target.closest('[data-rmfile]'); if(!b) return; Prac.files.splice(+b.dataset.rmfile, 1); Prac.render(); });
$('pracAdd').addEventListener('click', () => $('pracFile').click());
$('pracFile').addEventListener('change', () => { const fs = [...$('pracFile').files]; $('pracFile').value = ''; if(fs.length) Prac.addFiles(fs); });
$('pracGo').addEventListener('click', () => Prac.start());
$('mPractice').addEventListener('click', () => { closePops(); Prac.open(); });

/* =====================================================================
   Claude helpers shared by Ask, handwriting search and "to formula"
   ===================================================================== */
// Reads the server-sent events of a streamed Claude answer and hands over each piece of text.
async function readSSE(res, onText){
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  for(;;){
    const {value, done} = await reader.read(); if(done) break;
    buf += dec.decode(value, {stream: true});
    let k;
    while((k = buf.indexOf('\n\n')) >= 0){
      const chunk = buf.slice(0, k); buf = buf.slice(k + 2);
      for(const line of chunk.split('\n')){
        if(!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if(ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') onText(ev.delta.text);
        else if(ev.type === 'error') throw new Error((ev.error && ev.error.message) || 'Claude stopped with an error');
      }
    }
  }
}
async function assetB64(id){
  try {
    let rec = await IDB.get('assets', id);
    if(!rec) rec = await Sync.fetchAsset(id);
    if(!rec) return null;
    return await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(rec.blob); });
  } catch { return null; }
}
// One background job on the server ('read' or 'latex'): image in, text out.
async function claudeJob(mode, jpegURL, prompt){
  const err = code => Object.assign(new Error(code), {code});
  if(!Sync.sb) throw err('no_sync');
  if(!navigator.onLine) throw err('offline');
  const {data} = await Sync.sb.auth.getSession();
  const session = data && data.session;
  if(!session) throw err('not_signed_in');
  let res;
  try {
    res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/ask', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token, apikey: CFG.SUPABASE_ANON_KEY},
      body: JSON.stringify({mode, messages: [{role: 'user', content: [{type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: jpegURL.split(',')[1]}}, {type: 'text', text: prompt}]}]})
    });
  } catch { throw err('offline'); }
  if(!res.ok){ let j = {}; try { j = await res.json(); } catch {} throw err(j.error || 'http_' + res.status); }
  let acc = '';
  await readSSE(res, t => { acc += t; });
  return acc.trim();
}
// Strokes drawn black on white, cropped to their box (for Claude to read).
function inkImage(strokes, maxPx){
  let b = null;
  for(const it of strokes){ const q = strokeBox(it); b = b ? boxUnion(b, q) : q; }
  if(!b) return null;
  const pad = 14, x0 = b[0] - pad, y0 = b[1] - pad, w = b[2] - b[0] + 2 * pad, h = b[3] - b[1] + 2 * pad;
  const s = clamp(maxPx / Math.max(w, h), 0.15, 2.5);
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
  for(const it of strokes){ ctx.fillStyle = inkColor(it.c, true); ctx.fill(strokePath(it, false)); }
  const url = c.toDataURL('image/jpeg', 0.82);
  c.width = c.height = 1;
  return {url, box: b};
}
// Anthropic's API refuses to copy out some printed material (e.g. published books): not an error to retry
const jobBlocked = e => /content filter|output blocked/i.test(String((e && (e.code || e.message)) || ''));
const jobWhy = code => ({not_allowed: 'This account is not allowed to use Claude (ASK_ALLOWED_EMAILS in Supabase).', no_key: 'The Anthropic API key is missing in Supabase.', not_signed_in: 'Sign in to sync first.', no_sync: 'Sync is not set up on this device.', offline: 'No internet connection.', limit_reached: 'This month\'s Claude limit is used up; it resets on the 1st.'}[code] || 'Claude could not be reached (' + code + ').');

/* =====================================================================
   Put an Ask Claude answer on the page
   ===================================================================== */
const GREEK = {alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', omega: 'ω', eta: 'η', Delta: 'Δ', Omega: 'Ω', Sigma: 'Σ', Phi: 'Φ', Gamma: 'Γ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π'};
const SUP = {'0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '+': '⁺', 'n': 'ⁿ'};
const SUB = {'0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉'};
// Inline maths as readable plain text for a text box (the text box cannot show LaTeX).
function texPlain(t){
  let s = String(t);
  for(let i = 0; i < 6; i++){
    const before = s;
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => (/^[\w.]+$/.test(a) ? a : '(' + a + ')') + '/' + (/^[\w.]+$/.test(b) ? b : '(' + b + ')'))
         .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, a) => '√' + (/^[\w.]+$/.test(a) ? a : '(' + a + ')'))
         .replace(/\\(?:text|mathrm|mathbf|operatorname|mathit)\s*\{([^{}]*)\}/g, '$1');
    if(s === before) break;
  }
  s = s.replace(/\^\{?\\circ\}?/g, '°').replace(/\\degree/g, '°')
       .replace(/\^\{([0-9+\-n]+)\}|\^([0-9+\-n])/g, (_, a, b) => [...(a || b)].map(ch => SUP[ch] || ch).join(''))
       .replace(/_\{([0-9]+)\}|_([0-9])/g, (_, a, b) => [...(a || b)].map(ch => SUB[ch] || ch).join(''))
       .replace(/\\(cdot)/g, '·').replace(/\\times/g, '×').replace(/\\div/g, '÷').replace(/\\pm/g, '±').replace(/\\approx/g, '≈')
       .replace(/\\neq?/g, '≠').replace(/\\le(q)?/g, '≤').replace(/\\ge(q)?/g, '≥').replace(/\\infty/g, '∞').replace(/\\(?:right|Right)arrow|\\to/g, '→')
       .replace(/\\Rightarrow/g, '⇒').replace(/\\left|\\right/g, '').replace(/\\[,;:!]|\\quad|\\qquad|~/g, ' ')
       .replace(/\\([A-Za-z]+)/g, (m, w) => GREEK[w] || w).replace(/[{}]/g, '').replace(/\s{2,}/g, ' ');
  return s.trim();
}
function mdInline(t){
  return esc(t).replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
}
// Answer (Markdown + LaTeX) -> page items: text boxes for text, formulas for display maths.
function answerBlocks(md){
  const blocks = [];
  let s = String(md || '').replace(/\r/g, '');
  // display maths becomes its own block
  s = s.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => '\n\n\u0001' + (a || b).trim().replace(/\n/g, ' ') + '\u0001\n\n');
  for(const part of s.split(/\n{2,}/)){
    const p = part.trim(); if(!p) continue;
    const m = /^\u0001([\s\S]*)\u0001$/.exec(p);
    if(m){ blocks.push({t: 'm', tex: m[1]}); continue; }
    const inl = x => mdInline(x.replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => '\u0002' + t + '\u0002').replace(/\$([^$\n]+?)\$/g, (_, t) => '\u0002' + t + '\u0002')).replace(/\u0002([^\u0002]*)\u0002/g, (_, t) => texPlain(t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')));
    const lines = p.split('\n');
    if(lines.every(l => /^\s*([-*•]|\d+[.)])\s+/.test(l) || /^\s{2,}/.test(l))){
      const ordered = /^\s*\d/.test(lines[0]);
      const items = []; for(const l of lines){ const mm = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l); if(mm) items.push(mm[1]); else if(items.length) items[items.length - 1] += ' ' + l.trim(); }
      blocks.push({t: 'x', html: ordered ? items.map((it, i) => `<p>${i + 1}. ${inl(it)}</p>`).join('') : `<ul>${items.map(it => `<li>${inl(it)}</li>`).join('')}</ul>`});
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(lines[0]);
    if(h && lines.length === 1){ blocks.push({t: 'x', html: `<h2>${inl(h[1])}</h2>`}); continue; }
    blocks.push({t: 'x', html: '<p>' + lines.map(inl).join('<br>') + '</p>'});
  }
  return blocks;
}
async function putAnswer(md, src){
  if(!cur){ toast('Open a page first'); return; }
  const blocks = answerBlocks(md);
  if(!blocks.length) return;
  // laid out first, then centred in the middle of what is on screen, selected so it can be dragged right away
  // the visible part of the page that the Claude panel does not cover (screen px, stage coordinates)
  let fx0 = 0, fy0 = 0, fx1 = W, fy1 = H;
  const ap = $('askPanel');
  if(!ap.hidden){
    const r = ap.getBoundingClientRect(), L = r.left - SR.left, T = r.top - SR.top, R = r.right - SR.left, B = r.bottom - SR.top;
    if(R > 0 && L < W && B > 0 && T < H){
      // the biggest free strip beside, above or below the panel (if it is at least 160 px wide/high)
      const opts = [[L, H, () => { fx1 = L - 10; }], [W - R, H, () => { fx0 = R + 10; }], [W, T, () => { fy1 = T - 10; }], [W, H - B, () => { fy0 = B + 10; }]]
        .filter(([w, h]) => w >= 160 && h >= 160).sort((a, b) => b[0] * b[1] - a[0] * a[1]);
      if(opts.length) opts[0][2]();
    }
  }
  const W0 = Math.min(440, Math.max(150, (fx1 - fx0 - 24) / cam.z));
  let x = 0, y = 0;
  const g = 'g' + newId(), added = [];
  for(const b of blocks){
    const id = (b.t === 'm' ? 'm' : 'x') + newId() + Math.random().toString(36).slice(2, 5);
    const it = b.t === 'm' ? {t: 'm', id, x, y, tex: b.tex, fs: 22, c: 'auto', g} : {t: 'x', id, x, y, w: W0, fs: 1, html: cleanHTML(b.html), g};
    setItems([[id, it]]);   // one by one so each box can be measured
    added.push(it);
    const el = elMap.get(id);
    y += (el ? el.offsetHeight : 40) + 6;
  }
  {
    const bb = added.map(itemBox).reduce(boxUnion);
    const [vx0, vy0] = toWorld(fx0, fy0), [vx1, vy1] = toWorld(fx1, fy1);
    const bw = bb[2] - bb[0], bh = bb[3] - bb[1];
    const dx = (vx0 + vx1) / 2 - bw / 2 - bb[0];
    const dy = (bh < (vy1 - vy0) * 0.8 ? (vy0 + vy1) / 2 - bh / 2 : vy0 + (vy1 - vy0) * 0.08) - bb[1];
    for(let k = 0; k < added.length; k++) added[k] = Object.assign({}, added[k], {x: added[k].x + dx, y: added[k].y + dy});
    setItems(added.map(it => [it.id, it]));
  }
  commit(added.map(it => [it.id, null]), added.map(it => [it.id, it]));
  setTool('lasso'); selectIds(added.map(it => it.id));
  toast('Placed in the middle and selected: drag it where you want it.');
}

/* =====================================================================
   Searchable handwriting: Claude (fast model) reads the ink in the background.
   Ink is read in cells of HW_CW x HW_CH world px; a cell is read again only when its strokes change.
   Result per page in page.data.hw = {c: {"cx,cy": {s: signature, t: text}}, at}
   ===================================================================== */
const HW_CW = 1600, HW_CH = 1100;
// Setting "Read handwriting & scans" (prefs.hwSearch): 'on' (true or missing), 'docs' (only imported pages), 'off' (false)
const hwMode = () => prefs.hwSearch === false ? 'off' : prefs.hwSearch === 'docs' ? 'docs' : 'on';
// signed in and allowed to use Claude (1.36: an account that is not allowed is not asked again until Inkwell restarts)
const hwReady = () => !!Sync.sb && !!Sync.user && HW.noAccess !== Sync.user.id;
const HW = {
  queue: [], busy: false, state: '', done: 0, timer: 0, lastScan: 0,
  cells(items){
    const m = new Map();
    for(const it of items){
      if(!it || it.t !== 's' || it.hl || !it.p || it.p.length < 6) continue;
      const b = strokeBox(it), key = Math.floor((b[0] + b[2]) / 2 / HW_CW) + ',' + Math.floor((b[1] + b[3]) / 2 / HW_CH);
      if(!m.has(key)) m.set(key, []);
      m.get(key).push(it);
    }
    return m;
  },
  sig(strokes){
    let h = 5381;
    for(const id of strokes.map(s => s.id).sort()) for(let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
    return strokes.length + ':' + (h >>> 0).toString(36);
  },
  text(page){
    const c = page && page.data.hw && page.data.hw.c; if(!c) return '';
    return Object.keys(c).sort((a, b) => { const [ax, ay] = a.split(',').map(Number), [bx, by] = b.split(',').map(Number); return ay - by || ax - bx; }).map(k => c[k].t || '').join(' ').trim();
  },
  // (1.36) an account that is not allowed to use Claude is not asked again until Inkwell restarts
  on(){ return hwMode() === 'on' && hwReady(); },
  // which pages have ink that has not been read yet
  async scanAll(){
    if(!this.on()) return;
    this.lastScan = Date.now();
    const all = await IDB.all('docs');
    for(const d of all){
      if(d.kind !== 'content' || d.deleted || !d.data) continue;
      const pid = d.id.slice(2), page = getDoc(pid); if(!page) continue;
      if(cur && cur.id === pid) continue;   // the open page is read when it is left
      const raw = (d.data.items || []).filter(s => s && s.t === 's' && !s.hl);
      if(!raw.length){ if(page.data.hw && Object.keys(page.data.hw.c || {}).length) this.enqueue(pid); continue; }
      if(this.stale(page, raw.map(deser))) this.enqueue(pid);
    }
    this.kick();
  },
  stale(page, strokes){
    const have = (page.data.hw && page.data.hw.c) || {}, cells = this.cells(strokes);
    if(cells.size !== Object.keys(have).length) return true;
    for(const [k, list] of cells) if(!have[k] || have[k].s !== this.sig(list)) return true;
    return false;
  },
  enqueue(pid){ if(!this.queue.includes(pid)) this.queue.push(pid); },
  kick(){ if(!this.busy && this.queue.length) { clearTimeout(this.timer); this.timer = setTimeout(() => this.work(), 1500); } renderHwStatus(); },
  async work(){
    if(this.busy || !this.on()) return;
    if(document.visibilityState !== 'visible' || !navigator.onLine){ this.timer = setTimeout(() => this.work(), 20000); return; }
    const pid = this.queue.shift(); if(!pid) return;
    this.busy = true; renderHwStatus();
    try { await this.readPage(pid); this.state = ''; }
    catch(e){
      const c = e.code || '';
      if(c === 'offline'){ this.queue.unshift(pid); this.busy = false; this.timer = setTimeout(() => this.work(), 30000); renderHwStatus(); return; }
      if(['not_allowed', 'no_key', 'not_signed_in', 'no_sync', 'limit_reached'].includes(c)){ this.state = jobWhy(c); this.queue.length = 0; if(c === 'not_allowed' && Sync.user) HW.noAccess = Sync.user.id; }
      else { this.state = 'Last try failed: ' + jobWhy(c || e.message); console.warn('hw', e); }
    }
    this.busy = false; renderHwStatus();
    if(this.queue.length) this.timer = setTimeout(() => this.work(), 1500);
  },
  async readPage(pid){
    const page = getDoc(pid); if(!page) return;
    let items;
    if(cur && cur.id === pid) items = [...cur.items.values()];
    else { const rec = await IDB.get('docs', 'c_' + pid); if(!rec || rec.deleted || !rec.data) return; items = (rec.data.items || []).map(deser).filter(Boolean); }
    const cells = this.cells(items), old = (page.data.hw && page.data.hw.c) || {}, next = {};
    let changed = Object.keys(old).some(k => !cells.has(k));
    for(const [k, list] of cells){
      const sig = this.sig(list);
      if(old[k] && old[k].s === sig){ next[k] = old[k]; continue; }
      changed = true;
      let n = 0; for(const it of list) n += it.p.length / 3;
      let t = '';
      if(n >= 25){ const img = inkImage(list, 1500); if(img){ try { t = (await claudeJob('read', img.url, 'Transcribe the handwriting.')).slice(0, 4000); } catch(e){ if(!jobBlocked(e)) throw e; } } }
      next[k] = {s: sig, t};
      this.done++;
    }
    if(!changed) return;
    const fresh = getDoc(pid); if(!fresh) return;
    await patchDoc(fresh, {hw: {c: next, at: Date.now()}});
    searchCache = null;
  }
};
function renderHwStatus(){
  const el = $('setHwHint'); if(!el) return;
  const mode = hwMode();
  if(mode === 'off'){ el.textContent = 'Handwriting and scans are not read. Search finds typed text and the text of PDFs.'; return; }
  if(!Sync.sb || !Sync.user){ el.textContent = 'Needs sync sign-in: Claude reads your ' + (mode === 'docs' ? 'imported pages' : 'handwriting and scans') + ' through your account.'; return; }
  const pages = [...docs.values()].filter(d => d.kind === 'page' && live(d) && d.data.hw).length;
  const pts = [...docs.values()].filter(d => d.kind === 'ptxt' && live(d)), nb = pts.filter(d => d.data && d.data.nb).length;
  const pics = pts.length - nb, wait = PT.queue.length + (PT.busy ? 1 : 0);
  if(mode === 'docs'){
    el.textContent = PT.state ? PT.state : `Only imported pages are read: Claude reads scans, photos and Word pages in the background so search finds them (about CHF 0.01 for 20 pages). PDF text is searchable without it. Handwriting is not read. ${pics} imported page${pics === 1 ? '' : 's'} searchable` + (wait ? `, ${wait} being read.` : '.')
      + (nb ? ` ${nb} page${nb === 1 ? '' : 's'} skipped: Claude does not copy out text from some published books.` : '');
    return;
  }
  el.textContent = HW.state || PT.state ? (HW.state || PT.state) : `Claude reads your handwriting and scanned pages in the background so search finds them (about CHF 0.01 for 20 pages). PDF text is searchable without it. ${pages} page${pages === 1 ? '' : 's'} of handwriting read` + (HW.busy || HW.queue.length ? `, ${HW.queue.length + (HW.busy ? 1 : 0)} waiting` : '') + `; ${pics} imported page${pics === 1 ? '' : 's'} searchable` + (wait ? `, ${wait} being read.` : '.')
    + (nb ? ` ${nb} page${nb === 1 ? '' : 's'} skipped: Claude does not copy out text from some published books.` : '');
}
// the open page is read a little after you stop writing, and when you leave it
let hwPageT = 0;
function hwSoon(){
  clearTimeout(hwPageT);
  if(!cur || !HW.on()) return;
  const id = cur.id;
  hwPageT = setTimeout(() => { if(cur && cur.id === id && !act){ HW.enqueue(id); HW.kick(); } }, 45000);
}

/* =====================================================================
   Text of imported pages, for search and practice.
   One doc per page picture: kind 'ptxt', id 'pt_' + asset id, data {a, src, l: [[y, line], ...]}
   y = top of the line as a fraction of the picture height (-1 when unknown). src: 'pdf' (text layer of the PDF,
   read at import, free) or 'ocr' (Claude's fast model read the picture: scans, photos, Word pages, older imports).
   ===================================================================== */
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ptxtOf = a => { const d = docs.get('pt_' + a); return live(d) ? d.data : null; };
const ptxtText = d => d && Array.isArray(d.l) ? d.l.map(x => x[1]).join('\n') : '';
// Lines of a PDF page's text layer, top to bottom (pdf.js text items grouped by baseline).
async function pdfLines(page){
  let tc;
  try { tc = await page.getTextContent(); } catch(e){ console.warn('pdf text', e); return []; }
  const vp = page.getViewport({scale: 1}), H = vp.height || 1, parts = [];
  for(const it of tc.items || []){
    if(!it.str || !it.str.trim()) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const [x, y] = vp.convertToViewportPoint(tr[4], tr[5]);
    const h = Math.abs(it.height) || Math.hypot(tr[2], tr[3]) || 10;
    parts.push({x, y, h, w: Math.abs(it.width) || it.str.length * h * 0.5, s: it.str});
  }
  parts.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for(const p of parts){
    const ln = lines[lines.length - 1];
    if(ln && Math.abs(p.y - ln.y) < Math.min(p.h, ln.h) * 0.5) ln.parts.push(p);
    else lines.push({y: p.y, h: p.h, parts: [p]});
  }
  const out = [];
  let total = 0;
  for(const ln of lines){
    ln.parts.sort((a, b) => a.x - b.x);
    let s = '', end = null;
    for(const p of ln.parts){
      if(end !== null && p.x - end > p.h * 0.18 && !/\s$/.test(s) && !/^\s/.test(p.s)) s += ' ';
      s += p.s; end = p.x + p.w;
    }
    s = s.replace(/\s+/g, ' ').trim();
    if(!s) continue;
    out.push([Math.round(clamp((ln.y - ln.h) / H, 0, 1) * 1000) / 1000, s]);
    total += s.length;
    if(total > 20000) break;
  }
  return out;
}
// enough real text to be worth keeping (otherwise it is a scan and Claude reads the picture)
const hasRealText = l => l.reduce((n, x) => n + (x[1].match(/[\p{L}\p{N}]/gu) || []).length, 0) >= 20;
async function savePtxt(a, src, l, extra){
  const id = 'pt_' + a, old = docs.get(id);
  const data = Object.assign({a, src, l}, extra);   // extra {nb: 1} = Claude would not read it (not retried)
  if(old){ old.data = data; old.deleted = false; await writeDoc(old); }
  else await newDoc('ptxt', data, id);
  searchCache = null;
}
// Claude reads one imported page picture. Lines come back as "NN|text" with NN = vertical position in %.
async function ocrAsset(a){
  let rec = await IDB.get('assets', a);
  if(!rec) rec = await Sync.fetchAsset(a);
  if(!rec) throw Object.assign(new Error('missing'), {code: 'missing'});
  const bmp = await createImageBitmap(rec.blob);
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
  if(bmp.close) bmp.close();
  const url = c.toDataURL('image/jpeg', 0.82); c.width = c.height = 1;
  const raw = await claudeJob('ocr', url, 'Transcribe this page.');
  return parseOcr(raw);
}
function parseOcr(raw){
  const l = [];
  let total = 0;
  for(const line of String(raw || '').split('\n')){
    const t = line.trim(); if(!t) continue;
    const m = /^(\d{1,3})\s*\|\s*(.*)$/.exec(t);
    const y = m ? clamp(+m[1] / 100, 0, 1) : -1, s = (m ? m[2] : t).trim();
    if(!s || /^NO_TEXT$/i.test(s)) continue;
    l.push([Math.round(y * 1000) / 1000, s.slice(0, 600)]);
    total += s.length; if(total > 20000) break;
  }
  return l;
}
// Background reader for page pictures that have no text yet (same on/off setting as handwriting).
const PT = {
  queue: [], busy: false, state: '', done: 0, timer: 0,
  on(){ return hwMode() !== 'off' && hwReady(); },
  // pictures on live pages (open page first) that have no text doc yet
  async scanAll(){
    if(!this.on()) return;
    const all = await IDB.all('docs'), first = [], rest = [];
    for(const d of all){
      if(d.kind !== 'content' || d.deleted || !d.data) continue;
      const pid = d.id.slice(2); if(!getDoc(pid)) continue;
      const items = cur && cur.id === pid ? [...cur.items.values()] : d.data.items || [];
      for(const it of items) if(it && it.t === 'i' && it.a && !docs.has('pt_' + it.a)) (cur && cur.id === pid ? first : rest).push(it.a);
    }
    for(const a of first.concat(rest)) if(!this.queue.includes(a)) this.queue.push(a);
    this.kick();
  },
  soon(){ clearTimeout(this.scanT); this.scanT = setTimeout(() => this.scanAll().catch(() => {}), 3000); },
  kick(){ if(!this.busy && this.queue.length){ clearTimeout(this.timer); this.timer = setTimeout(() => this.work(), 1200); } renderHwStatus(); },
  async work(){
    if(this.busy || !this.on()) return;
    if(document.visibilityState !== 'visible' || !navigator.onLine){ this.timer = setTimeout(() => this.work(), 20000); return; }
    const a = this.queue.shift(); if(!a) return;
    if(docs.has('pt_' + a)){ this.kick(); return; }
    this.busy = true; renderHwStatus();
    try { await savePtxt(a, 'ocr', await ocrAsset(a)); this.done++; this.state = ''; }
    catch(e){
      const c = e.code || '';
      if(jobBlocked(e)){ try { await savePtxt(a, 'ocr', [], {nb: 1}); } catch {} this.state = ''; this.busy = false; renderHwStatus(); if(this.queue.length) this.timer = setTimeout(() => this.work(), 1200); return; }
      if(c === 'offline'){ this.queue.unshift(a); this.busy = false; this.timer = setTimeout(() => this.work(), 30000); renderHwStatus(); return; }
      if(['not_allowed', 'no_key', 'not_signed_in', 'no_sync', 'limit_reached'].includes(c)){ this.state = jobWhy(c); this.queue.length = 0; if(c === 'not_allowed' && Sync.user) HW.noAccess = Sync.user.id; }
      else if(c !== 'missing'){ this.state = 'Last try failed: ' + jobWhy(c || e.message); console.warn('ocr', e); }
    }
    this.busy = false; renderHwStatus();
    if(this.queue.length) this.timer = setTimeout(() => this.work(), 1200);
  }
};
// imported pictures of a page in reading order (top to bottom, then left to right), with their page number
function pagePictures(items){
  return items.filter(it => it && it.t === 'i' && it.a).sort((a, b) => a.y - b.y || a.x - b.x);
}
// Search hits inside imported pages: up to max lines that contain the needle (already folded)
function ptxtHits(pics, needle, max){
  const out = [];
  pics.forEach((it, n) => {
    if(out.length >= max) return;
    const d = ptxtOf(it.a); if(!d || !d.l) return;
    for(let i = 0; i < d.l.length && out.length < max; i++){
      const line = d.l[i][1], f = fold(line);
      let k = f.indexOf(needle), shown = line;
      let pair = false;
      if(k < 0 && i + 1 < d.l.length){
        // a match that runs over the line break, e.g. a word split as "Beschleu-" / "nigung"
        const head = /-$/.test(line) ? line.slice(0, -1) : line + ' ';
        const joined = head + d.l[i + 1][1], kk = fold(joined).indexOf(needle);
        if(kk >= 0 && kk < head.length && kk + needle.length > head.length){ k = kk; shown = joined; pair = true; }
      }
      if(k < 0) continue;
      out.push({id: it.id, n: n + 1, y: d.l[i][0], html: snippetHTML(shown, k, needle.length)});
      if(pair) i++;
    }
  });
  return out;
}
function snippetHTML(s, k, len){
  const a = Math.max(0, k - 50), b = Math.min(s.length, k + len + 70);
  return (a > 0 ? '…' : '') + esc(s.slice(a, k)) + '<mark>' + esc(s.slice(k, k + len)) + '</mark>' + esc(s.slice(k + len, b)) + (b < s.length ? '…' : '');
}
// open page shows the line: picture fills the width, line a third down the screen, yellow band flashes
function jumpToLine(itemId, y){
  const it = cur && cur.items.get(itemId); if(!it) return;
  const fit = (W - 32) / it.w;
  if(cam.z < fit * 0.6 || cam.z > fit * 2.2) cam.z = clamp(fit, Z_MIN, zMax());
  const ly = it.y + (y >= 0 ? y : 0) * it.h;
  cam.ox = (W - it.w * cam.z) / 2 - it.x * cam.z;
  cam.oy = H * (y >= 0 ? 0.33 : 0.04) - ly * cam.z;
  invalidate(); saveCamSoon();
  const f = document.createElement('div');
  f.className = y >= 0 ? 'hit-flash' : 'mark-flash';
  const bandH = Math.max(22, it.h * 0.035);
  f.style.cssText = y >= 0 ? `left:${it.x}px;top:${ly - bandH * 0.25}px;width:${it.w}px;height:${bandH}px` : `left:${it.x - 8}px;top:${it.y - 8}px;width:${it.w + 16}px;height:${it.h + 16}px`;
  worldFront.appendChild(f); frontXf(f);
  setTimeout(() => f.remove(), 2600);
}

/* =====================================================================
   Write to text (toolbar toggle, prefs.autoText): what you write with the pen turns into a typed text box
   a moment after you stop. Claude's fast model reads it (job 'scribe'). One undo step brings the ink back.
   A word written right after a converted one on the same line is added to that text box.
   ===================================================================== */
const SCRIBE_WAIT = 1100;
const Scribe = {
  pending: [], timer: 0, busy: false, again: false, warned: false, recent: new Map(),
  on(){ return !!prefs.autoText; },
  add(it){ if(!this.on() || !cur) return; this.pending.push({id: it.id, page: cur.id}); this.arm(); },
  arm(){ clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), SCRIBE_WAIT); },
  hold(){ clearTimeout(this.timer); },              // the pen is down again: wait for the whole word
  release(){ if(this.pending.length) this.arm(); },
  async run(){
    if(this.busy){ this.again = true; return; }
    if(act && act.kind === 'stroke'){ this.arm(); return; }
    if(!cur || !this.pending.length) return;
    const pid = cur.id;
    const strokes = this.pending.filter(p => p.page === pid).map(p => cur.items.get(p.id)).filter(s => s && s.t === 's');
    this.pending = [];
    if(!strokes.length) return;
    this.busy = true; renderScribe();
    try {
      const img = inkImage(strokes, 1000);
      let text = (await claudeJob('scribe', img.url, 'Convert this handwriting to text.')).replace(/^```\w*\n?|\n?```$/g, '').trim();
      if(!text || /^NOT_TEXT\b/i.test(text)) return;
      if(!cur || cur.id !== pid || strokes.some(s => cur.items.get(s.id) !== s)) return;   // page left or ink changed meanwhile: keep the ink
      this.place(strokes, text, img.box);
    } catch(e){
      if(!this.warned){ this.warned = true; toast('Write to text: ' + jobWhy(e.code || e.message) + ' Your ink stays as it is.'); }
    } finally {
      this.busy = false; renderScribe();
      if(this.again){ this.again = false; if(this.pending.length) this.arm(); }
    }
  },
  font(){ return getComputedStyle(worldFront).fontFamily || 'system-ui, sans-serif'; },
  measure(lines, px){
    const c = this.cv || (this.cv = document.createElement('canvas')), ctx = c.getContext('2d');
    ctx.font = `${px}px ${this.font()}`;
    return Math.max(...lines.map(l => ctx.measureText(l).width));
  },
  place(strokes, text, b){
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if(!lines.length) return;
    const n = lines.length, bh = b[3] - b[1];
    const px = Math.round(clamp(bh / n * 0.62, 10, 90) * 10) / 10;
    // the ink colour carries over (black/auto stays the default text colour)
    const cols = {}; for(const s of strokes) cols[s.c] = (cols[s.c] || 0) + 1;
    const c = Object.keys(cols).sort((x, y) => cols[y] - cols[x])[0] || 'auto';
    const col = c && c !== 'auto' && /^#[0-9a-f]{6}$/i.test(c) && lum(c) > 0.07 && lum(c) < 0.93 ? c : '';
    const wrap = t => col ? `<span style="color:${col}">${esc(t)}</span>` : esc(t);
    const g = strokes[0].g && strokes.every(s => s.g === strokes[0].g) ? strokes[0].g : null;
    const gone = strokes.map(s => [s.id, null]), back = strokes.map(s => [s.id, s]);
    const prev = n === 1 ? this.joinTarget(b, px) : null;
    let out;
    if(prev){
      const html = /<\/p>\s*$/.test(prev.html) ? prev.html.replace(/<\/p>\s*$/, ' ' + wrap(lines[0]) + '</p>') : prev.html + ' ' + wrap(lines[0]);
      const el = elMap.get(prev.id), oldPx = 17 * (prev.fs || 1);
      const w = Math.max(prev.w, this.measure([htmlText(html)], oldPx) + 16, b[2] + 8 - prev.x);
      out = Object.assign({}, prev, {html: cleanHTML(html), w});
      apply(gone.concat([[prev.id, out]]), back.concat([[prev.id, prev]]));
      if(!el) return;
    } else {
      const w = Math.max(40, this.measure(lines, px) + 16);
      const hh = n * px * 1.55 + 4;
      out = {t: 'x', id: 'x' + newId(), x: b[0] - 6, y: (b[1] + b[3]) / 2 - hh / 2, w, fs: Math.round(px / 17 * 1000) / 1000, html: cleanHTML(lines.map(l => '<p>' + wrap(l) + '</p>').join(''))};
      if(g) out.g = g;
      apply(gone.concat([[out.id, out]]), back.concat([[out.id, null]]));
    }
    this.recent.set(out.id, {at: Date.now(), it: out});
  },
  // a text box made by this feature a moment ago, one line, ending just left of the new word
  joinTarget(b, px){
    const now = Date.now();
    for(const [id, r] of this.recent){
      if(now - r.at > 120000){ this.recent.delete(id); continue; }
      const it = cur.items.get(id);
      if(!it || it !== r.it){ this.recent.delete(id); continue; }
      if((it.html.match(/<p>/g) || []).length > 1) continue;
      const el = elMap.get(id); if(!el) continue;
      const fpx = 17 * (it.fs || 1), top = it.y, bottom = it.y + el.offsetHeight, mid = (b[1] + b[3]) / 2;
      if(mid < top || mid > bottom) continue;
      if(Math.abs(fpx - px) > Math.max(fpx, px) * 0.6) continue;
      const end = it.x + 8 + this.measure([htmlText(it.html)], fpx);
      const gap = b[0] - end;
      if(gap > -fpx && gap < fpx * 3.5) return it;
    }
    return null;
  }
};
function renderScribe(){
  const btn = $('scribeBtn'); if(!btn) return;
  btn.classList.toggle('on', !!prefs.autoText);
  btn.classList.toggle('busy', Scribe.busy);
  const ab = $('assistBtn');
  if(ab){ ab.classList.toggle('on', !!(prefs.refLine || prefs.autoText)); ab.classList.toggle('busy', Scribe.busy); }
}
$('scribeBtn').addEventListener('click', () => {
  prefs.autoText = !prefs.autoText; savePrefs(); renderScribe();
  if(prefs.autoText){
    Scribe.warned = false;
    toast(Sync.user ? 'Write to text is on: what you write with the pen becomes typed text when you pause. Undo brings the ink back.' : 'Write to text needs sync sign-in and internet (Claude reads the handwriting).');
  } else { Scribe.pending = []; clearTimeout(Scribe.timer); }
});

/* =====================================================================
   Handwritten formula -> typed formula (lasso menu)
   ===================================================================== */
function measureMath(tex, fs){
  const d = document.createElement('div');
  d.className = 'it it-math'; d.style.cssText = `position:absolute;left:-9999px;top:0;font-size:${fs}px;visibility:hidden`;
  document.body.appendChild(d);
  try { katex.render(tex, d, {throwOnError: true, displayMode: true}); } catch { d.remove(); return null; }
  const r = [d.offsetWidth, d.offsetHeight]; d.remove(); return r;
}
async function strokesToFormula(){
  if(!sel || !cur) return;
  const strokes = sel.ids.map(id => cur.items.get(id)).filter(it => it && it.t === 's' && !it.hl);
  if(!strokes.length) return;
  const btn = $('selMath'); btn.disabled = true; btn.textContent = 'Reading…';
  try {
    const img = inkImage(strokes, 1000);
    let tex = await claudeJob('latex', img.url, 'Convert this handwritten expression to LaTeX.');
    tex = tex.replace(/^```(?:latex)?\s*|\s*```$/g, '').replace(/^\$+|\$+$/g, '').replace(/^\\\[|\\\]$/g, '').trim();
    if(!tex || tex === '?' || !measureMath(tex, 40)){ toast('Could not read that as a formula. Write it a bit bigger and try again.'); return; }
    const b = img.box, bw = b[2] - b[0], bh = b[3] - b[1];
    const [mw, mh] = measureMath(tex, 40);
    let fs = 40 * Math.min(bh / Math.max(1, mh) * 1.05, bw / Math.max(1, mw) * 1.15);
    fs = Math.round(clamp(fs, 14, 96));
    const [, h2] = measureMath(tex, fs);
    const cols = {}; for(const s of strokes) cols[s.c] = (cols[s.c] || 0) + 1;
    const c = Object.keys(cols).sort((a, b2) => cols[b2] - cols[a])[0] || 'auto';
    const m = {t: 'm', id: 'm' + newId(), x: b[0] - 6, y: b[1] + (bh - h2) / 2, tex, fs, c};
    const g = strokes[0].g && strokes.every(s => s.g === strokes[0].g) ? strokes[0].g : null; if(g) m.g = g;
    clearSel();
    apply(strokes.map(s => [s.id, null]).concat([[m.id, m]]), strokes.map(s => [s.id, s]).concat([[m.id, null]]));
    selectIds([m.id]);
    toast('Turned into a formula. Undo brings your handwriting back; tap the formula to edit it.');
  } catch(e){ toast(jobWhy(e.code || e.message)); }
  finally { btn.disabled = false; btn.textContent = 'To formula'; }
}

/* =====================================================================
   Page slider on the right: jump through imported pages
   ===================================================================== */
let slPages = null, slDrag = null, slHideT = 0;
// The slider stays hidden and untouchable, so a resting palm can't grab it. It only shows up
// for a deliberate scroll: one finger dragged up or down at least 40 px, starting away from the
// right edge (where the palm rests), not right after the Pencil was used; or a wheel / trackpad scroll.
const SLIDER_EDGE = 160, SLIDER_PEN_QUIET = 900;
function panWakes(x0, dy, dx){
  if(x0 > W - SLIDER_EDGE) return false;
  if(penDown || performance.now() - penAt < SLIDER_PEN_QUIET) return false;
  return Math.abs(dy) >= 40 && Math.abs(dy) > Math.abs(dx);
}
function sleepSlider(){
  const el = $('pgSlider'); if(!el || slDrag) return;
  clearTimeout(slHideT); el.classList.remove('awake');
}
function wakeSlider(){
  const el = $('pgSlider'); if(!el) return;
  el.classList.add('awake');
  clearTimeout(slHideT);
  slHideT = setTimeout(() => { if(!slDrag) el.classList.remove('awake'); }, 1500);
}
function sliderPages(){
  if(slPages) return slPages;
  slPages = cur ? [...cur.items.values()].filter(it => it.t === 'i' && it.h > 150).sort((a, b) => a.y - b.y || a.x - b.x) : [];
  return slPages;
}
function sliderIndexAt(){
  const pages = sliderPages(); if(!pages.length) return 0;
  const v = viewRect(), cy = v[1] + (v[3] - v[1]) * 0.35;
  let best = 0, bd = Infinity;
  pages.forEach((p, i) => { const d = cy < p.y ? p.y - cy : cy > p.y + p.h ? cy - p.y - p.h : 0; if(d < bd){ bd = d; best = i; } });
  return best;
}
function renderSlider(){
  const el = $('pgSlider'); if(!el) return;
  const pages = sliderPages();
  if(!cur || pages.length < 2){ el.hidden = true; return; }
  el.hidden = false;
  const i = slDrag ? slDrag.i : sliderIndexAt(), n = pages.length;
  const track = $('pgTrack'), th = track.clientHeight;
  const y = n > 1 ? i / (n - 1) * th : 0;
  $('pgThumb').style.transform = `translateY(${y}px)`;
  $('pgLabel').textContent = `${i + 1} / ${n}`;
  $('pgLabel').style.transform = `translateY(${y}px)`;
  // violet ticks where pages have "later" marks
  const key = n + ':' + [...markCounts.entries()].join() + ':' + (cur.items.size);
  if(el._ticks !== key){
    el._ticks = key;
    const marks = clusterMarks([...cur.items.values()]);
    const idx = new Set();
    for(const g of marks){ const my = (g.b[1] + g.b[3]) / 2; const k = pages.findIndex(p => my >= p.y && my <= p.y + p.h); if(k >= 0) idx.add(k); }
    $('pgTicks').innerHTML = [...idx].map(k => `<i style="top:${(n > 1 ? k / (n - 1) * 100 : 0).toFixed(2)}%"></i>`).join('');
  }
}
function sliderJump(i){
  const p = sliderPages()[i]; if(!p) return;
  cam.oy = 16 - p.y * cam.z;
  const v = viewRect();
  if(p.x + p.w < v[0] || p.x > v[2]) cam.ox = Math.max(16, (W - p.w * cam.z) / 2) - p.x * cam.z;
  invalidate(); saveCamSoon();
}
{
  const el = $('pgSlider');
  const at = e => { const r = $('pgTrack').getBoundingClientRect(), n = sliderPages().length; return clamp(Math.round((e.clientY - r.top) / Math.max(1, r.height) * (n - 1)), 0, n - 1); };
  el.addEventListener('pointerdown', e => {
    e.stopPropagation(); e.preventDefault();
    if(!sliderPages().length || !el.classList.contains('awake')) return;
    if(e.pointerType === 'touch' && Math.max(e.width || 0, e.height || 0) > 44) return;   // palm, not a fingertip
    slDrag = {id: e.pointerId, i: at(e)};
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('on'); sliderJump(slDrag.i); renderSlider();
  });
  el.addEventListener('pointermove', e => {
    e.stopPropagation();
    if(!slDrag || e.pointerId !== slDrag.id) return;
    const i = at(e); if(i !== slDrag.i){ slDrag.i = i; sliderJump(i); renderSlider(); }
  });
  const end = e => { e.stopPropagation(); if(!slDrag || e.pointerId !== slDrag.id) return; slDrag = null; el.classList.remove('on'); wakeSlider(); renderSlider(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}

/* =====================================================================
   Scan paper with the camera: find the sheet, straighten it, clean it up
   ===================================================================== */
const Scan = {
  src: null,      // canvas with the photo (max 2600 px)
  q: null,        // corners in photo pixels [[x,y] x4] TL, TR, BR, BL
  mode: 'doc',
  async load(file){
    $('scanStatus').textContent = 'Reading photo';
    let bmp;
    try { bmp = await createImageBitmap(file, {imageOrientation: 'from-image'}); }
    catch { const u = URL.createObjectURL(file); const im = new Image(); im.src = u; await im.decode(); bmp = im; }
    const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight, k = Math.min(1, 2600 / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if(bmp.close) bmp.close();
    this.src = c; this.q = findSheet(c); this.draw();
    $('scanStatus').textContent = this.q.auto ? 'Drag the corners if they are not on the edges of the sheet.' : 'Could not find the sheet. Drag the corners onto its edges.';
  },
  rotate(){
    if(!this.src) return;
    const s = this.src, c = document.createElement('canvas'); c.width = s.height; c.height = s.width;
    const ctx = c.getContext('2d'); ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(s, 0, 0);
    // corners turn with the photo: (x, y) -> (H - y, x), and the order shifts by one
    const q = this.q.map(([x, y]) => [s.height - y, x]);
    this.q = [q[3], q[0], q[1], q[2]]; this.q.auto = true;
    s.width = s.height = 1; this.src = c; this.draw();
  },
  // view geometry: photo fitted into the editor box
  fit(){
    const box = $('scanView'), bw = box.clientWidth || 480, bh = box.clientHeight || 520;
    const k = Math.min(bw / this.src.width, bh / this.src.height);
    return {k, ox: (bw - this.src.width * k) / 2, oy: (bh - this.src.height * k) / 2};
  },
  draw(){
    if(!this.src) return;
    const cv = $('scanCv'), f = this.fit(), d = Math.min(window.devicePixelRatio || 1, 2);
    const vw = $('scanView').clientWidth || 480, vh = $('scanView').clientHeight || 520;
    cv.width = Math.round(vw * d); cv.height = Math.round(vh * d); cv.style.width = vw + 'px'; cv.style.height = vh + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, vw, vh);
    ctx.drawImage(this.src, f.ox, f.oy, this.src.width * f.k, this.src.height * f.k);
    const P = this.q.map(([x, y]) => [f.ox + x * f.k, f.oy + y * f.k]);
    ctx.fillStyle = 'rgba(10,14,20,.45)';
    ctx.beginPath(); ctx.rect(0, 0, vw, vh); ctx.moveTo(P[0][0], P[0][1]); for(const p of [P[3], P[2], P[1]]) ctx.lineTo(p[0], p[1]); ctx.closePath(); ctx.fill('evenodd');
    ctx.strokeStyle = '#3BA5F0'; ctx.lineWidth = 2; ctx.beginPath(); P.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
    $('scanView').querySelectorAll('.scan-h').forEach((h, i) => { h.style.left = P[i][0] + 'px'; h.style.top = P[i][1] + 'px'; });
  },
  async place(again){
    if(!this.src || !cur) return;
    const go = $('scanGo'), go2 = $('scanNext'); go.disabled = go2.disabled = true;
    $('scanStatus').textContent = 'Straightening';
    await new Promise(r => setTimeout(r, 30));
    try {
      const out = warpSheet(this.src, this.q, 1700);
      if(this.mode === 'doc'){ $('scanStatus').textContent = 'Cleaning up'; await new Promise(r => setTimeout(r, 10)); cleanPaper(out); }
      const a = await saveAsset(await canvasBlob(out));
      const wW = A4W, hW = wW * out.height / out.width;
      out.width = out.height = 1;
      const cb = contentBox(), [vx, vy] = toWorld(W > 600 ? 48 : 16, 24);
      const x0 = cb ? cb[0] : vx, y0 = cb ? cb[3] + 48 : vy;
      addItems([{t: 'i', id: 'i' + newId(), x: x0, y: y0, w: wW, h: hW, a, doc: 1}]); PT.soon();
      setTool('pen');
      cam.ox = (W > 600 ? 48 : 16) - x0 * cam.z; cam.oy = 24 - y0 * cam.z; invalidate(); saveCamSoon();
      toast('Scan placed on the page');
      this.src.width = this.src.height = 1; this.src = null;
      if(again){ $('scanSetup').hidden = true; $('scanPick').hidden = false; $('scanStatus').textContent = ''; $('scanFile').click(); }
      else hideModal('scanDlg');
    } catch(e){ console.warn(e); $('scanStatus').textContent = 'Could not process the photo: ' + (e.message || e); }
    go.disabled = go2.disabled = false;
  }
};
// Finds the sheet of paper: the biggest bright area, then its four outermost corners.
function findSheet(src){
  const k = Math.min(1, 360 / Math.max(src.width, src.height)), w = Math.max(8, Math.round(src.width * k)), h = Math.max(8, Math.round(src.height * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', {willReadFrequently: true}); ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const L = new Float32Array(w * h), hist = new Uint32Array(256);
  for(let i = 0; i < w * h; i++){ const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2]; const v = (r * 77 + g * 150 + b * 29) >> 8; const sat = Math.max(r, g, b) - Math.min(r, g, b); L[i] = v - sat * 0.5; hist[clamp(Math.round(L[i]), 0, 255)]++; }
  // Otsu threshold between paper and background
  let sum = 0; for(let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, t = 128;
  for(let i = 0; i < 256; i++){ wB += hist[i]; if(!wB) continue; const wF = w * h - wB; if(!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if(v > best){ best = v; t = i; } }
  const on = new Uint8Array(w * h); for(let i = 0; i < w * h; i++) on[i] = L[i] > t ? 1 : 0;
  // biggest connected bright area
  const lab = new Int32Array(w * h).fill(-1), stack = [];
  let bestN = 0, bestL = -1, nl = 0;
  for(let i = 0; i < w * h; i++){
    if(!on[i] || lab[i] >= 0) continue;
    let n = 0; lab[i] = nl; stack.push(i);
    while(stack.length){ const j = stack.pop(); n++; const x = j % w, y = (j / w) | 0; for(const q of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if(q >= 0 && on[q] && lab[q] < 0){ lab[q] = nl; stack.push(q); } }
    if(n > bestN){ bestN = n; bestL = nl; } nl++;
  }
  const fallback = () => { const m = 0.04; const q = [[src.width * m, src.height * m], [src.width * (1 - m), src.height * m], [src.width * (1 - m), src.height * (1 - m)], [src.width * m, src.height * (1 - m)]]; q.auto = false; return q; };
  if(bestN < w * h * 0.12) return fallback();
  // touching the photo edge on all four sides means it is the background (or a full-frame page)
  let tl = null, tr = null, br = null, bl = null;
  for(let i = 0; i < w * h; i++){
    if(lab[i] !== bestL) continue;
    const x = i % w, y = (i / w) | 0;
    if(!tl || x + y < tl[0] + tl[1]) tl = [x, y];
    if(!br || x + y > br[0] + br[1]) br = [x, y];
    if(!tr || x - y > tr[0] - tr[1]) tr = [x, y];
    if(!bl || y - x > bl[1] - bl[0]) bl = [x, y];
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / k, (y + 0.5) / k]);
  const area = Math.abs(q.reduce((a, p, i) => { const n2 = q[(i + 1) % 4]; return a + p[0] * n2[1] - n2[0] * p[1]; }, 0)) / 2;
  // too small, or simply the whole photo (no edge between sheet and table): let the user place the corners
  if(area < src.width * src.height * 0.15 || area > src.width * src.height * 0.95) return fallback();
  q.auto = true;
  return q;
}
// Perspective warp of the quadrilateral q (TL, TR, BR, BL) onto a rectangle outW wide.
function warpSheet(src, q, outW){
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wq = (d(q[0], q[1]) + d(q[3], q[2])) / 2, hq = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  let ratio = hq / Math.max(1, wq);
  if(Math.abs(ratio - Math.SQRT2) / Math.SQRT2 < 0.1) ratio = Math.SQRT2;   // close to A4 portrait
  else if(Math.abs(ratio - 1 / Math.SQRT2) * Math.SQRT2 < 0.1) ratio = 1 / Math.SQRT2;
  const W2 = Math.round(outW), H2 = Math.round(outW * ratio);
  // homography from the unit square to the quadrilateral
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den ? (dx3 * dy2 - dx2 * dy3) / den : 0, hh = den ? (dx1 * dy3 - dx3 * dy1) / den : 0;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0, dd = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  const sctx = src.getContext('2d', {willReadFrequently: true});
  const S = sctx.getImageData(0, 0, src.width, src.height), sp = S.data, SW = src.width, SH = src.height;
  const out = document.createElement('canvas'); out.width = W2; out.height = H2;
  const octx = out.getContext('2d'), O = octx.createImageData(W2, H2), op = O.data;
  for(let y = 0; y < H2; y++){
    const v = (y + 0.5) / H2;
    for(let x = 0; x < W2; x++){
      const u = (x + 0.5) / W2, z = g * u + hh * v + 1;
      let sx = (a * u + b * v + c) / z - 0.5, sy = (dd * u + e * v + f) / z - 0.5;
      if(sx < 0) sx = 0; else if(sx > SW - 1.001) sx = SW - 1.001;
      if(sy < 0) sy = 0; else if(sy > SH - 1.001) sy = SH - 1.001;
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy, i0 = (iy * SW + ix) * 4, i1 = i0 + SW * 4, o = (y * W2 + x) * 4;
      for(let ch = 0; ch < 3; ch++){
        const top = sp[i0 + ch] + (sp[i0 + 4 + ch] - sp[i0 + ch]) * fx, bot = sp[i1 + ch] + (sp[i1 + 4 + ch] - sp[i1 + ch]) * fx;
        op[o + ch] = top + (bot - top) * fy;
      }
      op[o + 3] = 255;
    }
  }
  octx.putImageData(O, 0, 0);
  return out;
}
// "Document" look: even out shadows (divide by the paper brightness around each spot), then white paper, dark ink.
function cleanPaper(cv){
  const w = cv.width, h = cv.height, ctx = cv.getContext('2d', {willReadFrequently: true});
  const img = ctx.getImageData(0, 0, w, h), p = img.data;
  const bs = 24, gw = Math.ceil(w / bs), gh = Math.ceil(h / bs), bg = new Float32Array(gw * gh);
  // brightest paper in each block (90th percentile of brightness), smoothed
  for(let gy = 0; gy < gh; gy++) for(let gx = 0; gx < gw; gx++){
    const hist = new Uint16Array(64); let n = 0;
    for(let y = gy * bs; y < Math.min(h, gy * bs + bs); y += 2) for(let x = gx * bs; x < Math.min(w, gx * bs + bs); x += 2){ const i = (y * w + x) * 4; hist[((p[i] * 77 + p[i + 1] * 150 + p[i + 2] * 29) >> 8) >> 2]++; n++; }
    let acc = 0, k = 63; for(; k > 0; k--){ acc += hist[k]; if(acc >= n * 0.1) break; }
    bg[gy * gw + gx] = Math.max(40, k * 4 + 2);
  }
  // spread the paper level across blocks that are mostly ink (max over neighbours), then blur
  const bg2 = new Float32Array(gw * gh);
  for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++){ let m = 0; for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){ const xx = x + dx, yy = y + dy; if(xx >= 0 && yy >= 0 && xx < gw && yy < gh) m = Math.max(m, bg[yy * gw + xx]); } bg2[y * gw + x] = m; }
  for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++){ let s = 0, n = 0; for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){ const xx = x + dx, yy = y + dy; if(xx >= 0 && yy >= 0 && xx < gw && yy < gh){ s += bg2[yy * gw + xx]; n++; } } bg[y * gw + x] = s / n; }
  for(let y = 0; y < h; y++){
    const fy = clamp((y + 0.5) / bs - 0.5, 0, gh - 1), y0 = fy | 0, y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for(let x = 0; x < w; x++){
      const fx = clamp((x + 0.5) / bs - 0.5, 0, gw - 1), x0 = fx | 0, x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const b = (bg[y0 * gw + x0] * (1 - tx) + bg[y0 * gw + x1] * tx) * (1 - ty) + (bg[y1 * gw + x0] * (1 - tx) + bg[y1 * gw + x1] * tx) * ty;
      const i = (y * w + x) * 4;
      for(let ch = 0; ch < 3; ch++){
        let v = p[i + ch] / b;                 // 1 = paper
        v = (v - 0.45) / 0.45;                 // stretch: paper white, ink dark
        v = v >= 1 ? 1 : v <= 0 ? 0 : v * v * (3 - 2 * v);
        p[i + ch] = v * 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
$('scanFile').addEventListener('change', async () => {
  const f = $('scanFile').files[0]; $('scanFile').value = '';
  if(!f) return;
  $('scanPick').hidden = true; $('scanSetup').hidden = false;
  try { await Scan.load(f); } catch(e){ console.warn(e); $('scanStatus').textContent = 'This photo could not be opened.'; }
});
$('scanBtn').addEventListener('click', () => { hideModal('importDlg'); if(!cur){ toast('Open a page first'); return; } $('scanPick').hidden = false; $('scanSetup').hidden = true; $('scanStatus').textContent = ''; showModal('scanDlg'); });
$('scanRetake').addEventListener('click', () => $('scanFile').click());
$('scanRot').addEventListener('click', () => Scan.rotate());
$('scanMode').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if(!b) return; Scan.mode = b.dataset.v; $('scanMode').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
$('scanGo').addEventListener('click', () => Scan.place(false));
$('scanNext').addEventListener('click', () => Scan.place(true));
$('scanView').querySelectorAll('.scan-h').forEach((hd, i) => {
  let drag = null;
  hd.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); drag = e.pointerId; try { hd.setPointerCapture(e.pointerId); } catch {} hd.classList.add('on'); });
  hd.addEventListener('pointermove', e => {
    if(drag !== e.pointerId || !Scan.src) return;
    const r = $('scanView').getBoundingClientRect(), f = Scan.fit();
    Scan.q[i] = [clamp((e.clientX - r.left - f.ox) / f.k, 0, Scan.src.width), clamp((e.clientY - r.top - f.oy) / f.k, 0, Scan.src.height)];
    Scan.draw();
  });
  const up = () => { drag = null; hd.classList.remove('on'); };
  hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
});
addEventListener('resize', () => { if(!$('scanDlg').hidden && Scan.src) Scan.draw(); });

/* =====================================================================
   Calculator (top bar button): a strip on the left, about a fifth of the screen. Opening it hides the
   notebooks/pages panel; closing it leaves the page full width. Scientific keys, DEG/RAD, Ans, history.
   The expression is kept as tokens (internal form) and shown with maths symbols.
   ===================================================================== */
const CALC_SHOW = {'*': '×', '/': '÷', '-': '−', 'pi': 'π', 'sqrt(': '√(', 'cbrt(': '∛(', 'asin(': 'sin⁻¹(', 'acos(': 'cos⁻¹(', 'atan(': 'tan⁻¹(', '^2': '²', 'E': '×10^', 'Ans': 'Ans', 'exp(': 'e^('};
const Calc = {
  toks: [], hist: [], ans: 0, inv: false, fresh: false,
  load(){
    const d = LSget('inkwell.calc', null);
    if(d){ this.hist = Array.isArray(d.hist) ? d.hist.slice(-30) : []; this.ans = isFinite(d.ans) ? d.ans : 0; }
  },
  save(){ LSset('inkwell.calc', {hist: this.hist.slice(-30), ans: this.ans}); },
  open(){
    $('calc').hidden = false; $('calcBtn').classList.add('on');
    if(width() !== 'narrow' && !prefs.focus){ prefs.focus = true; app.classList.add('focus'); }
    prefs.calc = true; savePrefs(); this.render();
  },
  close(){ $('calc').hidden = true; $('calcBtn').classList.remove('on'); prefs.calc = false; savePrefs(); },
  // a result reused in a new calculation is one token '#<number>'
  show(t){ return t[0] === '#' ? fmtCalc(+t.slice(1)) : CALC_SHOW[t] || t; },
  src(){ return this.toks.map(t => t[0] === '#' ? '(' + t.slice(1).replace(/e\+?/, 'E') + ')' : t).join(''); },
  key(k){
    const isOp = /^[+\-*/^]$/.test(k) || k === '^2' || k === '%' || k === '!' || k === 'E';
    if(this.fresh){ this.toks = isOp ? ['Ans'] : []; this.fresh = false; }
    if(k === 'AC'){ this.toks = []; }
    else if(k === 'del'){ this.toks.pop(); }
    else if(k === '='){ this.equals(); return; }
    else if(k === 'neg'){ this.toks.push('-'); }
    else this.toks.push(k);
    this.inv = false;
    this.render();
  },
  equals(){
    if(!this.toks.length) return;
    const src = this.src();
    try {
      const v = calcEval(src, this.ans, prefs.calcDeg !== false);
      if(!isFinite(v)) throw new Error(isNaN(v) ? 'Not defined' : 'Too big');
      const shown = this.toks.map(t => this.show(t)).join(''), open = (src.match(/\(/g) || []).length - (src.match(/\)/g) || []).length;
      this.hist.push({e: shown + ')'.repeat(Math.max(0, open)), v});
      if(this.hist.length > 30) this.hist.shift();
      this.ans = v; this.toks = ['#' + v]; this.fresh = true; this.save();
      this.render(true);
    } catch(e){ $('calcRes').textContent = e.message || 'Error'; $('calcRes').classList.add('err'); }
  },
  render(scroll){
    const disp = this.toks.map(t => this.show(t)).join('');
    $('calcExpr').textContent = disp || '0';
    $('calcExpr').classList.toggle('empty', !disp);
    const r = $('calcRes'); r.classList.remove('err');
    if(this.fresh || !this.toks.length){ r.textContent = ''; }
    else { try { const v = calcEval(this.src(), this.ans, prefs.calcDeg !== false); r.textContent = isFinite(v) ? '= ' + fmtCalc(v) : ''; } catch { r.textContent = ''; } }
    const h = $('calcHist');
    h.innerHTML = this.hist.map((x, i) => `<button class="ch-row" data-i="${i}" title="Use this result"><span class="ch-e">${esc(x.e)}</span><span class="ch-v">= ${esc(fmtCalc(x.v))}</span></button>`).join('');
    if(scroll !== false) h.scrollTop = h.scrollHeight;
    $('calcDeg').textContent = prefs.calcDeg === false ? 'RAD' : 'DEG';
    $('calc').classList.toggle('inv', this.inv);
    $('calcInv').classList.toggle('on', this.inv);
  }
};
// numbers: up to 10 significant digits, exponent form when very big or small
function fmtCalc(v){
  if(v === 0) return '0';
  const a = Math.abs(v);
  let s = a >= 1e12 || a < 1e-9 ? v.toExponential(8).replace(/\.?0+e/, 'e') : String(parseFloat(v.toPrecision(10)));
  return s.replace(/e\+?/, ' × 10^').replace(/^-/, '−');
}
// Safe evaluator: + − × ÷ ^ ( ) % ! E, implicit multiplication, functions, π, e, Ans; missing ")" are added.
function calcEval(src, ans, deg){
  const s = String(src).replace(/×10\^/g, 'E');
  const toks = []; let i = 0;
  while(i < s.length){
    const c = s[i];
    if(/\s/.test(c)){ i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if(num){ toks.push({t: 'n', v: parseFloat(num[0])}); i += num[0].length; continue; }
    const id = /^(asin|acos|atan|sin|cos|tan|sqrt|cbrt|ln|log|exp|abs|pi|Ans|e)/.exec(s.slice(i));
    if(id){ toks.push({t: 'i', v: id[0]}); i += id[0].length; continue; }
    if('+-*/^()%!E'.includes(c)){ toks.push({t: c}); i++; continue; }
    throw new Error('Unknown sign ' + c);
  }
  const open = toks.filter(t => t.t === '(').length - toks.filter(t => t.t === ')').length;
  for(let k = 0; k < open; k++) toks.push({t: ')'});
  const D = deg ? Math.PI / 180 : 1;
  const F = {sin: x => Math.sin(x * D), cos: x => Math.cos(x * D), tan: x => { const r = Math.tan(x * D); return deg && Math.abs(((x % 180) + 180) % 180 - 90) < 1e-12 ? NaN : r; },
    asin: x => Math.asin(x) / D, acos: x => Math.acos(x) / D, atan: x => Math.atan(x) / D,
    sqrt: Math.sqrt, cbrt: Math.cbrt, ln: Math.log, log: Math.log10, exp: Math.exp, abs: Math.abs};
  let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const starts = t => t && (t.t === 'n' || t.t === 'i' || t.t === '(');
  const fact = n => { if(n < 0 || n !== Math.floor(n) || n > 170) return NaN; let r = 1; for(let k = 2; k <= n; k++) r *= k; return r; };
  function expr(){ let a = term(); while(peek() && (peek().t === '+' || peek().t === '-')){ const op = next().t, b = term(); a = op === '+' ? a + b : a - b; } return a; }
  function term(){
    let a = unary();
    for(;;){
      const t = peek();
      if(t && (t.t === '*' || t.t === '/')){ next(); const b = unary(); a = t.t === '*' ? a * b : a / b; }
      else if(starts(t)){ a *= power(); }
      else return a;
    }
  }
  function unary(){ const t = peek(); if(t && (t.t === '-' || t.t === '+')){ next(); const a = unary(); return t.t === '-' ? -a : a; } return power(); }
  function power(){ const b = postfix(); if(peek() && peek().t === '^'){ next(); return Math.pow(b, unary()); } return b; }
  function postfix(){
    let a = primary();
    for(;;){
      const t = peek();
      if(t && t.t === '%'){ next(); a /= 100; }
      else if(t && t.t === '!'){ next(); a = fact(a); }
      else if(t && t.t === 'E'){ next(); a *= Math.pow(10, unary()); }
      else return a;
    }
  }
  function primary(){
    const t = next();
    if(!t) throw new Error('Incomplete');
    if(t.t === 'n') return t.v;
    if(t.t === '('){ const a = expr(); if(!peek() || peek().t !== ')') throw new Error('Missing )'); next(); return a; }
    if(t.t === 'i'){
      if(t.v === 'pi') return Math.PI;
      if(t.v === 'e') return Math.E;
      if(t.v === 'Ans') return ans;
      const f = F[t.v];
      if(peek() && peek().t === '('){ next(); const a = expr(); if(peek() && peek().t === ')') next(); return f(a); }
      return f(power());
    }
    throw new Error('Incomplete');
  }
  const v = expr();
  if(p < toks.length) throw new Error('Check the expression');
  return v;
}
{
  // keys: [label, inverse label, token, inverse token, class]
  const K = [
    ['inv', '', 'inv', '', 'fn'], ['sin', 'sin⁻¹', 'sin(', 'asin(', 'fn'], ['cos', 'cos⁻¹', 'cos(', 'acos(', 'fn'], ['tan', 'tan⁻¹', 'tan(', 'atan(', 'fn'], ['π', 'e', 'pi', 'e', 'fn'],
    ['ln', 'eˣ', 'ln(', 'exp(', 'fn'], ['log', '10ˣ', 'log(', '10^', 'fn'], ['√', '∛', 'sqrt(', 'cbrt(', 'fn'], ['x²', 'x!', '^2', '!', 'fn'], ['xʸ', '', '^', '', 'fn'],
    ['(', '', '(', '', 'op'], [')', '', ')', '', 'op'], ['Ans', '', 'Ans', '', 'op'], ['⌫', '', 'del', '', 'op'], ['AC', '', 'AC', '', 'op ac'],
    ['7', '', '7', '', 'num'], ['8', '', '8', '', 'num'], ['9', '', '9', '', 'num'], ['÷', '', '/', '', 'op'], ['EE', '', 'E', '', 'op'],
    ['4', '', '4', '', 'num'], ['5', '', '5', '', 'num'], ['6', '', '6', '', 'num'], ['×', '', '*', '', 'op'], ['%', '', '%', '', 'op'],
    ['1', '', '1', '', 'num'], ['2', '', '2', '', 'num'], ['3', '', '3', '', 'num'], ['−', '', '-', '', 'op'], ['=', '', '=', '', 'eq'],
    ['0', '', '0', '', 'num zero'], ['.', '', '.', '', 'num'], ['+', '', '+', '', 'op']
  ];
  $('calcKeys').innerHTML = K.map(([l, il, t, it, c]) => `<button class="ck ${c}" data-k="${esc(t)}"${it ? ` data-ik="${esc(it)}"` : ''}${t === 'inv' ? ' id="calcInv"' : ''}><span class="kl">${esc(l)}</span>${il ? `<span class="ki">${esc(il)}</span>` : ''}</button>`).join('');
  $('calcKeys').addEventListener('click', e => {
    const b = e.target.closest('.ck'); if(!b) return;
    let k = b.dataset.k;
    if(k === 'inv'){ Calc.inv = !Calc.inv; Calc.render(false); return; }
    if(Calc.inv && b.dataset.ik) k = b.dataset.ik;
    Calc.key(k);
  });
  $('calcHist').addEventListener('click', e => {
    const r = e.target.closest('.ch-row'); if(!r) return;
    const x = Calc.hist[+r.dataset.i]; if(!x) return;
    if(Calc.fresh){ Calc.toks = []; Calc.fresh = false; }
    Calc.toks.push('#' + x.v);
    Calc.render(false);
  });
  $('calcDeg').addEventListener('click', () => { prefs.calcDeg = prefs.calcDeg === false; savePrefs(); Calc.render(false); });
  $('calcClose').addEventListener('click', () => Calc.close());
  $('calcClear').addEventListener('click', () => { Calc.hist = []; Calc.save(); Calc.render(); });
  $('calcBtn').addEventListener('click', () => { if($('calc').hidden) Calc.open(); else Calc.close(); });
  // hardware keyboard while the calculator is open and nothing else is being typed into
  document.addEventListener('keydown', e => {
    if($('calc').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    const a = document.activeElement;
    if(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if(!$('settingsDlg').hidden || document.querySelector('.modal:not([hidden])')) return;
    const map = {'Enter': '=', '=': '=', 'Backspace': 'del', 'Delete': 'AC', 'Escape': 'AC', '*': '*', '/': '/', ':': '/', '+': '+', '-': '-', '^': '^', '(': '(', ')': ')', '.': '.', ',': '.', '%': '%', '!': '!'};
    if(sel && /^(Backspace|Delete|Escape)$/.test(e.key)) return;   // those still act on a lasso selection
    let k = /^[0-9]$/.test(e.key) ? e.key : map[e.key];
    if(!k) return;
    e.preventDefault(); e.stopImmediatePropagation();
    Calc.key(k);
  }, true);
  Calc.load();
}

/* =====================================================================
   Keyboard (hardware keyboard / PC)
   ===================================================================== */
document.addEventListener('keydown', e => {
  const ae = document.activeElement;
  const typing = ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
  if(typing){ if(e.key === 'Escape' && editing) finishEditing(); return; }
  if(e.key === ' '){ spaceDown = true; e.preventDefault(); return; }
  if(e.metaKey || e.ctrlKey){
    const k = e.key.toLowerCase();
    if(k === 'z'){ e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if(k === 'y'){ e.preventDefault(); redo(); }
    else if(k === 'c' && sel){ e.preventDefault(); Clip.copy(); }
    else if(k === 'x' && sel){ e.preventDefault(); Clip.copy(); const ids = sel ? sel.ids.slice() : []; clearSel(); removeItems(ids); }
    else if(k === 'v' && Clip.get()){ e.preventDefault(); Clip.paste(); }
    return;
  }
  if(e.altKey) return;
  const map = {p: 'pen', h: 'hl', k: 'mark', e: 'eraser', l: 'lasso', t: 'text', m: 'math', s: 'space'};
  const t = map[e.key.toLowerCase()];
  if(t){ setTool(t); return; }
  if((e.key === 'Delete' || e.key === 'Backspace') && sel){ const ids = sel.ids.slice(); clearSel(); removeItems(ids); return; }
  if(e.key === 'Escape'){ closeWheel(); clearSel(); closePops(); if(pick){ endPick(); toast('Cancelled'); } }
});
document.addEventListener('keyup', e => { if(e.key === ' ') spaceDown = false; });

/* =====================================================================
   Start
   ===================================================================== */
async function loadDocs(){
  docs.clear();
  for(const d of await IDB.all('docs')) if(inMap(d.kind)) docs.set(d.id, d);
}
async function seed(){
  // Fixed ids and an old timestamp: a second device never duplicates these, and real data from sync always wins.
  const T = 1;
  const put = (id, kind, data) => IDB.put('docs', {id, kind, data, deleted: false, updated: T, dirty: 0});
  await put('nb-school', 'nb', {name: 'School', color: 1, order: 0});
  await put('nb-personal', 'nb', {name: 'Personal', color: 3, order: 1});
  await put('sec-math', 'sec', {nb: 'nb-school', name: 'Math', color: 1, order: 0});
  await put('sec-physics', 'sec', {nb: 'nb-school', name: 'Physics', color: 2, order: 1});
  await put('sec-general', 'sec', {nb: 'nb-school', name: 'General', color: 4, order: 2});
  await put('sec-ideas', 'sec', {nb: 'nb-personal', name: 'Ideas', color: 3, order: 0});
  await put('pg-welcome', 'page', {sec: 'sec-general', title: 'Start here', order: 0, snippet: 'Write with the Apple Pencil anywhere'});
  const intro = '<h1>Start here</h1><p>Write with the Apple Pencil anywhere. One finger moves the page, two fingers zoom.</p>' +
    '<ul class="check"><li class="done">Open Inkwell</li><li>Hold the pen still at the end of a line or circle to straighten it</li><li>Use the lasso to circle ink, then drag, resize or recolour it</li><li>Import a worksheet PDF and write on it</li><li>Link pages: in a text box, tap Link</li><li>Set up sync in the settings (gear, top left)</li></ul>';
  await put('c_pg-welcome', 'content', {bg: {type: 'grid', sx: 5 * MM, sy: 5 * MM}, items: [
    {t: 'x', id: 'x-welcome-1', x: 0, y: 0, w: 560, fs: 1, html: intro},
    {t: 'x', id: 'x-welcome-2', x: 0, y: 330, w: 560, fs: 1, html: '<p>Formulas render properly. Tap one to edit it:</p>'},
    {t: 'm', id: 'm-welcome-1', x: 4, y: 372, fs: 26, c: 'auto', tex: 'v = \\frac{\\Delta s}{\\Delta t} = \\frac{120\\,\\text{m}}{8\\,\\text{s}}'},
    {t: 'x', id: 'x-welcome-3', x: 0, y: 450, w: 560, fs: 1, html: '<p>Hide-answer tape: tap the yellow strip with a finger.</p><p><b>Answer:</b> v = 15 m/s</p>'},
    {t: 'tp', id: 'p-welcome-1', x: 70, y: 478, w: 130, h: 30}
  ]});
}
/* =====================================================================
   Import from OneNote (Microsoft Graph). Moves notebooks, sections and pages over once.
   Sign-in: OAuth 2.0 authorization code with PKCE in the same window (the home-screen app keeps its storage).
   The Microsoft app ID (an Entra app registration with this page as a Single-page application redirect)
   comes from config.js ONENOTE_CLIENT_ID or is pasted once in the dialog (localStorage inkwell.onenote.cid).
   Ids are derived from the OneNote ids, so a second run skips pages already imported (resume after a stop).
   Page HTML → text boxes and pictures at their OneNote positions; ink (Graph beta, includeinkML) → strokes.
   ===================================================================== */
const ON_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const ON_GRAPH = 'https://graph.microsoft.com/';
const ON_SCOPE = 'Notes.Read offline_access';
const onSleep = ms => new Promise(r => setTimeout(r, ms));
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function onHash(s){   // stable short id from a OneNote id (cyrb53)
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for(let i = 0; i < s.length; i++){ const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function onAuthErr(j){
  const d = String((j && (j.error_description || j.error)) || '');
  const m = /AADSTS(\d+)/.exec(d), c = m ? m[1] : '';
  if(c === '9002326' || c === '9002327') return 'In the app registration, the redirect address has to be under "Single-page application", not "Web".';
  if(c === '50011' || c === '500113') return 'The redirect address in the app registration has to be exactly ' + ON.redirect();
  if(c === '700016' || c === '90002') return 'Microsoft does not know this app ID. Check the Application (client) ID.';
  if(c === '9002331' || c === '50194' || c === '50020') return 'This Microsoft account is not allowed by the app registration. Set "Supported account types" to organizational directories and personal Microsoft accounts.';
  if(c === '65004' || /access_denied/.test(d)) return 'Sign-in was cancelled.';
  if(c === '700082' || c === '700084' || /invalid_grant/.test(d)) return 'The Microsoft sign-in expired. Sign in again.';
  return d ? d.split(/\r?\n/)[0].replace(/^AADSTS\d+:\s*/, '').slice(0, 220) : 'Microsoft sign-in failed.';
}
const ON = {
  tok: LSget('inkwell.onenote.tok', null),   // {at, rt, exp}
  ret: null,          // result of the Microsoft sign-in redirect: {code, v} or {error}
  books: null, busy: false, stop: false, view: '', msg: '',
  cid(){ return String(CFG.ONENOTE_CLIENT_ID || LSget('inkwell.onenote.cid', '') || '').trim(); },
  redirect(){ return location.origin + location.pathname.replace(/index\.html$/, ''); },
  // first thing on start: take the code out of the address before anything else (Supabase) reads it
  catchRedirect(){
    const q = new URLSearchParams(location.search), st = q.get('state') || '';
    if(!st.startsWith('on-')) return;
    history.replaceState(null, '', location.pathname + location.hash);
    const saved = LSget('inkwell.onenote.auth', null);
    LSset('inkwell.onenote.auth', null);
    if(q.get('error')) this.ret = {error: onAuthErr({error_description: q.get('error_description') || q.get('error')})};
    else if(!saved || saved.s !== st || !q.get('code')) this.ret = {error: 'The Microsoft sign-in did not finish. Try again.'};
    else this.ret = {code: q.get('code'), v: saved.v};
  },
  async signIn(select){
    const v = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const ch = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
    const s = 'on-' + b64url(crypto.getRandomValues(new Uint8Array(16)));
    LSset('inkwell.onenote.auth', {v, s, at: Date.now()});
    await flushSaves();
    const p = new URLSearchParams({client_id: this.cid(), response_type: 'code', redirect_uri: this.redirect(), response_mode: 'query',
      scope: ON_SCOPE, state: s, code_challenge: ch, code_challenge_method: 'S256'});
    if(select) p.set('prompt', 'select_account');
    location.assign(ON_AUTH + '/authorize?' + p);
  },
  async tokenReq(body){
    let r, j = {};
    try {
      r = await fetch(ON_AUTH + '/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams(Object.assign({client_id: this.cid(), scope: ON_SCOPE}, body))});
      j = await r.json().catch(() => ({}));
    } catch(e){ throw new Error('No connection to Microsoft.'); }
    if(!r.ok || !j.access_token) throw Object.assign(new Error(onAuthErr(j)), {auth: true});
    this.tok = {at: j.access_token, rt: j.refresh_token || (this.tok && this.tok.rt) || '', exp: Date.now() + (+j.expires_in || 3600) * 1000};
    LSset('inkwell.onenote.tok', this.tok);
  },
  redeem(){ const r = this.ret; this.ret = null; return this.tokenReq({grant_type: 'authorization_code', code: r.code, redirect_uri: this.redirect(), code_verifier: r.v}); },
  async token(force){
    if(this.tok && !force && this.tok.exp > Date.now() + 120000) return this.tok.at;
    if(this.tok && this.tok.rt){
      try { await this.tokenReq({grant_type: 'refresh_token', refresh_token: this.tok.rt}); return this.tok.at; }
      catch(e){ if(e.auth){ this.forget(); throw Object.assign(new Error('signin'), {why: e.message}); } throw e; }
    }
    throw new Error('signin');
  },
  forget(){ this.tok = null; LSset('inkwell.onenote.tok', null); },
  // Microsoft Graph GET. Only graph.microsoft.com gets the token.
  async g(url, raw){
    if(!/^https:\/\//.test(url)) url = ON_GRAPH + 'v1.0/me/onenote/' + url;
    const graph = url.startsWith(ON_GRAPH);
    let authTry = 0;
    for(let tries = 0; ; tries++){
      if(this.stop) throw new Error('stopped');
      let r;
      try { r = await fetch(url, graph ? {headers: {Authorization: 'Bearer ' + await this.token()}} : {}); }
      catch(e){
        if(e.message === 'signin' || e.why) throw e;
        if(tries < 4){ this.note('Connection lost, trying again'); await onSleep(3000 * (tries + 1)); continue; }
        throw new Error('No connection to Microsoft.');
      }
      if(r.status === 401 && graph && authTry++ < 1){ await this.token(true); tries--; continue; }
      if((r.status === 429 || r.status === 503 || r.status === 504 || r.status === 500) && tries < 7){
        const wait = Math.min(90, +r.headers.get('Retry-After') || 4 * 2 ** tries);
        this.note(`Microsoft asked to slow down, waiting ${wait} s`);
        await onSleep(wait * 1000); continue;
      }
      if(!r.ok){
        const j = await r.json().catch(() => null), e = j && j.error;
        throw Object.assign(new Error((e && (e.message || e.code)) || 'HTTP ' + r.status), {status: r.status});
      }
      return raw ? r : r.json();
    }
  },
  async all(url){
    const out = [];
    for(let u = url, n = 0; u && n < 300; n++){ const j = await this.g(u); out.push(...(j.value || [])); u = j['@odata.nextLink']; }
    return out;
  },
  async loadBooks(){
    const [nbs, secs] = await Promise.all([this.all('notebooks?$top=100'), this.all('sections?$expand=parentNotebook,parentSectionGroup&$top=100')]);
    this.books = nbs.map(nb => ({id: nb.id, name: nb.displayName || 'Notebook',
      secs: secs.filter(s => s.parentNotebook && s.parentNotebook.id === nb.id)
        .map(s => ({id: s.id, name: (s.parentSectionGroup && s.parentSectionGroup.displayName ? s.parentSectionGroup.displayName + ' › ' : '') + (s.displayName || 'Section')}))}));
    return this.books;
  },
  async listPages(secId){
    const base = 'sections/' + encodeURIComponent(secId) + '/pages?$top=100';
    let ps;
    try { ps = await this.all(base + '&pagelevel=true'); }
    catch(e){ if(e.status !== 400) throw e; ps = await this.all(base); }
    const ord = ps.length && ps.every(p => typeof p.order === 'number');
    return ps.sort((a, b) => ord ? a.order - b.order : String(a.createdDateTime || '').localeCompare(String(b.createdDateTime || '')));
  },
  note(t){ const el = $('onProg'); if(el && this.busy) el.textContent = t; },
  async importAll(sel, onPage){
    this.stop = false; this.busy = true;
    const st = this.lastSt = {pages: 0, skip: 0, pics: 0, picFail: 0, ink: 0, inkPages: 0, noInk: 0, fail: [], books: 0, secs: 0};
    let lock = null;
    try { if(navigator.wakeLock) lock = await navigator.wakeLock.request('screen'); } catch {}
    let nbOrder = notebooks().reduce((m, n) => Math.max(m, (n.data.order || 0) + 1), 0);
    try {
      for(const book of this.books || []){
        const secs = book.secs.filter(s => sel.has(s.id));
        if(!secs.length) continue;
        const nbId = 'nb-on' + onHash(book.id);
        if(!live(docs.get(nbId))){ const o = nbOrder++; await writeDoc({id: nbId, kind: 'nb', data: {name: book.name, color: o % TABS, order: o}, deleted: false}); }
        st.books++;
        for(const [si, s] of secs.entries()){
          const secId = 'sec-on' + onHash(s.id);
          if(!live(docs.get(secId))) await writeDoc({id: secId, kind: 'sec', data: {nb: nbId, name: s.name, color: si % TABS, order: si}, deleted: false});
          st.secs++; renderNav();
          const where = book.name + ' › ' + s.name;
          this.note(where + ': looking for pages');
          const pages = await this.listPages(s.id);
          for(const [pi, p] of pages.entries()){
            if(this.stop) throw new Error('stopped');
            const pid = 'pg-on' + onHash(p.id), ex = docs.get(pid);
            if(ex && ex.data){ st.skip++; continue; }
            this.note(`${where}: page ${pi + 1} of ${pages.length}`);
            try { await this.importPage(p, pid, secId, pi, st); st.pages++; }
            catch(e){
              if(this.stop || e.message === 'signin' || e.message === 'stopped') throw e;
              console.warn('onenote page', e);
              st.fail.push(`${where} › ${(p.title || '').trim() || 'Untitled page'}: ${e.message || e}`);
            }
            if(onPage) onPage(st);
            if(st.pages % 5 === 0){ renderNav(); renderList(); }
          }
        }
      }
    } finally {
      this.busy = false;
      try { lock && lock.release(); } catch {}
      renderNav(); renderList(); Sync.soon(); PT.soon();
    }
    return st;
  },
  async importPage(p, pid, secId, order, st){
    let html = '', inks = [];
    try {
      const r = await this.g(ON_GRAPH + 'beta/me/onenote/pages/' + encodeURIComponent(p.id) + '/content?includeinkML=true', true);
      ({html, inks} = onSplit(await r.text(), r.headers.get('content-type') || ''));
    } catch(e){
      if(this.stop || e.message === 'signin' || e.message === 'stopped') throw e;
      const r = await this.g('pages/' + encodeURIComponent(p.id) + '/content', true);
      html = await r.text(); st.noInk++;
    }
    const items = await this.layout(html, st);
    let nInk = 0;
    for(const x of inks){ const s = onInk(x); nInk += s.length; items.push(...s); }
    if(nInk){ st.ink += nInk; st.inkPages++; }
    // content first, then the page: a stopped import never leaves a page without its content
    await writeDoc({id: 'c_' + pid, kind: 'content', data: {bg: {type: 'blank', sx: 5 * MM, sy: 5 * MM}, items: items.map(ser)}, deleted: false});
    let snip = '';
    for(const it of items){ if(it.t === 'x') snip += ' ' + htmlText(it.html); if(snip.length > 200) break; }
    await writeDoc({id: pid, kind: 'page', data: {sec: secId, title: (p.title || '').trim(), order, snippet: snip.trim().slice(0, 160)}, deleted: false});
  },
  // download a picture and store it like an imported image (JPEG, at most 2400 px)
  async pic(src){
    let blob;
    try { blob = await (await this.g(src, true)).blob(); }
    catch(e){ if(this.stop || e.message === 'signin' || e.message === 'stopped') throw e; return null; }
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch { return null; }
    const sc = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const nat = {w: bmp.width, h: bmp.height};
    if(bmp.close) bmp.close();
    const out = await canvasBlob(c); c.width = c.height = 1;
    return {a: await saveAsset(out), nat};
  },
  // Page HTML → items. Each OneNote note container (absolutely placed div) is laid out with Inkwell's own
  // text style off screen; text between pictures becomes one text box, pictures become picture items.
  async layout(html, st){
    const d = new DOMParser().parseFromString(html || '', 'text/html');
    const body = d.body, items = [];
    if(!body) return items;
    const tw = d.createTreeWalker(body, NodeFilter.SHOW_COMMENT); const cm = [];
    while(tw.nextNode()) cm.push(tw.currentNode);
    cm.forEach(n => n.remove());
    body.querySelectorAll('script,style,iframe,embed,video,audio,form,input,button,link,meta').forEach(n => n.remove());
    const basePx = onPx(body.style.fontSize) || 14.667;
    // pictures: download first, so their size is known for the layout
    for(const img of [...body.querySelectorAll('img')]){
      const src = img.getAttribute('data-fullres-src') || img.getAttribute('src') || '';
      const got = /^https:\/\//.test(src) ? await this.pic(src) : null;
      if(!got){ st.picFail++; img.remove(); continue; }
      st.pics++;
      let w = parseFloat(img.getAttribute('width')) || onPx(img.style.width), h = parseFloat(img.getAttribute('height')) || onPx(img.style.height);
      if(!w && !h){ w = got.nat.w; h = got.nat.h; } else if(!w) w = h * got.nat.w / got.nat.h; else if(!h) h = w * got.nat.h / got.nat.w;
      const ph = d.createElement('span');
      ph.setAttribute('data-onimg', got.a);
      ph.style.display = 'inline-block'; ph.style.width = w + 'px'; ph.style.height = h + 'px'; ph.style.verticalAlign = 'bottom';
      img.replaceWith(ph);
    }
    for(const o of [...body.querySelectorAll('object')]){
      const p = d.createElement('p'); p.textContent = 'Attached file (not imported): ' + (o.getAttribute('data-attachment') || 'file');
      p.setAttribute('style', o.getAttribute('style') || ''); o.replaceWith(p);
    }
    onTodos(d, body);
    // containers: absolutely placed children of the body; the rest flows in one container
    const conts = [], flow = [];
    for(const k of [...body.childNodes]){
      if(k.nodeType === 1 && k.style && k.style.position === 'absolute') conts.push({x: onPx(k.style.left) || 0, y: onPx(k.style.top) || 0, w: onPx(k.style.width), el: k});
      else if(k.nodeType === 1 || (k.nodeType === 3 && k.textContent.trim())) flow.push(k);
    }
    if(flow.length){ const div = d.createElement('div'); flow.forEach(k => div.appendChild(k)); conts.push({x: 48, y: 48 + (conts.length ? Math.max(...conts.map(c => c.y)) + 400 : 0), w: 680, el: div, flow: true}); }
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-40000px;top:0;width:3000px;visibility:hidden;pointer-events:none;contain:layout';
    document.body.appendChild(host);
    try {
      for(const c of conts){
        let el = c.el, kids;
        if(el.matches('span[data-onimg]')) kids = [el];
        else {
          while(el.children.length === 1 && el.firstElementChild.tagName === 'DIV' && !el.firstElementChild.style.position && ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) el = el.firstElementChild;
          kids = [...el.childNodes];
        }
        const fsPx = onPx(c.el.style.fontSize) || onPx(el.style.fontSize) || basePx;
        const box = document.createElement('div');
        box.className = 'it-text';
        box.style.cssText = `position:absolute;left:0;top:0;padding:0;min-height:0;font-size:${fsPx}px;` + (c.w ? `width:${c.w}px` : 'width:max-content;max-width:800px');
        for(const k of kids){
          const n = document.importNode(k, true);
          if(n.nodeType === 1){ onTidy(n); if(!n.matches('span[data-onimg]') && !n.style.lineHeight && /^(P|DIV|UL|OL|H[1-6]|TABLE|LI)$/.test(n.tagName)) n.style.lineHeight = '1.3'; }
          box.appendChild(n);
        }
        host.appendChild(box);
        const B = box.getBoundingClientRect(), width = c.w || Math.min(800, Math.ceil(B.width) + 2);
        for(const ph of box.querySelectorAll('span[data-onimg]')){
          const R = ph.getBoundingClientRect();
          items.push({t: 'i', id: 'i' + newId() + Math.random().toString(36).slice(2, 5), x: c.x + R.left - B.left, y: c.y + R.top - B.top, w: Math.max(1, R.width), h: Math.max(1, R.height), a: ph.getAttribute('data-onimg')});
        }
        // text runs between top-level pictures; pictures inside a paragraph keep their space with an empty spacer
        let run = [];
        const flush = () => {
          const nodes = run; run = [];
          if(!nodes.length) return;
          const rg = document.createRange(); rg.setStartBefore(nodes[0]); rg.setEndAfter(nodes[nodes.length - 1]);
          const R = rg.getBoundingClientRect();
          const tmp = document.createElement('div');
          nodes.forEach(n => tmp.appendChild(n.cloneNode(true)));
          tmp.querySelectorAll('span[data-onimg]').forEach(s => { const sp = document.createElement('span'); sp.setAttribute('style', `display:inline-block;width:${s.style.width};height:${s.style.height};vertical-align:bottom`); s.replaceWith(sp); });
          const txt = htmlText(tmp.innerHTML);
          if(!txt && !tmp.querySelector('table,li')) return;
          items.push({t: 'x', id: 'x' + newId() + Math.random().toString(36).slice(2, 5), x: c.x - 6, y: c.y + (R.top - B.top) - 2, w: width + 12, fs: Math.round(fsPx / 17 * 1000) / 1000, html: cleanHTML(tmp.innerHTML)});
        };
        for(const n of [...box.childNodes]){
          if(n.nodeType === 1 && n.matches('span[data-onimg]')){ flush(); continue; }
          if(n.nodeType === 3 && !n.textContent.trim()){ if(run.length) run.push(n); continue; }
          run.push(n);
        }
        flush();
        box.remove();
      }
    } finally { host.remove(); }
    return items;
  }
};
// "11pt", "14px", "1.2em" → CSS px
function onPx(v){
  const m = /^\s*(-?[\d.]+)\s*(pt|px|in|cm|mm)?\s*$/i.exec(v || '');
  if(!m) return 0;
  const n = parseFloat(m[1]), u = (m[2] || 'px').toLowerCase();
  return n * ({pt: 96 / 72, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4}[u]);
}
// keep text formatting, drop OneNote's positioning, fonts and black (so text follows dark mode)
function onTidy(root){
  for(const el of [root, ...root.querySelectorAll('*')]){
    if(el.matches && el.matches('span[data-onimg]')) continue;
    for(const a of [...el.attributes]) if(!/^(style|class|colspan|rowspan)$/i.test(a.name)) el.removeAttribute(a.name);
    const s = el.style;
    if(!s) continue;
    for(const k of ['position', 'left', 'top', 'z-index', 'font-family']) s.removeProperty(k);
    if(!/^(TABLE|TD|TH|COL)$/.test(el.tagName)) s.removeProperty('width');
    if(/^(#000000|#000|black|rgb\(0,0,0\)|windowtext)$/i.test(s.color.replace(/\s/g, ''))) s.removeProperty('color');
    if(!el.getAttribute('style')) el.removeAttribute('style');
  }
}
// OneNote to-do tags → Inkwell checklists
function onTodos(d, body){
  for(const p of [...body.querySelectorAll('[data-tag]')]){
    const tag = p.getAttribute('data-tag') || '';
    if(!/to-do/.test(tag) || p.closest('li') && p.tagName !== 'LI') continue;
    const li = d.createElement('li'); li.innerHTML = p.innerHTML;
    if(/completed/.test(tag)) li.className = 'done';
    if(p.tagName === 'LI'){ p.replaceWith(li); const ul = li.parentElement; if(ul) ul.classList.add('check'); continue; }
    const prev = p.previousElementSibling;
    if(prev && prev.tagName === 'UL' && prev.classList.contains('check')){ prev.appendChild(li); p.remove(); }
    else { const ul = d.createElement('ul'); ul.className = 'check'; ul.appendChild(li); p.replaceWith(ul); }
  }
}
// split the page content response: plain HTML, or multipart with the HTML and InkML parts
function onSplit(text, ctype){
  const m = /boundary="?([^";]+)"?/i.exec(ctype);
  if(!/multipart/i.test(ctype) || !m) return {html: text, inks: []};
  let html = ''; const inks = [];
  for(const part of text.split('--' + m[1])){
    const i = part.search(/\r?\n\r?\n/);
    if(i < 0) continue;
    const head = part.slice(0, i), body = part.slice(i).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
    if(/inkml/i.test(head) || /^\s*(<\?xml[^>]*\?>\s*)?<(\w+:)?ink[\s>]/.test(body)) inks.push(body);
    else if(!html && (/text\/html/i.test(head) || /<html|<body/i.test(body))) html = body;
  }
  return {html, inks};
}
// InkML (OneNote subset, coordinates from the page's top-left corner, usually himetric = 1/1000 cm) → strokes
const ON_UNIT = {himetric: 96 / 2540, cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, px: 1, dev: 1};
function onInk(xml){
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  if(d.getElementsByTagName('parsererror').length) return [];
  const tags = (r, n) => [...r.getElementsByTagNameNS('*', n)];
  const xid = el => el.getAttribute('xml:id') || el.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id') || el.getAttribute('id') || '';
  const ref = s => String(s || '').replace(/^#/, '');
  const fmtOf = root => {
    const tf = tags(root, 'traceFormat')[0];
    const chans = tf ? tags(tf, 'channel').map(c => ({n: c.getAttribute('name'), u: (c.getAttribute('units') || '').toLowerCase()})) : [{n: 'X', u: 'himetric'}, {n: 'Y', u: 'himetric'}];
    const res = {};
    for(const p of tags(root, 'channelProperty')) if(p.getAttribute('name') === 'resolution'){
      const v = parseFloat(p.getAttribute('value')) || 1, u = (p.getAttribute('units') || '').toLowerCase().replace(/^1\//, '');
      res[p.getAttribute('channel')] = {v, u};
    }
    return chans.map(c => {
      const r = res[c.n];
      const unit = r && ON_UNIT[r.u] ? r.u : (ON_UNIT[c.u] ? c.u : 'himetric');
      return {n: c.n, k: ON_UNIT[unit] / (r ? r.v : 1)};
    });
  };
  const ctx = {};
  for(const c of tags(d, 'context')) ctx[xid(c)] = fmtOf(c);
  const defFmt = tags(d, 'context').length ? Object.values(ctx)[0] : fmtOf(d);
  const brushes = {};
  for(const b of tags(d, 'brush')){
    const o = {};
    for(const p of tags(b, 'brushProperty')) o[p.getAttribute('name')] = {v: p.getAttribute('value'), u: (p.getAttribute('units') || '').toLowerCase()};
    brushes[xid(b)] = o;
  }
  const raw = [];
  let fMax = 0;
  for(const t of tags(d, 'trace')){
    const inh = a => { for(let e = t; e && e.getAttribute; e = e.parentNode){ const v = e.getAttribute(a); if(v) return v; } return ''; };
    const fmt = ctx[ref(inh('contextRef'))] || defFmt;
    const pts = onTrace(t.textContent, fmt.length);
    const fi = fmt.findIndex(c => c.n === 'F');
    if(fi >= 0) for(const pt of pts) fMax = Math.max(fMax, pt[fi]);
    raw.push({fmt, pts, fi, br: brushes[ref(inh('brushRef'))] || {}});
  }
  const out = [];
  for(const {fmt, pts, fi, br} of raw){
    const xi = fmt.findIndex(c => c.n === 'X'), yi = fmt.findIndex(c => c.n === 'Y');
    if(xi < 0 || yi < 0 || !pts.length) continue;
    const prop = (k, d0) => br[k] ? br[k].v : d0;
    const wv = parseFloat(prop('width', '')), wu = br.width && ON_UNIT[br.width.u] ? br.width.u : 'himetric';
    const wpx = wv ? wv * ON_UNIT[wu] : 1.6;
    const hl = +prop('transparency', 0) > 0 || prop('rasterOp', '') === 'maskPen';
    const noPr = fi < 0 || !fMax || prop('ignorePressure', 'false') === 'true';
    let c = String(prop('color', '#000000')).toUpperCase();
    if(!/^#[0-9A-F]{6}$/.test(c)) c = '#000000';
    const p = [];
    let lx = null, ly = null;
    for(const [k, pt] of pts.entries()){
      const x = pt[xi] * fmt[xi].k, y = pt[yi] * fmt[yi].k;
      if(lx !== null && k < pts.length - 1 && Math.abs(x - lx) + Math.abs(y - ly) < 0.6) continue;   // drop points closer than about half a pixel
      p.push(x, y, noPr ? 0.7 : clamp(0.3 + 0.7 * pt[fi] / fMax, 0.3, 1));
      lx = x; ly = y;
    }
    out.push({t: 's', id: 's' + newId() + Math.random().toString(36).slice(2, 5), c: hl ? c : (c === '#000000' ? 'auto' : c), w: Math.round(clamp(wpx, 0.5, 60) * 10) / 10, hl: hl ? 1 : 0, p});
  }
  return out;
}
// one InkML trace: points separated by ",", values with optional ! (absolute), ' (difference) or " (second difference)
function onTrace(txt, n){
  const out = [], mode = new Array(n).fill(0), last = new Array(n).fill(0), vel = new Array(n).fill(0);
  for(const ps of String(txt).split(',')){
    const toks = [...ps.matchAll(/([!'"])?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[*?])/g)];
    if(!toks.length) continue;
    const pt = new Array(n);
    for(let ch = 0; ch < n; ch++){
      const t = toks[ch];
      if(!t){ pt[ch] = last[ch]; continue; }
      if(t[1]) mode[ch] = t[1] === '!' ? 0 : t[1] === "'" ? 1 : 2;
      const num = t[2] === '*' || t[2] === '?' ? null : parseFloat(t[2]);
      let v;
      if(num === null){ v = mode[ch] === 0 ? last[ch] : last[ch] + vel[ch]; }
      else if(mode[ch] === 0){ v = num; vel[ch] = out.length ? v - last[ch] : 0; }
      else if(mode[ch] === 1){ v = last[ch] + num; vel[ch] = num; }
      else { vel[ch] += num; v = last[ch] + vel[ch]; }
      last[ch] = v; pt[ch] = v;
    }
    out.push(pt);
  }
  return out;
}

/* the dialog */
function onShow(view, msg){
  ON.view = view;
  for(const [v, id] of [['setup', 'onSetup'], ['signin', 'onSignin'], ['pick', 'onPick'], ['run', 'onRunV'], ['done', 'onDone']]) $(id).hidden = v !== view;
  $('onMsg').textContent = msg || '';
  $('onMsg').classList.toggle('err', /^!/.test(msg || ''));
  if(msg && msg[0] === '!') $('onMsg').textContent = msg.slice(1);
  if(view === 'setup'){ $('onRedir').textContent = ON.redirect(); $('onRedirCopy').dataset.copy = ON.redirect(); $('onCid').value = ON.cid(); }
  const stage = view === 'setup' ? 0 : view === 'signin' ? 1 : 2;
  [...$('onTrack').children].forEach((li, i) => { li.classList.toggle('on', i === stage && view !== 'done'); li.classList.toggle('done', i < stage || view === 'done'); });
}
// pull a client ID out of whatever was pasted (Microsoft's copy button, or a line with a label around it)
const onGuid = s => (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(s || '') || [''])[0].toLowerCase();
async function onCopy(btn, text){
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch {
    const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    try { ok = document.execCommand('copy'); } catch {}
    t.remove();
  }
  const was = btn.textContent; btn.textContent = ok ? 'Copied' : 'Select and copy'; btn.classList.toggle('ok', ok);
  setTimeout(() => { btn.textContent = was; btn.classList.remove('ok'); }, 1600);
}
$('onSetup').addEventListener('click', e => { const b = e.target.closest('[data-copy]'); if(b) onCopy(b, b.dataset.copy); });
$('onCidPaste').addEventListener('click', async () => {
  try { const g = onGuid(await navigator.clipboard.readText()); if(g){ $('onCid').value = g; $('onMsg').textContent = ''; } else onShow('setup', '!The clipboard has no app ID in it. Copy the Application (client) ID first.'); }
  catch { $('onCid').focus(); toast('Tap and hold the box, then Paste'); }
});
$('onCid').addEventListener('input', () => { const g = onGuid($('onCid').value); if(g && g !== $('onCid').value) $('onCid').value = g; });
async function onOpen(){
  hideModal('settingsDlg'); showModal('onenoteDlg');
  if(ON.busy){ onShow('run'); return; }
  if(!ON.cid()){ onShow('setup'); return; }
  if(!ON.tok){ onShow('signin'); return; }
  await onLoadList();
}
async function onLoadList(){
  onShow('pick', 'Loading your OneNote notebooks…');
  $('onList').innerHTML = ''; $('onRun').disabled = true;
  try {
    const books = await ON.loadBooks();
    if(!books.length){ onShow('pick', 'This Microsoft account has no OneNote notebooks. Use "Other account" if they are on another one.'); return; }
    $('onList').innerHTML = books.map((b, i) => {
      const done = b.secs.length && b.secs.every(s => live(docs.get('sec-on' + onHash(s.id))));
      return `<label class="prac-sec"><input type="checkbox" data-onnb="${i}" checked><span class="tab" style="--c:var(--t${i % TABS})"></span>${esc(b.name)}${done ? ' <em class="hint">(imported before)</em>' : ''}</label>` +
        b.secs.map(s => `<label class="prac-page"><input type="checkbox" data-onsec="${esc(s.id)}" data-nbi="${i}" checked>${esc(s.name)}</label>`).join('');
    }).join('');
    $('onRun').disabled = false;
    const n = books.reduce((m, b) => m + b.secs.length, 0);
    onShow('pick', `${books.length} notebook${books.length === 1 ? '' : 's'}, ${n} section${n === 1 ? '' : 's'}.`);
  } catch(e){ onFail(e); }
}
function onFail(e){
  console.warn('onenote', e);
  if(e.message === 'signin'){ ON.forget(); onShow('signin', '!' + (e.why || 'Sign in with Microsoft again.')); return; }
  const m = String(e.message || e);
  if(/Notes\.Read|scope|consent/i.test(m)) { ON.forget(); onShow('signin', '!Microsoft did not allow reading OneNote: ' + m); return; }
  onShow(ON.view === 'run' ? 'pick' : ON.view || 'signin', '!' + m);
}
$('onBtn').addEventListener('click', onOpen);
$('onCidSave').addEventListener('click', () => {
  const v = onGuid($('onCid').value);
  if(!v){ onShow('setup', '!That does not look like the app ID. It looks like 1a2b3c4d-1234-5678-9abc-1234567890ab and is shown as "Application (client) ID" (not the Object ID or Directory ID).'); return; }
  LSset('inkwell.onenote.cid', v); ON.forget();
  onShow('signin');
});
$('onCidChange').addEventListener('click', () => onShow('setup'));
$('onGo').addEventListener('click', () => ON.signIn(false).catch(e => onShow('signin', '!' + (e.message || e))));
$('onSwitch').addEventListener('click', () => { ON.forget(); ON.signIn(true).catch(e => onShow('signin', '!' + (e.message || e))); });
$('onList').addEventListener('change', e => {
  const t = e.target;
  if(t.dataset.onnb !== undefined) $('onList').querySelectorAll(`[data-nbi="${t.dataset.onnb}"]`).forEach(c => c.checked = t.checked);
  else if(t.dataset.nbi !== undefined){
    const all = [...$('onList').querySelectorAll(`[data-nbi="${t.dataset.nbi}"]`)];
    const nb = $('onList').querySelector(`[data-onnb="${t.dataset.nbi}"]`);
    nb.checked = all.some(c => c.checked);
  }
  const n = $('onList').querySelectorAll('[data-onsec]:checked').length;
  $('onRun').disabled = !n;
});
function onSummary(st, stopped){
  const parts = [`${st.pages} page${st.pages === 1 ? '' : 's'} imported`];
  if(st.skip) parts.push(`${st.skip} already here`);
  if(st.pics) parts.push(`${st.pics} picture${st.pics === 1 ? '' : 's'}`);
  if(st.inkPages) parts.push(`handwriting on ${st.inkPages} page${st.inkPages === 1 ? '' : 's'}`);
  return (stopped ? 'Stopped. ' : 'Done. ') + parts.join(' · ') + '.';
}
$('onRun').addEventListener('click', async () => {
  const sel = new Set([...$('onList').querySelectorAll('[data-onsec]:checked')].map(c => c.dataset.onsec));
  if(!sel.size) return;
  await flushSaves();
  onShow('run'); $('onProg').textContent = 'Starting…'; $('onCount').textContent = '';
  let st = null, stopped = false, err = null;
  try {
    st = await ON.importAll(sel, s => { $('onCount').textContent = onSummary(s).replace(/^Done\. /, ''); });
  } catch(e){
    if(e.message === 'stopped') stopped = true; else err = e;
  }
  if(err){ onFail(err); toast('OneNote import stopped: ' + (err.message === 'signin' ? 'sign in again' : err.message)); return; }
  onShow('done');
  const s = ON.lastSt;
  $('onSum').textContent = onSummary(s, stopped) + (stopped ? ' Run the import again to continue where it stopped.' : '');
  const notes = [];
  if(s.noInk) notes.push(`Microsoft did not send the handwriting of ${s.noInk} page${s.noInk === 1 ? '' : 's'}. Typed text and pictures came over; handwriting on those pages is missing.`);
  if(s.picFail) notes.push(`${s.picFail} picture${s.picFail === 1 ? '' : 's'} could not be downloaded.`);
  if(s.fail.length) notes.push(`${s.fail.length} page${s.fail.length === 1 ? '' : 's'} failed: ` + s.fail.slice(0, 8).join('; ') + (s.fail.length > 8 ? ' …' : ''));
  $('onFails').textContent = notes.join(' ');
  if(document.hidden || $('onenoteDlg').hidden) toast(onSummary(s, stopped));
});
$('onStop').addEventListener('click', () => { ON.stop = true; $('onProg').textContent = 'Stopping after this page…'; });

async function boot(){
  ON.catchRedirect();
  GD.catchRedirect();
  readTokens();
  await IDB.open();
  await Acct.load();
  await loadDocs();
  if(!docs.size){ await seed(); await loadDocs(); if(!ui.page){ ui.nb = 'nb-school'; ui.sec = 'sec-general'; ui.page = 'pg-welcome'; } }
  ensureUi();
  $('fingerBtn').classList.toggle('on', prefs.finger); renderScribe();
  $('mSnap').classList.toggle('on', prefs.snapLines);
  if(prefs.focus && width() !== 'narrow') app.classList.add('focus');
  if(prefs.calc) Calc.open();
  setTool(prefs.tool);
  renderNav(); renderList();
  resize();
  // if Inkwell closed unexpectedly while opening this page last time (e.g. out of memory), don't open it again by itself
  const crashedOn = LSget('inkwell.opening', null);
  if(crashedOn){
    LSset('inkwell.opening', null);
    showEmpty();
    const pg = getDoc(crashedOn);
    toast(`Inkwell closed unexpectedly while "${pg ? (pg.data.title || 'Untitled page') : 'a page'}" was open, so it was not reopened. Tap it in the list to open it.`);
  } else if(ui.page && getDoc(ui.page)){
    LSset('inkwell.opening', ui.page);
    await openPage(ui.page);
    setTimeout(() => LSset('inkwell.opening', null), 12000);
    if(width() === 'narrow') app.dataset.view = 'list';
  } else {
    const first = ui.sec && pagesOf(ui.sec)[0];
    if(first && width() !== 'narrow') await openPage(first.id); else showEmpty();
  }
  setStatus();
  const note = LSget('inkwell.note', null);   // a message from just before a reload (1.36: switching accounts)
  if(note){ LSset('inkwell.note', null); setTimeout(() => toast(note), 800); }
  Sync.init();
  if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  purgeTrash().catch(() => {});
  scanMarks().catch(() => {});
  setTimeout(() => HW.scanAll().catch(() => {}), 20000);
  setTimeout(() => PT.scanAll().catch(() => {}), 26000);
  setInterval(() => { if(document.visibilityState === 'visible'){ HW.scanAll().catch(() => {}); PT.scanAll().catch(() => {}); } }, 10 * 60000);
  // back from the Google sign-in (Google Drive for pictures)
  if(GD.ret) GD.finish().catch(e => console.warn('gdrive', e));
  // back from the Microsoft sign-in (Import from OneNote)
  if(ON.ret){
    showModal('onenoteDlg');
    if(ON.ret.error){ const m = ON.ret.error; ON.ret = null; onShow('signin', '!' + m); }
    else { onShow('pick', 'Signing in…'); ON.redeem().then(onLoadList, e => onShow('signin', '!' + (e.message || e))); }
  }
}
function themeChanged(){
  readTokens();
  for(const [id, el] of elMap){ const it = cur && cur.items.get(id); if(it && it.t === 'm') el.style.color = it.c && it.c !== 'auto' ? inkColor(it.c) : ''; }
  if(prefs.ruler.on) renderRulerTicks();
  invalidate();
}
darkMQ.addEventListener && darkMQ.addEventListener('change', themeChanged);
// leaving the app: save, then upload right away (iOS gives a few seconds), so another device sees the latest strokes
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') flushSaves().then(() => Sync.run()).then(() => GD.saveNotes(true)).catch(() => {}); else Sync.run(); });
setInterval(() => { if(document.visibilityState === 'visible') GD.saveNotes(); }, 60000);
// a normal close or reload is not a crash: clear the guard so the page reopens next time
addEventListener('pagehide', () => { LSset('inkwell.opening', null); flushSaves(); });

/* offline support */
if('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')){
  // An update that arrives right after Inkwell opens (or comes back to the front) is applied by itself:
  // the page reloads straight away, before any writing starts. Later ones are offered with a Reload button.
  let quietUntil = Date.now() + 20000;
  const idle = () => !act && !editing && !selDrag && Date.now() - lastLocalEdit > 3000;
  const offerUpdate = w => {
    if(!w || !navigator.serviceWorker.controller) return;
    if(Date.now() < quietUntil && idle()){ w.postMessage('skipWaiting'); return; }
    toast('A new version of Inkwell is ready', 'Reload', () => w.postMessage('skipWaiting'));
  };
  navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).then(reg => {
    swReg = reg;
    // an update that finished downloading while the app was in the background
    if(reg.waiting) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if(w.state === 'installed') offerUpdate(w.waiting || reg.waiting || w); });
    });
    // look for a new version on start, when the app comes back to the front, and every 15 minutes
    let lastCheck = 0;
    const check = () => {
      if(!navigator.onLine) return;
      lastCheck = Date.now();
      reg.update().then(() => { if(reg.waiting) offerUpdate(reg.waiting); }).catch(() => {});
    };
    check();
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState !== 'visible') return;
      quietUntil = Date.now() + 20000;
      if(Date.now() - lastCheck > 30000) check(); else if(reg.waiting) offerUpdate(reg.waiting);
    });
    setInterval(() => { if(document.visibilityState === 'visible') check(); }, 15 * 60000);
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if(reloaded) return; reloaded = true; LSset('inkwell.opening', null); flushSaves().then(() => location.reload()); });
}

window.__inkwell = {WA, ON, onInk, onTrace, onSplit, get cur(){ return cur; }, selectIds, get sel(){ return sel; }, Calc, calcEval, cleanScan, Clean, exportPdfFile, Pdf, Prac, Ask, Scribe, PT, ptxtOf, jumpToLine, Sync, exportPdf, printSheets, get exportJob(){ return exportJob; }, addItems, cam, HW, Ask, putAnswer, answerBlocks, texPlain, strokesToFormula, findSheet, warpSheet, cleanPaper, Scan, sliderPages, claudeJob, detectLines, scanMarks, openWheel, closeWheel, goToMark, clusterMarks, docs, prefs, parseFn, renderMd, buildGraph, Ask, renderDocx, startPick, recognize, setTool, openPage, newPage, IDB, deletePage, trashGroups, purgeTrash, removeDoc, removeItems, replaceItems, cleanHTML, htmlText, mergeContent, mergeKeys, flushSaves, saveContent, baseGet, saveAsset, Files, versionsOf, saveVersion, restoreVersion, openCleanup, renderCloud, snapCellAt, snapLineAt, pageTextAt, placeAt, fitCell, pageLines, detectLines, get lineReady(){ return lineReady; }, GD, renderGD};
boot().catch(e => { console.error(e); toast('Inkwell could not start: ' + (e.message || e)); });
})();
