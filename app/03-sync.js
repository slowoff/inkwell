/* Inkwell app, part 3 of 13: Sync with Supabase, picture storage, Google Drive.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
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
      DbSize.check().catch(() => {});   // (1.64) how full the notes server is (hourly)
      this.repairAssets().catch(e => console.warn('picture check', e));   // (1.67.3) once a day
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
  /* Pull (1.60.2). The server stamps a row (server_ts) when it is written, but the row only becomes visible when
     its upload finishes, so a slow upload can show up with a time older than a faster one that a pull already
     saw. Pulling strictly after the last time seen skipped such rows for good. Now every pull looks back
     PULL_OVERLAP: first a light list of id + time, then only the rows not seen yet are downloaded in full. */
  async seenLoad(){
    const k = 'pullSeen:' + this.user.id;
    if(!this.seen || this.seenUser !== this.user.id){ this.seen = (await IDB.get('meta', k)) || {}; this.seenUser = this.user.id; }
    return this.seen;
  },
  seenSave(cursor){
    if(!this.seen) return Promise.resolve();
    if(cursor){   // keep only what a later overlapping pull can still list
      const cut = tsKey(new Date(tsMs(cursor) - 2 * PULL_OVERLAP).toISOString());
      for(const [id, ts] of Object.entries(this.seen)) if(tsKey(ts) < cut) delete this.seen[id];
    }
    return IDB.put('meta', this.seen, 'pullSeen:' + this.seenUser);
  },
  async pull(){
    const key = 'pull:' + this.user.id;
    const cursor = (await IDB.get('meta', key)) || null;
    const seen = await this.seenLoad();
    let from = cursor ? new Date(tsMs(cursor) - PULL_OVERLAP).toISOString() : '1970-01-01T00:00:00Z';
    let top = cursor, changed = false, gte = false;
    for(let guard = 0; guard < 500; guard++){
      let q = this.sb.from('docs').select('id,server_ts').order('server_ts', {ascending: true}).limit(PULL_LIST);
      q = gte ? q.gte('server_ts', from) : q.gt('server_ts', from);
      const {data, error} = await q;
      if(error) throw error;
      const list = data || [];
      const need = [...new Set(list.filter(r => !tsEq(seen[r.id], r.server_ts)).map(r => r.id))];
      for(let i = 0; i < need.length; i += 100){
        const full = await this.sb.from('docs').select('id,kind,data,deleted,updated_at,server_ts').in('id', need.slice(i, i + 100));
        if(full.error) throw full.error;
        const rows = (full.data || []).sort((a, b) => tsKey(a.server_ts) < tsKey(b.server_ts) ? -1 : 1);
        for(const row of rows){
          if(await applyRemote(row)) changed = true;
          seen[row.id] = row.server_ts;
          if(!top || tsKey(row.server_ts) > tsKey(top)) top = row.server_ts;
        }
      }
      for(const r of list){ if(!seen[r.id]) seen[r.id] = r.server_ts; if(!top || tsKey(r.server_ts) > tsKey(top)) top = r.server_ts; }
      if(list.length < PULL_LIST) break;
      const last = list[list.length - 1].server_ts;
      if(gte && tsEq(last, from)) break;   // a whole page with one time (cannot really happen): stop instead of looping
      from = last; gte = true;
    }
    if(top && top !== cursor) await IDB.put('meta', top, key);
    await this.seenSave(top);
    if(changed) remoteChanged();
  },
  // Right before uploading: if another device changed one of these docs since this device last saw it,
  // fetch that version and merge it in first, so the upload does not overwrite it.
  // (1.60.2) With the server's docs_put this is only needed for docs whose base has no server time yet (seeded
  // from an old install); docs_put itself refuses to overwrite a newer copy. Without docs_put: all, as before.
  async checkStale(seededOnly){
    const cand = (await IDB.dirty()).filter(d => !d.deleted && d.data && MERGE_KINDS.has(d.kind));
    let merged = 0;
    for(let i = 0; i < cand.length; i += 100){
      const part = cand.slice(i, i + 100), bases = new Map();
      for(const d of part){ const b = await baseGet(d.id); if(b && (!seededOnly || !b.ts)) bases.set(d.id, b); }
      const ids = part.filter(d => bases.has(d.id)).map(d => d.id);
      if(!ids.length) continue;
      const {data, error} = await this.sb.from('docs').select('id,server_ts').in('id', ids);
      if(error) throw error;
      const stale = (data || []).filter(r => !tsEq(r.server_ts, bases.get(r.id).ts)).map(r => r.id);
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
  // server copy of conflicting docs: merge it in (they stay dirty, now based on the server copy) for the next try
  async resolve(ids){
    let merged = 0;
    for(let i = 0; i < ids.length; i += 100){
      const full = await this.sb.from('docs').select('id,kind,data,deleted,updated_at,server_ts').in('id', ids.slice(i, i + 100));
      if(full.error) throw full.error;
      for(const row of full.data || []) if(await applyRemote(row)) merged++;
    }
    if(merged) remoteChanged();
  },
  // what the server copy must still be for a doc to be written (see supabase/migrations/20261025_docs_put.sql)
  async expOf(d){
    if(!MERGE_KINDS.has(d.kind) || d.deleted || !d.data) return null;
    const b = await baseGet(d.id);
    return b ? (b.ts || null) : 'new';
  },
  async push(){
    if(this.noPut) await this.checkStale(false);
    else await this.checkStale(true);
    this.refused = null;
    let sent = 0, only = null;
    for(let round = 0; round < 3; round++){
      let dirty = await IDB.dirty();
      if(only) dirty = dirty.filter(d => only.has(d.id));
      if(!dirty.length) break;
      const r = await this.upload(dirty);
      if(r === 'retry') return this.push();   // docs_put is missing on this server: start over the old way
      sent += r.sent;
      if(!r.conflicts.length) break;
      await this.resolve(r.conflicts);
      only = new Set(r.conflicts);
    }
    return sent;
  },
  async upload(dirty){
    let batch = [], size = 0, sent = 0;
    const conflicts = [];
    const LIMIT = /notes_full|doc_too_big/;
    const seen = await this.seenLoad();
    const put = async rows => {
      if(this.noPut){
        const {data, error} = await this.sb.from('docs').upsert(rows.map(({exp, ...r}) => Object.assign(r, {user_id: this.user.id})), {onConflict: 'user_id,id'}).select('id,server_ts');
        return {ok: data || [], conflict: [], error};
      }
      if(typeof this.sb.rpc !== 'function'){ this.noPut = true; return 'retry'; }
      const {data, error, status} = await this.sb.rpc('docs_put', {p_rows: rows});
      // the server has no docs_put yet (migration not applied): use the plain upload, as before 1.60.2
      const odd = !error && !(data && Array.isArray(data.ok));
      if((error && (error.code === 'PGRST202' || status === 404 || /Could not find the function/i.test(String(error.message || '')))) || (odd && (status === 404 || !data))){
        console.warn('docs_put missing, using plain upload', error || status); this.noPut = true; return 'retry';
      }
      // an answer that is neither an error nor a result must not count as uploaded
      if(odd) throw new Error('unexpected answer from the server (' + status + ')');
      return {ok: data ? data.ok : [], conflict: (data && data.conflict) || [], error};
    };
    const flush = async () => {
      if(!batch.length) return;
      const rows = [];
      for(const d of batch) rows.push({id: d.id, kind: d.kind, data: d.data ?? null, deleted: !!d.deleted, updated_at: d.updated, exp: await this.expOf(d)});
      let res = await put(rows);
      if(res === 'retry') return 'retry';
      let {ok, conflict, error} = res;
      // (1.36) the server refused a doc (notes limit reached, or one doc too big): upload the others one by one,
      // so one refused doc does not stop everything else from syncing. Refused ones stay on this device.
      if(error && LIMIT.test(String(error.message || '')) && rows.length === 1){ this.refused = String(error.message).match(LIMIT)[0]; ok = []; conflict = []; error = null; }
      else if(error && LIMIT.test(String(error.message || ''))){
        ok = []; conflict = [];
        for(const row of rows){
          const one = await put([row]);
          if(one === 'retry') return 'retry';
          if(one.error){
            if(!LIMIT.test(String(one.error.message || ''))) throw one.error;
            this.refused = String(one.error.message).match(LIMIT)[0];
          } else { ok.push(...one.ok); conflict.push(...one.conflict); }
        }
        error = null;
      }
      if(error) throw error;
      conflicts.push(...conflict);
      const ts = new Map(ok.map(r => [r.id, r.server_ts]));
      for(const d of batch){
        if(!ts.has(d.id)) continue;
        seen[d.id] = ts.get(d.id);
        if(!MERGE_KINDS.has(d.kind)) continue;
        if(d.deleted || !d.data) await baseDel(d.id);
        else await baseSet(d.id, d.data, ts.get(d.id));
      }
      for(const d of batch){
        if(!ts.has(d.id)) continue;
        sent++;
        const now = await IDB.get('docs', d.id);
        if(now && now.updated === d.updated){
          now.dirty = 0; await IDB.put('docs', now);
          const m = docs.get(d.id); if(m && m.updated === d.updated) m.dirty = 0;
          // (1.59.1) the open page's copy in memory too: it stayed "dirty" for good after the first edit, so every
          // change from another device counted as a clash and was merged and uploaded straight back
          if(cur && cur.crec && cur.crec.id === d.id && cur.crec.updated === d.updated) cur.crec.dirty = 0;
        }
      }
      batch = []; size = 0;
    };
    for(const d of dirty){
      const s = JSON.stringify(d.data || null).length;
      if(batch.length && size + s > 1500000){ if(await flush() === 'retry') return 'retry'; }
      batch.push(d); size += s;
    }
    if(await flush() === 'retry') return 'retry';
    await this.seenSave();
    return {sent, conflicts};
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
    // (1.67.3) one picture that keeps failing (e.g. a broken file Google refuses) no longer holds up all the others
    // behind it: it is skipped for this run and the error is reported after the rest are uploaded
    const skip = new Set();
    let firstErr = null;
    for(;;){
      const id = pend.find(x => !skip.has(x));
      if(!id) break;
      const a = await IDB.get('assets', id);
      if(a){
        if(r2){
          try { await Files.upload(id, a.blob); Files.full = null; }
          catch(e){
            if(e.code === 'cloud_full' || e.code === 'storage_full' || e.code === 'gdrive_full' || e.code === 'need_drive'){ Files.full = Object.assign({at: Date.now(), code: e.code}, e.j || {}); Files.localOnly = pend.length; Files.notice(); renderSyncInfo(); return; }
            if(e.code === 'offline' || e.code === 'not_signed_in' || e.code === 'g_none' || e.code === 'g_revoked') throw e;
            console.warn('picture upload', id, e);
            firstErr = firstErr || e; skip.add(id); continue;
          }
        } else {
          const {error} = await this.sb.storage.from('assets').upload(this.user.id + '/' + id, a.blob, {contentType: a.type || 'image/jpeg', upsert: true});
          if(error) throw error;
        }
      }
      pend = await pendDrop(id);
      Files.localOnly = pend.length;
    }
    if(firstErr) throw firstErr;
  },
  /* (1.67.3) Once a day: pictures that are on this device and used by a note, but neither on the server nor waiting to
     upload, are put back in the upload list. Before 1.67.3 a picture could drop out of the list (see pendAdd) and then
     never reached the other devices; this brings such pictures back as long as this device still has them. */
  async repairAssets(){
    if(!this.user || !Acct.mine()) return;
    const k = 'inkwell.assetCheck', day = new Date().toDateString(), st = LSget(k, null) || {};
    if(st.day === day && st.uid === this.user.id) return;
    if(!(await Files.on())) return;
    const local = (await IDB.keys('assets')).filter(id => typeof id === 'string' && /^a-[A-Za-z0-9_-]{1,64}$/.test(id));
    if(!local.length){ LSset(k, {day, uid: this.user.id}); return; }
    const used = new Set();
    for(const d of await IDB.all('docs')) if(d.kind !== 'ptxt' && d.data) assetRefs(d.data, used);
    const cand = local.filter(id => used.has(id));
    if(!cand.length){ LSset(k, {day, uid: this.user.id}); return; }
    const {files} = await Files.call('list');
    const onServer = new Set((files || []).map(f => f && f.id));
    const pend = new Set(pendList(await IDB.get('meta', 'pendingAssets')));
    const lost = cand.filter(id => !onServer.has(id) && !pend.has(id));
    LSset(k, {day, uid: this.user.id, found: lost.length});
    if(lost.length){ console.warn('pictures not uploaded yet, queued again', lost.length); await pendAdd(lost); this.soon(); }
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
  /* (1.46) Word -> PDF through Google Docs. The browser's own Word drawing (docx-preview) cannot do floating text boxes,
     anchored pictures or EMF images, so pages came out scrambled. The .docx is uploaded as a Google Doc (Drive converts
     it), exported as PDF, and the temporary Google Doc is deleted again. Needs Google sign-in; the caller falls back
     to the old drawing without it. */
  async wordToPdf(file){
    let id = null, t;
    try {
      for(let k = 0; k < 2 && !id; k++){
        t = await this.token(k > 0);
        const b = 'inkwell' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        const meta = JSON.stringify({name: (file.name || 'Word file').replace(/\.docx$/i, '') + ' (Inkwell, temporary)', mimeType: 'application/vnd.google-apps.document', parents: t.folder ? [t.folder] : undefined});
        const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`, file, `\r\n--${b}--`]);
        const r = await fetch(GD_UPLOAD, {method: 'POST', headers: {Authorization: 'Bearer ' + t.at, 'Content-Type': 'multipart/related; boundary=' + b}, body});
        if(r.status === 401 && k === 0) continue;
        const j = await r.json().catch(() => ({}));
        if(!r.ok || !j.id) throw new Error('Google could not convert the Word file (' + r.status + ')');
        id = j.id;
      }
      if(!id) throw new Error('Google sign-in expired');
      const r = await fetch(GD_FILES + '/' + encodeURIComponent(id) + '/export?mimeType=application%2Fpdf', {headers: {Authorization: 'Bearer ' + t.at}});
      if(!r.ok) throw new Error('Google could not make a PDF (' + r.status + ')');
      const pdf = await r.blob();
      if(pdf.size < 100) throw new Error('Google sent an empty PDF');
      return pdf;
    } finally {
      // the temporary Google Doc was made by Inkwell only for this; remove it (a failure just leaves it in the Inkwell folder)
      if(id) fetch(GD_FILES + '/' + encodeURIComponent(id), {method: 'DELETE', headers: {Authorization: 'Bearer ' + t.at}}).catch(() => {});
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
const baseGet = id => IDB.get('meta', 'base:' + id);
const baseSet = (id, d, ts) => IDB.put('meta', {d, ts: ts || null}, 'base:' + id);
const baseDel = id => IDB.del('meta', 'base:' + id);
// b, l, r: content data with serialised items. lNew: the local side was edited more recently.
// (1.59.1) strokes and other items added on this device in the last few minutes (page id + time). A merge never
// drops one of these just because the other side lacks it: two devices uploading at almost the same moment could
// let the older copy overwrite the server, which then looked like the new strokes had been erased elsewhere.
const freshItems = new Map(), FRESH_MS = 5 * 60000;
const isFresh = id => { const t = freshItems.get(id); return !!t && Date.now() - t < FRESH_MS; };
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
  const isBusy = () => !!((lrec && lrec.dirty) || saveContentSoon.pending() || editing || act || (c.crec && c.crec.dirty));
  const snap = () => {
    const local = {bg: c.bg, items: [...c.items.values()].map(ser)};
    if(c.lastId) local.last = c.lastId;
    if(lrec && lrec.data) for(const k of Object.keys(lrec.data)) if(!(k in local)) local[k] = lrec.data[k];
    return local;
  };
  // (1.48.1) the backup copy is saved first; the page is read and merged only after that, with no waiting in
  // between, so a stroke finished while the backup was being written is part of the merge (it used to be lost)
  if(isBusy()) await saveVersion(c.id, snap(), 'merge').catch(e => console.warn('version', e));
  if(cur !== c) return false;
  // (1.59.1) an incoming copy that lacks strokes written here a moment ago is an older copy that won a crossing
  // upload: merge (which keeps them) and upload again, instead of taking it as it is
  const rIds = new Set(((row.data && row.data.items) || []).map(it => it && it.id));
  // (1.60.2) only needed while the server lacks docs_put: with it, a crossing upload is refused instead of winning,
  // and keeping "fresh" strokes made a stroke erased on the other device come back here
  const keepFresh = Sync.noPut ? isFresh : null;
  const busy = isBusy() || (!!keepFresh && [...c.items.keys()].some(id => keepFresh(id) && !rIds.has(id)));
  let data, copies = 0;
  if(!busy){
    if(!base && lrec && lrec.updated >= row.updated_at) return false;
    data = row.data;
  } else {
    const m = mergeContent(base && base.d, snap(), row.data, (lrec ? lrec.updated : Date.now()) > row.updated_at || !!editing || !!act, keepFresh);
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
  } else if(!saveContentSoon.pending() && !editing && stable({bg: data.bg, items: data.items}) === stable({bg: row.data.bg, items: row.data.items})){
    // (1.59.1) the merge came out the same as the server copy: store it as synced instead of uploading it again
    // (an idle device used to send every page it merged straight back, so two open devices kept bouncing it)
    const rec = {id: row.id, kind: row.kind, data: row.data, deleted: false, updated: Math.max(row.updated_at, lrec ? lrec.updated : 0), dirty: 0};
    await IDB.put('docs', rec);
    if(cur === c) c.crec = rec;
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
  if(base && base.ts && tsEq(base.ts, row.server_ts)) return false;   // this device's own upload
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
