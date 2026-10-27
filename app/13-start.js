/* Inkwell app, part 13 of 13: Start, Import from OneNote, test hooks.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
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
  window.__inkwellStep = 'opening the notes database';
  await IDB.open();
  await Acct.load();
  window.__inkwellStep = 'reading notebooks';
  await loadDocs();
  if(!docs.size){ await seed(); await loadDocs(); if(!ui.page){ ui.nb = 'nb-school'; ui.sec = 'sec-general'; ui.page = 'pg-welcome'; } }
  ensureUi();
  $('fingerBtn').classList.toggle('on', prefs.finger); renderScribe();
  $('mSnap').classList.toggle('on', prefs.snapLines);
  if(prefs.focus && width() !== 'narrow') app.classList.add('focus');
  if(prefs.calc) Calc.open();
  window.__inkwellStep = 'showing notebooks';
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
    window.__inkwellStep = 'opening the last page';
    await openPage(ui.page);
    setTimeout(() => LSset('inkwell.opening', null), 12000);
    if(width() === 'narrow') app.dataset.view = 'list';
  } else {
    const first = ui.sec && pagesOf(ui.sec)[0];
    if(first && width() !== 'narrow') await openPage(first.id); else showEmpty();
  }
  window.__inkwellStep = 'started'; window.__inkwellBooted = true;   // (1.64.2) see app.js
  // (1.67.3) a slow start (big page, slow iPad) showed "Starting is taking too long" after 8 s, and the box stayed
  // over the working app; it goes away now once Inkwell has started, unless an error was recorded
  { const sb = document.getElementById('inkwellStuck'); if(sb && !(window.__inkwellErrors || []).length) sb.remove(); }
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
  // (1.48.1) never reload in the middle of a stroke or right after one: wait until writing has paused
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(reloaded) return; reloaded = true;
    const t0 = Date.now();
    const go = () => {
      if((act || editing || selDrag || Date.now() - lastLocalEdit < 1500) && Date.now() - t0 < 60000){ setTimeout(go, 400); return; }
      LSset('inkwell.opening', null); flushSaves().then(() => location.reload());
    };
    go();
  });
}

window.__inkwell = {loadScript, pendAdd, pendDrop, assetRefs, DbSize, Spell, Live, HLS, invalidate, freshItems, GAdd, TSize, fieldParts, undo, redo, Paste, Clip, boxPoly, TS, pdfLines, savePtxt, CHANGELOG, mergeCurrent, applyRemote, baseSet, WA, strokePath, strokeShape, ON, onInk, onTrace, onSplit, get cur(){ return cur; }, selectIds, get sel(){ return sel; }, Calc, calcEval, cleanScan, Clean, exportPdfFile, Pdf, Prac, Ask, Scribe, PT, ptxtOf, jumpToLine, Sync, exportPdf, printSheets, get exportJob(){ return exportJob; }, addItems, cam, HW, putAnswer, answerBlocks, texPlain, strokesToFormula, findSheet, warpSheet, cleanPaper, Scan, sliderPages, claudeJob, detectLines, scanMarks, openWheel, closeWheel, goToMark, clusterMarks, docs, prefs, parseFn, renderMd, buildGraph, renderDocx, startPick, recognize, setTool, openPage, newPage, IDB, deletePage, trashGroups, purgeTrash, removeDoc, removeItems, replaceItems, cleanHTML, htmlText, mergeContent, mergeKeys, flushSaves, saveContent, baseGet, saveAsset, Files, versionsOf, saveVersion, restoreVersion, openCleanup, renderCloud, snapCellAt, snapLineAt, pageTextAt, placeAt, fitCell, pageLines, get lineReady(){ return lineReady; }, GD, renderGD};
boot().catch(e => { console.error(e); toast('Inkwell could not start: ' + (e.message || e)); });
