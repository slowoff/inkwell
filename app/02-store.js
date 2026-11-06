/* Inkwell app, part 2 of 13: Local database (IndexedDB) and docs.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
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
  db: null, mem: null, opening: null, reopened: 0,
  stamp: 0,   // (1.72) goes up with every change to the docs store, so a reader can tell that nothing changed since it last looked
  // (1.90.4) the connection to the database, also used to open it again after iPadOS cut it (see lost / reopen)
  connect(){
    return new Promise((res, rej) => {
      // version 2 (1.60.2): index 'dirty' on docs, so a sync finds the unsynced docs without reading all of them
      const r = indexedDB.open(Acct.name(), 2);
      let waitT = 0;
      r.onupgradeneeded = e => {
        const d = r.result;
        if(e.oldVersion < 1){
          d.createObjectStore('docs', {keyPath: 'id'});
          d.createObjectStore('assets', {keyPath: 'id'});
          d.createObjectStore('meta');
        }
        const st = r.transaction.objectStore('docs');
        if(!st.indexNames.contains('dirty')) st.createIndex('dirty', 'dirty');
        // only numbers go into the index: any older "dirty: true" becomes 1, so no unsynced doc is missed
        if(e.oldVersion >= 1) st.openCursor().onsuccess = ev => {
          const c = ev.target.result; if(!c) return;
          const v = c.value;
          if(v.dirty && v.dirty !== 1){ v.dirty = 1; c.update(v); }
          c.continue();
        };
      };
      r.onsuccess = () => {
        clearTimeout(waitT);
        const db = r.result;
        // a later version opened in another tab: let it upgrade (save first, then reload into the new version)
        db.onversionchange = () => { flushSaves().catch(() => {}).finally(() => { db.close(); location.reload(); }); };
        // (1.90.4) the browser closed the connection by itself (storage lost): the next step opens it again
        db.onclose = () => { console.warn('storage connection closed'); if(this.db === db) this.db = null; };
        res(db);
      };
      r.onerror = () => { clearTimeout(waitT); rej(r.error); };
      // (1.60.2) another tab still runs the previous version: wait for it (it reloads by itself after the update)
      // instead of giving up and keeping notes in memory only, as before
      r.onblocked = () => { clearTimeout(waitT); waitT = setTimeout(() => toast('Updating your notes: close other Inkwell tabs or windows to continue.'), 2500); };
    });
  },
  async open(){
    this.opening = this.connect().then(db => { this.db = db; }).finally(() => { this.opening = null; });
    try { await this.opening; }
    catch(e){
      this.mem = {docs: new Map(), assets: new Map(), meta: new Map()};
      toast('Storage is blocked in this browser. Notes will be lost when you close it.');
    }
  },
  /* (1.90.4) iPadOS can cut a running app off from its storage ("UnknownError: Connection to Indexed Database server lost",
     e.g. after the app was in the background or the iPad ran short of memory). Every save failed from then on, until the app
     was closed, and what was written in between was lost with it. A step that fails that way now opens the database again
     and runs once more. */
  lost(e){
    const n = (e && e.name) || '', m = String((e && e.message) || '');
    return n === 'UnknownError' || n === 'InvalidStateError' || /connection|server lost|closing|is closed/i.test(m);
  },
  reopen(){
    if(this.mem) return Promise.resolve();
    if(!this.opening){
      const old = this.db; this.db = null;
      try { if(old) old.close(); } catch(e){}
      this.opening = this.connect().then(db => { this.db = db; this.reopened++; console.warn('storage opened again'); }).finally(() => { this.opening = null; });
    }
    return this.opening;
  },
  req(store, mode, fn, again){
    return (this.db ? Promise.resolve() : this.reopen()).then(() => new Promise((res, rej) => {
      if(!this.db) throw Object.assign(new Error('storage connection is closed'), {name: 'InvalidStateError'});
      const t = this.db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      let out;
      if(r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage write aborted'));
    })).catch(e => {
      if(again || this.mem || !this.lost(e)) throw e;
      console.warn('storage step failed, opening the database again', e);
      return this.reopen().then(() => this.req(store, mode, fn, true));
    });
  },
  get(store, key){ if(this.mem) return Promise.resolve(this.mem[store].get(key)); return this.req(store, 'readonly', s => s.get(key)); },
  put(store, val, key){
    if(store === 'docs') this.stamp++;
    if(this.mem){ this.mem[store].set(key !== undefined ? key : val.id, structuredClone(val)); return Promise.resolve(); }
    const p = this.req(store, 'readwrite', s => key !== undefined ? s.put(val, key) : s.put(val));
    return store === 'docs' || store === 'assets' ? p.then(v => { SaveWatch.ok(); return v; }, e => { SaveWatch.fail(e); throw e; }) : p;
  },
  del(store, key){ if(store === 'docs') this.stamp++; if(this.mem){ this.mem[store].delete(key); return Promise.resolve(); } return this.req(store, 'readwrite', s => s.delete(key)); },
  all(store){ if(this.mem) return Promise.resolve([...this.mem[store].values()]); return this.req(store, 'readonly', s => s.getAll()); },
  keys(store){ if(this.mem) return Promise.resolve([...this.mem[store].keys()]); return this.req(store, 'readonly', s => s.getAllKeys()); },
  // (1.67.3) read and write one value in a single transaction (for stores with out-of-line keys, e.g. meta), so two
  // changes at the same time cannot overwrite each other. Resolves to the new value.
  update(store, key, fn){
    if(store === 'docs') this.stamp++;
    if(this.mem){ const v = fn(structuredClone(this.mem[store].get(key))); this.mem[store].set(key, structuredClone(v)); return Promise.resolve(v); }
    let out;
    return this.req(store, 'readwrite', s => { const g = s.get(key); g.onsuccess = () => { out = fn(g.result); s.put(out, key); }; return null; }).then(() => out);
  },
  // (1.60.2) docs not uploaded yet, read through the 'dirty' index (before, every sync read the whole database twice)
  dirty(){
    if(this.mem) return Promise.resolve([...this.mem.docs.values()].filter(d => d.dirty).map(d => structuredClone(d)));
    return this.req('docs', 'readonly', s => s.indexNames.contains('dirty') ? s.index('dirty').getAll(IDBKeyRange.only(1)) : s.getAll())
      .then(list => (list || []).filter(d => d.dirty));
  },
  // docs whose id starts with prefix (e.g. 'c_' = page contents)
  prefix(p){
    if(this.mem) return Promise.resolve([...this.mem.docs.values()].filter(d => d.id.startsWith(p)));
    return this.req('docs', 'readonly', s => s.getAll(IDBKeyRange.bound(p, p + '￿')));
  }
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

/* (1.88) A write on the device that fails (storage full or blocked) used to show nothing: the writing stayed on screen and was
   gone after a reload. Now a warning stays up, what could not be written is kept in memory and tried again until it works.
   (1.90.4) The warning names the error. When signed in, what could not be saved on the device is uploaded straight to the
   cloud (cloud), so a restart brings it back; the warning then offers Restart, which also reconnects the device storage. */
const SaveWatch = {
  waiting: new Map(), timer: 0, shown: false, err: null,
  sent: new Map(), cloudT: 0, cloudBusy: false,   // sent: doc id -> the doc's `updated` that is in the cloud
  fail(e){
    console.warn('save failed', e);
    this.err = e;
    this.shown = true;
    this.show();
    if(!this.timer) this.timer = setTimeout(() => this.retry(), 10000);
    this.cloudSoon();
  },
  // every doc that could not be saved here is in the cloud in its latest version
  safe(){ return this.waiting.size > 0 && [...this.waiting.values()].every(r => this.sent.get(r.id) === r.updated); },
  show(){
    if(!this.shown) return;
    let el = $('saveWarn');
    if(!el){
      el = document.createElement('div'); el.id = 'saveWarn'; el.className = 'save-warn'; el.setAttribute('role', 'alert');
      el.innerHTML = '<span class="sw-text"></span><button type="button" class="sw-btn" hidden>Restart</button>';
      el.querySelector('.sw-btn').onclick = () => { LSset('inkwell.opening', null); location.reload(); };
      document.body.appendChild(el);
    }
    const e = this.err, why = e ? (e.name && e.name !== 'Error' ? e.name : String(e.message || e)).slice(0, 60) : '';
    const full = e && (e.name === 'QuotaExceededError' || /quota|full/i.test(String(e.message || '')));
    const safe = this.safe();
    el.querySelector('.sw-text').textContent = safe
      ? 'This device could not save your latest changes' + (why ? ' (' + why + ')' : '') + ', but they are saved in the cloud. Tap Restart to fix it.'
      : 'Your latest changes are not saved on this device' + (why ? ' (' + why + ')' : '') + '. Keep Inkwell open' + (full ? ' and free up space' : '') + ': it keeps trying' + (Sync.user ? ' and sends them to the cloud.' : '.');
    el.querySelector('.sw-btn').hidden = !safe;
    el.hidden = false;
  },
  ok(){
    if(!this.shown || this.waiting.size) return;
    this.shown = false; this.err = null; this.sent.clear();
    const el = $('saveWarn'); if(el) el.hidden = true;
    toast('Saved again');
  },
  async retry(){
    this.timer = 0;
    // (1.90.4) a broken connection is opened again first (also when the error did not look like one)
    if(this.waiting.size) await IDB.reopen().catch(e => console.warn('reopen', e));
    for(const [id, rec] of [...this.waiting]){
      try { await IDB.req('docs', 'readwrite', s => s.put(rec)); if(this.waiting.get(id) === rec) this.waiting.delete(id); }
      catch(e){ this.fail(e); return; }
    }
    if(this.waiting.size === 0 && this.shown){ Sync.soon(); this.ok(); }
    else if(this.shown) this.timer = setTimeout(() => this.retry(), 10000);
  },
  cloudSoon(){ if(!this.cloudT) this.cloudT = setTimeout(() => this.cloud(), 2500); },
  // upload what could not be saved here, straight from memory. Only docs whose merge base is known (baseTs) go up, with
  // that base as the expected server copy, so a newer copy from another device is never overwritten.
  async cloud(){
    this.cloudT = 0;
    if(!Sync.user || !Sync.sb || !navigator.onLine || !this.waiting.size) return;
    if(this.cloudBusy){ this.cloudSoon(); return; }
    this.cloudBusy = true;
    try {
      for(const rec of [...this.waiting.values()]){
        const upd = rec.updated;
        if(this.sent.get(rec.id) === upd) continue;
        const merge = MERGE_KINDS.has(rec.kind) && !rec.deleted && !!rec.data;
        if(merge && !baseTs.has(rec.id)) continue;
        const row = {id: rec.id, kind: rec.kind, data: rec.data ?? null, deleted: !!rec.deleted, updated_at: upd};
        let ts = null;
        if(Sync.noPut){
          const {data, error} = await Sync.sb.from('docs').upsert([Object.assign({}, row, {user_id: Sync.user.id})], {onConflict: 'user_id,id'}).select('id,server_ts');
          if(error) throw error;
          ts = data && data[0] && data[0].server_ts;
        } else {
          const {data, error} = await Sync.sb.rpc('docs_put', {p_rows: [Object.assign(row, {exp: merge ? baseTs.get(rec.id) : null})]});
          if(error) throw error;
          const hit = data && Array.isArray(data.ok) && data.ok.find(x => x.id === rec.id);
          ts = hit && hit.server_ts;
        }
        if(!ts) continue;   // another device changed it meanwhile: it stays here until the device can save again
        if(merge) baseTs.set(rec.id, ts);
        this.sent.set(rec.id, upd);
      }
    } catch(e){ console.warn('cloud copy of unsaved changes', e); }
    finally { this.cloudBusy = false; }
    this.show();
    if(this.waiting.size && !this.safe() && Sync.user) this.cloudT = setTimeout(() => this.cloud(), 15000);
  }
};
async function writeDoc(rec){
  rec.updated = Math.max(Date.now(), (rec.updated || 0) + 1);
  rec.dirty = 1;
  rec.deleted = !!rec.deleted;
  if(inMap(rec.kind)) docs.set(rec.id, rec);
  searchCache = null;
  try { await IDB.put('docs', rec); SaveWatch.waiting.delete(rec.id); }
  catch(e){ SaveWatch.waiting.set(rec.id, rec); throw e; }
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
// (1.63.1) 10 versions per page (was 30): page history was most of the database; older ones go when the page gets a new one
const VER_GAP = 30 * 60000, VER_KEEP = 10;
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
/* Pictures waiting to upload: meta 'pendingAssets' = [asset id, …].
   (1.67.3) Changed only through pendAdd / pendDrop, each one read-and-write in a single transaction. Before, the
   list was read, then written back in a second step: a picture saved while an upload finished (an import with many
   pages, while sync uploads the first ones) could drop out of the list and never upload. That is how one page of a
   121-page import stayed on the importing device only. */
const pendList = p => Array.isArray(p) ? p : [];
const pendAdd = ids => IDB.update('meta', 'pendingAssets', p => { const l = pendList(p); for(const id of ids) if(!l.includes(id)) l.push(id); return l; });
const pendDrop = id => IDB.update('meta', 'pendingAssets', p => pendList(p).filter(x => x !== id));
async function saveAsset(blob){
  const id = 'a-' + newId();
  await IDB.put('assets', {id, blob, type: blob.type || 'image/jpeg'});
  await pendAdd([id]);
  Sync.soon();
  return id;
}
// asset ids a doc refers to: key "a" (pictures, chat scans) and (1.52) "as" (all scans of a Claude question)
function assetRefs(v, out){
  if(!v || typeof v !== 'object') return out;
  if(Array.isArray(v)){ for(const x of v) assetRefs(x, out); return out; }
  for(const k in v){
    const x = v[k];
    if(k === 'a' && typeof x === 'string') out.add(x);
    else if(k === 'as' && Array.isArray(x)){ for(const s of x) if(typeof s === 'string') out.add(s); }
    else if(x && typeof x === 'object') assetRefs(x, out);
  }
  return out;
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
