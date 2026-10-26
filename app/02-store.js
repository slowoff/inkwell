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
  db: null, mem: null,
  async open(){
    try {
      this.db = await new Promise((res, rej) => {
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
          res(db);
        };
        r.onerror = () => { clearTimeout(waitT); rej(r.error); };
        // (1.60.2) another tab still runs the previous version: wait for it (it reloads by itself after the update)
        // instead of giving up and keeping notes in memory only, as before
        r.onblocked = () => { clearTimeout(waitT); waitT = setTimeout(() => toast('Updating your notes: close other Inkwell tabs or windows to continue.'), 2500); };
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
  all(store){ if(this.mem) return Promise.resolve([...this.mem[store].values()]); return this.req(store, 'readonly', s => s.getAll()); },
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
