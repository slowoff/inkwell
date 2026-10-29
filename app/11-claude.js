/* Inkwell app, part 11 of 13: Ask Claude, practice, handwriting search, page text, Write to text, formulas.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
/* =====================================================================
   Ask Claude: scan a question (or just type) and get help in a floating window
   ===================================================================== */
const ASK_MAX_SCANS = 4;   // (1.52) scans attached to one question; (1.67) photos count too
const ASK_PHOTO_PX = 1568;  // longest side of an uploaded picture (more is not used by Claude, only costs time)
// an image file (also iPad HEIC photos, which Safari can show) as a JPEG data URL, at most ASK_PHOTO_PX, white behind
// transparent parts
async function photoJpeg(file){
  const u = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = u; await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight; if(!w || !h) throw new Error('empty picture');
    const k = Math.min(1, ASK_PHOTO_PX / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/jpeg', 0.85); c.width = c.height = 1;
    return out;
  } finally { URL.revokeObjectURL(u); }
}
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
    $('askLog').innerHTML = `<div class="ask-empty">Tap <b>scan</b> (the frame icon) and draw a box around a question on your page, add a <b>photo</b> (the picture icon), or just type. Claude also gets the typed text of the page you have open.<br><br><b>Tutor</b> explains and gives hints so you solve it yourself. <b>Solve</b> shows the full worked solution.<br><br><b>Practice</b> (same menu): pick pages with learning objectives, exercises or notes, and Claude quizzes you one exercise at a time.</div>`;
  },
  chats(){ return [...docs.values()].filter(d => d.kind === 'chat' && live(d)).sort((a, b) => (b.data.at || 0) - (a.data.at || 0)); },
  /* (1.68) History filter: chats from the open page, its section, its notebook, or all (prefs.askFilter, per device).
     A chat belongs to every page it asked a question from (view entries keep their page; data.page = the first). */
  chatPages(c){ return new Set([c.data.page, ...(c.data.view || []).filter(v => v && v.who === 'user').map(v => v.page)].filter(Boolean)); },
  // where the open page sits: {page, sec, nb} ids (null when no page is open)
  here(){
    const p = cur && getDoc(cur.id); if(!p) return null;
    const s = docs.get(p.data.sec);
    return {page: p.id, sec: p.data.sec || null, nb: s && s.data ? s.data.nb || null : null};
  },
  inScope(c, scope, h){
    if(scope === 'all' || !h) return true;
    for(const pid of this.chatPages(c)){
      if(scope === 'page'){ if(pid === h.page) return true; continue; }
      const p = docs.get(pid), sid = p && p.data ? p.data.sec : null;   // also pages in Recently deleted
      if(scope === 'sec'){ if(sid && sid === h.sec) return true; continue; }
      const s = sid && docs.get(sid), nid = s && s.data ? s.data.nb : null;
      if(nid && nid === h.nb) return true;
    }
    return false;
  },
  showHistory(){
    this.histOpen = true; $('askPanel').classList.add('hist');
    const all = this.chats(), h = this.here();
    const scopes = [['page', 'Page'], ['sec', 'Section'], ['nb', 'Notebook'], ['all', 'All']];
    let scope = ['page', 'sec', 'nb', 'all'].includes(prefs.askFilter) ? prefs.askFilter : 'all';
    if(!h) scope = 'all';
    const count = s => all.filter(c => this.inScope(c, s, h)).length;
    const sec = h && getDoc(h.sec), nb = h && getDoc(h.nb), pg = h && getDoc(h.page);
    const tip = {page: pg ? 'Chats from this page: ' + (pg.data.title || 'Untitled page') : '', sec: sec ? 'Chats from pages in the section ' + sec.data.name : '', nb: nb ? 'Chats from pages in the notebook ' + nb.data.name : '', all: 'All chats'};
    const bar = `<div class="seg ah-filter" role="group" aria-label="Show chats from">` + scopes.map(([k, l]) => {
      const off = k !== 'all' && !h;
      return `<button data-af="${k}" class="${k === scope ? 'on' : ''}"${off ? ' disabled' : ''} title="${esc(off ? 'Open a page to filter by it' : tip[k])}">${l} <span class="ah-n">${off ? '' : count(k)}</span></button>`;
    }).join('') + `</div>`;
    const list = all.filter(c => this.inScope(c, scope, h));
    const none = !all.length ? 'No saved chats yet. Every chat with Claude is kept here.'
      : {page: 'No chats from this page yet.', sec: 'No chats from this section yet.', nb: 'No chats from this notebook yet.'}[scope] || 'No chats.';
    const day = ms => { const d = new Date(ms), now = new Date(); const same = d.toDateString() === now.toDateString(); return same ? d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : d.toLocaleDateString([], {day: 'numeric', month: 'short'}) + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : ''); };
    $('askLog').innerHTML = `<div class="ah-head"><b>History</b><button class="btn ghost ah-back">Back to chat</button></div>` + (all.length ? bar : '') + (list.length ? list.map(c => {
      const pg = c.data.page && docs.get(c.data.page), n = (c.data.view || []).filter(v => v.who === 'user').length;
      return `<div class="ah-row ${c.id === this.chatId ? 'on' : ''}" data-chat="${c.id}"><button class="ah-open"><b>${esc(c.data.title || 'Chat')}</b><span>${esc(day(c.data.at || 0))}${pg && live(pg) ? ' · ' + esc(pg.data.title || 'Untitled page') : ''} · ${n} question${n === 1 ? '' : 's'} · ${c.data.mode === 'solve' ? 'Solve' : c.data.mode === 'practice' ? 'Practice' : 'Tutor'}</span></button><button class="ah-del" title="Delete this chat" aria-label="Delete chat"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button></div>`;
    }).join('') : `<div class="ask-empty">${esc(none)}</div>`);
  },
  showChat(){
    this.histOpen = false; $('askPanel').classList.remove('hist');
    $('askLog').innerHTML = '';
    if(!this.view.length){ this.empty(); return; }
    for(const v of this.view){
      if(v.who === 'user'){
        const as = Array.isArray(v.as) && v.as.length ? v.as : v.a ? [v.a] : [];   // (1.52) several scans in one question
        const d = this.bubble('user', as.map(() => '<img alt="Scanned question">').join('') + esc(v.text || '').replace(/\n/g, '<br>'));
        as.forEach((a, i) => { const img = d.querySelectorAll('img')[i]; const b = this.b64.get(a); if(b) img.src = 'data:image/jpeg;base64,' + b; else assetURL(a).then(u => { if(u) img.src = u; else img.replaceWith(Object.assign(document.createElement('div'), {className: 'am-noimg', textContent: 'Scan not downloaded yet'})); }); });
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
  async capture(x0, y0, x1, y1, opt){
    opt = opt || {};   // (1.53) {png, pad, max} for Copy as picture
    const pad = opt.pad ?? 6; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const w = x1 - x0, h = y1 - y0, s = clamp((opt.max || 1500) / Math.max(w, h), 0.2, 3);
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
    return opt.png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
  },
  async scan(x0, y0, x1, y1){
    this.open();
    let url;
    try { url = await this.capture(x0, y0, x1, y1); } catch(e){ this.bubble('err', 'Could not read that part of the page: ' + esc(e.message || e)); return; }
    const typed = this.pageText([x0, y0, x1, y1]);
    // attach the scan to the message box; it goes out when Send is tapped, with whatever is typed
    // (1.52) several scans can be attached (up to ASK_MAX_SCANS); they go out together in one question
    if(!Array.isArray(this.pending)) this.pending = [];
    if(this.pending.length >= ASK_MAX_SCANS){ toast('Up to ' + ASK_MAX_SCANS + ' pictures per question'); return; }
    this.pending.push({url, typed, box: [x0, y0, x1, y1]});
    this.renderPending();
    if(this.histOpen) this.showChat();
    try { $('askIn').focus({preventScroll: true}); } catch {}
  },
  // (1.67) photos and pictures from the iPad (camera, Photos, Files), pasted or dropped: attached like scans,
  // made smaller first (longest side ASK_PHOTO_PX, JPEG) so they upload fast and stay well under the server limit
  async addPhotos(files){
    const list = [...(files || [])].filter(f => f && (/^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(f.name || '')));
    if(!list.length) return;
    this.open();
    if(!Array.isArray(this.pending)) this.pending = [];
    let skipped = 0, bad = 0;
    for(const f of list){
      if(this.pending.length >= ASK_MAX_SCANS){ skipped++; continue; }
      try { this.pending.push({url: await photoJpeg(f), typed: '', box: null, photo: true}); }
      catch(e){ console.warn('ask photo', e); bad++; }
      this.renderPending();
    }
    if(skipped) toast('Up to ' + ASK_MAX_SCANS + ' pictures per question');
    else if(bad) toast(bad === 1 ? 'That picture could not be opened' : bad + ' pictures could not be opened');
    if(this.histOpen) this.showChat();
    try { $('askIn').focus({preventScroll: true}); } catch {}
  },
  renderPending(){
    const a = $('askAtt'), p = Array.isArray(this.pending) && this.pending.length ? this.pending : null;
    if(!p) this.pending = null;
    a.hidden = !p;
    const th = $('askThumbs'); th.innerHTML = '';
    if(p){
      p.forEach((x, i) => {
        const d = document.createElement('div'); d.className = 'ask-thumb';
        d.innerHTML = `<img alt="Scan ${i + 1}"><button class="ask-thumb-x" data-i="${i}" title="Remove this scan" aria-label="Remove scan ${i + 1}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
        d.querySelector('img').src = x.url; th.appendChild(d);
      });
      const word = p.some(x => x.photo) ? 'picture' : 'scan';
      $('askAttN').textContent = p.length === 1 ? word[0].toUpperCase() + word.slice(1) + ' attached' : p.length + ' ' + word + 's attached';
      $('askAttMore').hidden = p.length >= ASK_MAX_SCANS;
    }
    const many = p && p.length > 1;
    const what = p && p.some(x => x.photo) ? (many ? 'them' : 'it') : many ? 'the scans' : 'the scan';
    $('askIn').placeholder = this.mode === 'practice' ? (p ? 'Add a note, or just Send' : 'Your answer, or scan your work') : p ? `Ask about ${what}, or just Send` : 'Ask about your notes…';
    $('askSend').disabled = this.busy;
  },
  // Send button / Enter: typed text, plus the attached scan if there is one
  async submit(){
    const raw = $('askIn').value, t = raw.trim(), p = this.pending;
    if(!t && !p) return;
    if(this.busy) return;
    $('askIn').value = ''; autoGrow();
    this.pending = null; this.renderPending();
    let r;
    if(p){
      const many = p.length > 1;
      const typed = many ? p.map((x, i) => x.typed ? 'Scan ' + (i + 1) + ':\n' + x.typed : '').filter(Boolean).join('\n\n') : p[0].typed;
      const box = (p.find(x => x.box) || {}).box || null, photos = p.filter(x => x.photo).length;
      r = await this.send(t || (this.mode === 'practice' ? (many ? 'Here are my answers.' : 'Here is my answer.') : prefs.askMode === 'solve' ? (many ? 'Solve these questions.' : 'Solve this question.') : (many ? 'Help me with these.' : 'Help me with this question.')), p.map(x => x.url), typed, box, photos ? {photos} : undefined);
    }
    else r = await this.send(t);
    // (1.67.3) the question did not go through (no connection, server error, not signed in): the typed text and the
    // attached scans/pictures come back, so it can be sent again with one tap (before, they were gone)
    if(r === 'failed' && !$('askIn').value.trim() && !this.pending){
      $('askIn').value = raw; autoGrow();
      if(p){ this.pending = p; this.renderPending(); }
    }
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
    const auto = /^(Solve this question\.|Help me with this question\.|Solve these questions\.|Help me with these\.)$/;
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
    if(!Sync.sb){ this.bubble('err', 'Claude works through your sync account. Sync is not set up on this device.'); return 'failed'; }
    const {data} = await Sync.sb.auth.getSession();
    const session = data && data.session;
    if(!session){ this.bubble('err', 'Sign in first: Settings (gear, top left) → Sync.'); return 'failed'; }
    const content = [];
    let assetId = null;
    const urls = Array.isArray(imgURL) ? imgURL : imgURL ? [imgURL] : [], assetIds = [];
    for(const u of urls){
      // keep the scan as an asset so the chat history can show it and send it again later
      try { const id = await saveAsset(await (await fetch(u)).blob()); this.b64.set(id, u.split(',')[1]); content.push({type: 'image', a: id}); assetIds.push(id); }
      catch { content.push({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: u.split(',')[1]}}); }
    }
    assetId = assetIds[0] || null;
    let full = text;
    if(opts.photos) full += '\n\n[' + (opts.photos === urls.length ? (urls.length === 1 ? 'A picture I uploaded (photo or image file)' : urls.length + ' pictures I uploaded (photos or image files), in order') : urls.length + ' pictures in order: scanned parts of my page and photos or image files I uploaded') + ']';
    else if(urls.length > 1) full += '\n\n[' + urls.length + ' scanned parts of my page, in the order I scanned them]';
    if(typedInScan) full += '\n\n[Typed text inside the scanned area]\n' + typedInScan;
    if(opts.content){ content.push(...opts.content); full = null; }
    else if(!this.msgs.length && cur){
      const page = getDoc(cur.id), title = page ? (page.data.title || '').trim() : '';
      const pt = this.pageText(null);
      full += `\n\n[Open page in my notes${title ? ': "' + title + '"' : ''}]` + (pt ? '\nTyped text on the page:\n' + pt : '\n(no typed text on this page, only handwriting or imported pages)');
    }
    if(full !== null) content.push({type: 'text', text: full});
    this.msgs.push({role: 'user', content});
    const uv = {who: 'user', text}; if(assetId) uv.a = assetId; if(assetIds.length > 1) uv.as = assetIds; if(box && cur){ uv.box = box.map(v => Math.round(v * 10) / 10); uv.page = cur.id; } else if(cur) uv.page = cur.id;
    this.view.push(uv);
    this.bubble('user', urls.map((u, i) => `<img src="${u}" alt="Scanned question${urls.length > 1 ? ' ' + (i + 1) : ''}">`).join('') + esc(text).replace(/\n/g, '<br>'));
    const out = this.bubble('bot', '<span class="typing"></span>');
    this.busy = true; $('askSend').disabled = true;
    let acc = '', last = 0, result = 'failed';
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
      result = 'ok';
    } catch(e){
      this.msgs.pop(); this.view.pop();   // let the question be asked again
      if(e.name === 'AbortError'){ out.remove(); result = 'aborted'; }
      else { out.className = 'am err'; out.textContent = /Failed to fetch|Load failed|NetworkError/i.test(e.message) ? 'No connection to the server. Check the internet and try again.' : e.message; }
    }
    this.busy = false; this.ctrl = null; $('askSend').disabled = false;
    return result;
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
  const out = []; let list = null, para = [], quote = [];
  const flushP = () => { if(para.length){ out.push('<p>' + inline(para.join('<br>')) + '</p>'); para = []; } };
  const flushL = () => { if(list){ out.push(`<${list.t}>` + list.items.map(i => '<li>' + inline(i) + '</li>').join('') + `</${list.t}>`); list = null; } };
  // (1.69.3) "> text" quote lines: one block, a blank "> " line starts a new paragraph inside it
  const flushQ = () => { if(quote.length){ const ps = quote.join('\n').split(/\n\s*\n/).map(t => t.trim()).filter(Boolean); out.push('<blockquote>' + ps.map(t => '<p>' + inline(t.replace(/\n/g, '<br>')) + '</p>').join('') + '</blockquote>'); quote = []; } };
  for(const raw of s.split('\n')){
    const line = raw.trimEnd();
    let m;
    if((m = /^\s*(?:&gt;\s?)+(.*)$/.exec(line))){ flushP(); flushL(); quote.push(m[1]); continue; }
    flushQ();
    if(!line.trim()){ flushP(); flushL(); continue; }
    if((m = /^\s*#{1,6}\s+(.*)$/.exec(line))){ flushP(); flushL(); out.push('<h4>' + inline(m[1]) + '</h4>'); continue; }
    if((m = /^\s*[-*•]\s+(.*)$/.exec(line))){ flushP(); if(!list || list.t !== 'ul'){ flushL(); list = {t: 'ul', items: []}; } list.items.push(m[1]); continue; }
    if((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))){ flushP(); if(!list || list.t !== 'ol'){ flushL(); list = {t: 'ol', items: []}; } list.items.push(m[1]); continue; }
    if(list && /^\s{2,}/.test(raw)){ list.items[list.items.length - 1] += '<br>' + line.trim(); continue; }
    flushL(); para.push(line);
  }
  flushP(); flushL(); flushQ();
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
  const af = e.target.closest('[data-af]');
  if(af){ if(af.disabled) return; prefs.askFilter = af.dataset.af; savePrefs(); Ask.showHistory(); return; }
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
  const was = Ask.mode === 'practice' ? 'practice' : prefs.askMode;
  prefs.askMode = v; savePrefs();
  if(Ask.mode === 'practice') Ask.reset(); else Ask.renderMode();
  if(was !== v) note(v === 'solve' ? 'Solve · full worked solutions' : 'Tutor · hints, you solve it');
});
$('askSend').addEventListener('click', () => Ask.submit());
$('askAttX').addEventListener('click', () => { Ask.pending = null; Ask.renderPending(); });
$('askThumbs').addEventListener('click', e => { const b = e.target.closest('.ask-thumb-x'); if(!b || !Array.isArray(Ask.pending)) return; Ask.pending.splice(+b.dataset.i, 1); Ask.renderPending(); });
$('askAttMore').addEventListener('click', () => $('askScan').click());
// (1.67) upload pictures: the photo button (camera, Photos or Files on the iPad), paste, or drop on the panel
$('askPhoto').addEventListener('click', () => { $('askPhotoFile').value = ''; $('askPhotoFile').click(); });
$('askPhotoFile').addEventListener('change', e => Ask.addPhotos(e.target.files));
$('askIn').addEventListener('paste', e => {
  const files = [...(e.clipboardData && e.clipboardData.files || [])].filter(f => /^image\//.test(f.type));
  if(files.length){ e.preventDefault(); e.stopPropagation(); Ask.addPhotos(files); }
});
$('askPanel').addEventListener('dragover', e => { if(e.dataTransfer && [...e.dataTransfer.types].includes('Files')){ e.preventDefault(); e.stopPropagation(); } });
$('askPanel').addEventListener('drop', e => {
  const files = e.dataTransfer && e.dataTransfer.files; if(!files || !files.length) return;
  e.preventDefault(); e.stopPropagation(); Ask.addPhotos(files);
});
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
          const pdf = await pdfOpen(new Uint8Array(await file.arrayBuffer()));
          try {
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
          } finally { pdf.destroy().catch(() => {}); }   // (1.67.4) let the PDF go once its text is read
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
function mdInline(t){
  return esc(t).replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
}
// Answer (Markdown + LaTeX) -> page items: text boxes for text, formulas for display maths.
function answerBlocks(md){
  const blocks = [];
  let s = String(md || '').replace(/\r/g, '');
  // (1.69.3) quote markers ("> ") are dropped on the page: the quoted text becomes a normal paragraph
  s = s.replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
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
    const all = await IDB.prefix('c_')   // (1.60.2) page contents only;
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
  const vp = page.getViewport({scale: 1}), H = vp.height || 1, Wd = vp.width || 1, parts = [];
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
  // (1.52) a wide gap on the same height splits the line (columns, table cells), so one column can be selected
  const segs = [];
  for(const ln of lines){
    ln.parts.sort((a, b) => a.x - b.x);
    let seg = null, end = null;
    for(const p of ln.parts){
      if(!seg || p.x - end > Math.max(p.h, ln.h) * 1.5){ seg = {y: ln.y, h: ln.h, parts: []}; segs.push(seg); }
      seg.parts.push(p); end = seg.parts.length === 1 ? p.x + p.w : Math.max(end, p.x + p.w);
    }
  }
  segs.sort((a, b) => a.y - b.y || a.parts[0].x - b.parts[0].x);
  const out = [];
  let total = 0;
  for(const ln of segs){
    let s = '', end = null;
    for(const p of ln.parts){
      if(end !== null && p.x - end > p.h * 0.18 && !/\s$/.test(s) && !/^\s/.test(p.s)) s += ' ';
      s += p.s; end = p.x + p.w;
    }
    s = s.replace(/\s+/g, ' ').trim();
    if(!s) continue;
    // (1.52) also where the line sits left to right and how tall it is, for selecting text on the page:
    // [y, text, x0, x1, h] (older app versions only read y and text)
    const r3 = v => Math.round(clamp(v, 0, 1) * 1000) / 1000;
    let lx0 = Infinity, lx1 = -Infinity, lh = 0;
    for(const p of ln.parts){ lx0 = Math.min(lx0, p.x); lx1 = Math.max(lx1, p.x + p.w); lh = Math.max(lh, p.h); }
    out.push([r3((ln.y - ln.h) / H), s, r3(lx0 / Wd), r3(lx1 / Wd), r3(lh * 1.15 / H)]);
    total += s.length;
    if(total > 20000) break;
  }
  return out;
}
/* (1.52) Select text on imported pages: a lasso over an imported page (PDF, scan, photo) picks the lines of its
   page text (ptxt) that lie inside the loop. They light up, and a small menu offers Copy and Text… (a window to pick
   part of it, copy, or put it on the page as a text box). Lines with x0/x1 (PDFs imported from 1.52 on) are picked by
   where they are; older lines (only y) count as the full page width, so the loop only decides which rows. Nothing is
   stored; the selection is gone when anything else is done. If the loop also selected items, the selection menu gets
   a Text button instead (`#selText`). */
const TS = {
  lines: [],   // {it (picture id), b: [x0, y0, x1, y1] world, s}
  area: null,  // (1.53) box of the Box lasso (world), for Copy as picture
  find(wp, lb, area){
    this.clear();
    if(!cur || wp.length < 6) return;
    this.area = area || null;
    const lw = lb[2] - lb[0];
    const out = [];
    for(const it of cur.items.values()){
      if(it.t !== 'i' || !it.a) continue;
      if(it.x > lb[2] || it.x + it.w < lb[0] || it.y > lb[3] || it.y + it.h < lb[1]) continue;
      const d = ptxtOf(it.a); if(!d || !Array.isArray(d.l) || !d.l.length) continue;
      const L = d.l.filter(l => l && l[0] >= 0 && typeof l[1] === 'string').slice().sort((a, b) => a[0] - b[0]);
      // height of a line without a stored height: the gap to the next line, capped
      const gaps = []; for(let i = 1; i < L.length; i++){ const g = L[i][0] - L[i-1][0]; if(g > 0.004) gaps.push(g); }
      gaps.sort((a, b) => a - b);
      const gap0 = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.02;
      for(let i = 0; i < L.length; i++){
        const l = L[i], hasX = l.length >= 4 && l[3] > l[2];
        const hf = l[4] > 0 ? l[4] : Math.min(gap0, i + 1 < L.length && L[i+1][0] > l[0] ? L[i+1][0] - l[0] : gap0) * 0.92;
        const b = [it.x + (hasX ? l[2] : 0) * it.w, it.y + l[0] * it.h, it.x + (hasX ? l[3] : 1) * it.w, it.y + (l[0] + hf) * it.h];
        const my = (b[1] + b[3]) / 2;
        if(my < lb[1] || my > lb[3]) continue;
        const ox0 = Math.max(b[0], lb[0]), ox1 = Math.min(b[2], lb[2]);
        if(ox1 <= ox0) continue;
        if(hasX && ox1 - ox0 < Math.min(0.25 * (b[2] - b[0]), 0.6 * lw)) continue;   // the loop only grazes the line's end
        let n = 0; for(let k = 1; k <= 5; k++) if(pip(ox0 + (ox1 - ox0) * k / 6, my, wp)) n++;
        if(n >= 2) out.push({it: it.id, b, s: l[1]});
      }
    }
    out.sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0]);
    this.lines = out;
    if(sel){   // items selected too: Text / Copy as picture buttons in their menu
      $('selText').hidden = !out.length; $('selShot').hidden = !this.area;
      positionOverlays(); return;
    }
    if(out.length || this.area) this.show();
  },
  text(){ return this.lines.map(l => l.s).join('\n'); },
  show(){
    const box = $('tsBox'); box.innerHTML = '';
    if(this.area){ const d = document.createElement('b'); d.className = 'ts-area'; box.appendChild(d); this.areaEl = d; } else this.areaEl = null;
    for(const l of this.lines){ const d = document.createElement('i'); d.className = 'ts-line'; box.appendChild(d); l.el = d; }
    const n = this.lines.length;
    $('tsN').textContent = n === 1 ? '1 line' : n + ' lines';
    $('tsN').hidden = $('tsCopy').hidden = $('tsOpen').hidden = !n;
    $('tsShot').hidden = !this.area;
    $('tsLayer').hidden = false;
    this.place();
  },
  place(){
    if($('tsLayer').hidden || !(this.lines.length || this.area)) return;
    let u = [Infinity, Infinity, -Infinity, -Infinity];
    if(this.area && this.areaEl){
      const b = this.area, x = b[0] * cam.z + cam.ox, y = b[1] * cam.z + cam.oy, w = (b[2] - b[0]) * cam.z, h = (b[3] - b[1]) * cam.z;
      Object.assign(this.areaEl.style, {left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px'});
      u = [x, y, x + w, y + h];
    }
    for(const l of this.lines){
      const x = l.b[0] * cam.z + cam.ox, y = l.b[1] * cam.z + cam.oy, w = (l.b[2] - l.b[0]) * cam.z, h = (l.b[3] - l.b[1]) * cam.z;
      Object.assign(l.el.style, {left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px'});
      u = [Math.min(u[0], x), Math.min(u[1], y), Math.max(u[2], x + w), Math.max(u[3], y + h)];
    }
    const m = $('tsMenu'), mw = m.offsetWidth || 220, mh = m.offsetHeight || 46;
    let my = u[1] - mh - 10;
    if(my < 8) my = u[3] + 12;
    if(my > H - mh - 8) my = clamp(u[1] + 8, 8, H - mh - 8);
    m.style.left = clamp((u[0] + u[2]) / 2 - mw / 2, 8, Math.max(8, W - mw - 8)) + 'px';
    m.style.top = my + 'px';
  },
  clear(){
    this.lines = []; this.area = null;
    const L = $('tsLayer'); if(L && !L.hidden){ L.hidden = true; $('tsBox').innerHTML = ''; }
    const b = $('selText'); if(b) b.hidden = true;
    const c = $('selShot'); if(c) c.hidden = true;
  },
  async copy(text){
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch {
      const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
      try { ok = document.execCommand('copy'); } catch {}
      t.remove();
    }
    if(ok) Paste.mark();
    return ok;
  },
  open(){
    if(!this.lines.length) return;
    const lines = this.lines.slice();
    $('tsText').value = this.text();
    $('tsDlg').dataset.n = lines.length;
    this.last = lines;
    showModal('tsDlg');
  },
  // a text box with the (edited) text, right of the page the text came from, at the height of the first line
  put(text){
    const lines = this.last || [];
    if(!cur || !text.trim()) return;
    const first = lines[0], pic = first && cur.items.get(first.it);
    const x = pic ? pic.x + pic.w + 30 : (first ? first.b[2] + 30 : (W / 2 - cam.ox) / cam.z);
    const y = first ? first.b[1] : (H / 2 - cam.oy) / cam.z;
    const html = cleanHTML(text.split(/\n/).map(l => '<p>' + (esc(l) || '<br>') + '</p>').join(''));
    const it = {t: 'x', id: 'x' + newId(), x, y, w: 420, fs: 1, html};
    addItems([it]);
    return it;
  },
  // (1.53) Copy as picture: the box drawn like a screenshot (ink, pictures, imported pages, text) as a PNG on the
  // clipboard. The picture is made while the copy is already under way, so iPad Safari still counts the tap.
  // If the clipboard refuses, a window shows the picture to press and hold (Copy / Save) or put on the page.
  async shot(area){
    if(!cur || !area) return;
    const pr = Ask.capture(area[0], area[1], area[2], area[3], {png: true, pad: 0, max: 2400}).then(u => fetch(u)).then(r => r.blob());
    let ok = false;
    try {
      if(!navigator.clipboard || !window.ClipboardItem) throw new Error('no clipboard');
      await navigator.clipboard.write([new ClipboardItem({'image/png': pr})]); ok = true;
    } catch(e){ console.warn('copy picture', e); }
    if(ok){ Paste.mark(); toast('Picture copied: paste it anywhere, or here with Ctrl+V'); return; }
    let blob; try { blob = await pr; } catch(e){ toast('Could not make the picture'); return; }
    const url = URL.createObjectURL(blob);
    if(this.shotUrl) URL.revokeObjectURL(this.shotUrl);
    this.shotUrl = url; this.shotBlob = blob; this.shotArea = area.slice();
    $('shotImg').src = url;
    showModal('shotDlg');
  },
};
$('tsLayer').addEventListener('pointerdown', e => e.stopPropagation());
$('tsShot').addEventListener('click', () => { const a = TS.area; clearSel(); TS.shot(a); });
$('selShot').addEventListener('click', () => { const a = TS.area; clearSel(); TS.shot(a); });
$('shotPut').addEventListener('click', async () => {
  const blob = TS.shotBlob, area = TS.shotArea; hideModal('shotDlg');
  if(!blob || !cur) return;
  await Paste.image(blob, area ? [area[2] + 24 / cam.z, area[1]] : null, area ? area[2] - area[0] : null);
});
$('tsCopy').addEventListener('click', async () => { const n = TS.lines.length, ok = await TS.copy(TS.text()); toast(ok ? (n === 1 ? 'Copied 1 line' : 'Copied ' + n + ' lines') : 'Could not copy: use Text… and copy from there'); });
$('tsOpen').addEventListener('click', () => { TS.open(); });
$('selText').addEventListener('click', () => { const keep = TS.lines.slice(); clearSel(); TS.lines = keep; TS.open(); });
$('tsDlgCopy').addEventListener('click', async () => {
  const ta = $('tsText'), part = ta.selectionEnd > ta.selectionStart ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value;
  const ok = await TS.copy(part);
  toast(ok ? (part === ta.value ? 'Copied' : 'Copied the selected part') : 'Could not copy: select the text and use Copy from the iPad menu');
});
$('tsDlgPut').addEventListener('click', () => {
  const ta = $('tsText'), part = ta.selectionEnd > ta.selectionStart ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value;
  hideModal('tsDlg'); clearSel();
  if(TS.put(part)) toast('Put on the page as a text box');
});

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
    const all = await IDB.prefix('c_'), first = [], rest = [];   // (1.60.2) page contents only
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
      const html = cleanHTML(lines.map(l => '<p>' + wrap(l) + '</p>').join(''));
      out = {t: 'x', id: 'x' + newId(), x: b[0] - 6, y: (b[1] + b[3]) / 2 - hh / 2, w, fs: Math.round(px / 17 * 1000) / 1000, html};
      // (1.58.12) with Snap text to lines on, the text becomes the same box as one typed there: in the table cell or on
      // the answer line the ink was written on (handwriting sits just above the line, so its lower part is used)
      const pf = prefs.snapLines ? pageTextAt(b[0] + 2, (b[1] + b[3]) / 2) : 0;
      const at = [[b[0] + 4, b[1] + (b[3] - b[1]) * 0.75], [b[0] + 4, (b[1] + b[3]) / 2], [b[0] + 4, b[3]]];
      let sb = null;
      for(const [x, y] of at){ sb = snapBoxAt(x, y, pf, out.id); if(sb) break; }
      if(sb){
        // a box that starts left of the ink keeps its line start; the text keeps the ink colour
        out = Object.assign(sb, {html});
        if(!sb.ch) out.w = Math.max(sb.w, this.measure(lines, 17 * sb.fs) + 16);
      } else if(pf){
        // on an imported page without a line: the page's printed text size, like a typed box
        const fs = clamp(pf / 17, 0.25, 6), w2 = Math.max(40, this.measure(lines, pf) + 16), h2 = n * pf * 1.55 + 4;
        out = Object.assign(out, {fs: Math.round(fs * 1000) / 1000, w: w2, y: (b[1] + b[3]) / 2 - h2 / 2});
      }
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
    if(Sync.user) note('Write to text on · pause and your writing turns into text');
    else toast('Write to text is on, but it needs sync sign-in and internet (Claude reads the handwriting).');
  } else { Scribe.pending = []; clearTimeout(Scribe.timer); note('Write to text off'); }
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
  const page = cur;
  try {
    const img = inkImage(strokes, 1000);
    let tex = await claudeJob('latex', img.url, 'Convert this handwritten expression to LaTeX.');
    // (1.67.4) another page was opened, or the ink changed, while Claude was reading: leave everything as it is
    // (before, the formula was put on whatever page was open then)
    if(cur !== page || strokes.some(s => cur.items.get(s.id) !== s)){ toast('The page changed while Claude was reading, so the handwriting was kept.'); return; }
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
