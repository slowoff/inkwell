/* Inkwell app, part 8 of 13: Import PDFs and images, export as PDF.
   (1.62.1) app.js was one big function; it is now these classic scripts, loaded in order by index.html and sharing one
   global scope, so every name works as before. Code that runs while a file loads must not use a function from a later
   file (tests/unit/load_order.test.js checks this). */
'use strict';
/* =====================================================================
   Import PDFs and images ("print onto page")
   ===================================================================== */
let imp = null;
if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
$('insertBtn').addEventListener('click', () => {
  if(!cur){ toast('Open a page first'); return; }
  resetImport(); showModal('importDlg');
});
function dropImport(){ if(imp && imp.close) imp.close(); imp = null; }
let impRot = 0;   // (1.59) turn all pages before importing (scans made sideways)
function renderImpRot(){
  $('impRotVal').textContent = impRot === 0 ? 'upright' : impRot === 180 ? 'upside down' : impRot === 90 ? '90° right' : '90° left';
  const prev = $('importPreview');
  for(const el of prev.querySelectorAll('canvas,img')){
    if(!el._src){ el._src = el.tagName === 'IMG' ? el : rotCanvas(el, 0); }
    const t = rotCanvas(el._src, impRot); t._src = el._src;
    t.className = el.className; el.replaceWith(t);
  }
}
function turnImport(d){ impRot = (impRot + d + 360) % 360; renderImpRot(); }
function resetImport(){
  dropImport();
  impRot = 0; $('impRotVal').textContent = 'upright';
  $('importPick').hidden = false; $('importSetup').hidden = true;
  $('importFile').value = ''; $('importPreview').innerHTML = ''; $('impStatus').textContent = '';
  $('impGo').disabled = false;
}
$('impOther').addEventListener('click', resetImport);
$('importFile').addEventListener('change', async () => {
  const f = $('importFile').files[0]; if(!f) return;
  $('importPick').hidden = true; $('importSetup').hidden = false; $('impStatus').textContent = 'Reading file';
  try { const hint = await loadImport(f); $('impStatus').textContent = hint || ''; if($('importDlg').hidden) dropImport(); else if(impRot) renderImpRot(); }
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
  dropImport();
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
    // (1.46) signed in: Google Docs turns it into a PDF, which then imports like any PDF (exact layout, searchable text)
    if(Sync.user && navigator.onLine){
      $('impStatus').textContent = 'Turning the Word file into a PDF…';
      let pdf = null;
      try { pdf = await GD.wordToPdf(f); } catch(e){ console.warn('word to pdf', e); }
      if(pdf){
        const name = f.name.replace(/\.docx$/i, '').trim();
        await loadImport(new File([pdf], name + '.pdf', {type: 'application/pdf'}));
        imp.name = name;
        return '';
      }
    }
    var hint = Sync.user ? 'Google could not convert this file, so Inkwell drew it itself: text boxes and some pictures may be out of place.'
      : 'Not signed in, so Inkwell drew this Word file itself: text boxes and some pictures may be out of place. Sign in with Google (Settings) for exact pages.';
    // (1.46) only the layout and page 1 now; the other pages are made after "Print onto page", while you keep working
    const d = await openDocx(f);
    imp = {kind: 'docx', d, close: d.close, n: d.est, name: f.name.replace(/\.docx$/i, '').trim()};
    let pg;
    try { pg = await d.next(); } catch(e){ d.close(); imp = null; throw e; }
    if(!pg){ d.close(); imp = null; throw new Error('No pages found in this Word file'); }
    imp.first = pg;
    $('impPagesWrap').hidden = false; $('impPages').value = '';
    $('impCount').textContent = d.est > 1 ? `(about ${d.est} pages)` : '(1 page)';
    { const t = document.createElement('canvas'), k = 120 / pg.canvas.width; t.width = 120; t.height = Math.round(pg.canvas.height * k); t.getContext('2d').drawImage(pg.canvas, 0, 0, t.width, t.height); prev.appendChild(t); }
    if(d.est > 1){ const m = document.createElement('span'); m.className = 'more'; m.textContent = `+ about ${d.est - 1} more`; prev.appendChild(m); }
    $('impGo').disabled = false;
    return hint;
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
$('impRotL').addEventListener('click', () => turnImport(-90));
$('impRotR').addEventListener('click', () => turnImport(90));
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
// (1.59) a canvas (or picture) turned by deg (90 = clockwise, 180, 270); returns a new canvas
function rotCanvas(src, deg){
  deg = ((deg % 360) + 360) % 360;
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const c = document.createElement('canvas');
  c.width = deg % 180 ? h : w; c.height = deg % 180 ? w : h;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.translate(c.width / 2, c.height / 2); x.rotate(deg * Math.PI / 180); x.drawImage(src, -w / 2, -h / 2);
  return c;
}
// fillable field boxes (fractions of the page) after turning the page by deg
function rotFields(f, deg){
  deg = ((deg % 360) + 360) % 360;
  if(!deg || !f) return f;
  return f.map(o => {
    const r = Object.assign({}, o), {x, y, w, h} = o;
    if(deg === 90){ r.x = 1 - y - h; r.y = x; r.w = h; r.h = w; }
    else if(deg === 180){ r.x = 1 - x - w; r.y = 1 - y - h; }
    else { r.x = y; r.y = 1 - x - w; r.w = h; r.h = w; }
    return r;
  });
}
function canvasBlob(c){ return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.86)); }
/* (1.46) "Print onto page" closes the dialog at once; pages are made one at a time and appear on the page as they
   are ready, so you can keep writing meanwhile. The whole import stays one undo step (undo while it runs stops it).
   If you leave the page, the rest still goes onto the page the import started on. */
const impJobs = new Set();
const impWait = ms => new Promise(r => setTimeout(r, ms));
// let a stroke, pinch or drag finish before the next (slow) page picture is made
async function impIdle(){ await impWait(30); for(let t = 0; t < 40 && (penDown || act || selDrag || gesture); t++) await impWait(120); }   // waits at most ~5 s
async function impPlace(job, item){
  if(cur && cur.id === job.pid){
    if(job.op && job.cur === cur && !cur.undo.includes(job.op)){ job.stopped = 'undo'; return false; }
    setItems([[item.id, item]]);
    if(job.op && job.cur === cur){ job.op.a.push([item.id, item]); job.op.b.push([item.id, null]); }
    else { job.cur = cur; commit([[item.id, null]], [[item.id, item]]); job.op = cur.undo[cur.undo.length - 1]; }
    return true;
  }
  if(!getDoc(job.pid)){ job.stopped = 'gone'; return false; }
  job.cur = job.op = null;
  const rec = await IDB.get('docs', 'c_' + job.pid);
  const ok = rec && !rec.deleted && rec.data;
  const data = ok ? rec.data : {bg: Object.assign({}, prefs.bg), items: []};
  const out = ok ? rec : {id: 'c_' + job.pid, kind: 'content', deleted: false};
  out.data = Object.assign({}, data, {items: [...(data.items || []), ser(item)]});
  await writeDoc(out);
  // the page was opened while this was written: show the picture there too
  if(cur && cur.id === job.pid && !cur.items.has(item.id)) setItems([[item.id, item]]);
  return true;
}
$('impGo').addEventListener('click', async () => {
  if(!imp || !cur) return;
  const size = +$('impSize').value / 100, src = imp, rot = impRot, side = rot % 180 !== 0;
  let pages = null, want = null;
  if(src.kind === 'pdf'){
    pages = parsePages($('impPages').value, src.n);
    if(!pages.length){ $('impStatus').textContent = 'No pages match that range.'; return; }
  } else if(src.kind === 'docx'){
    const r = ($('impPages').value || '').trim().toLowerCase();
    if(r && r !== 'all'){ want = new Set(parsePages(r, 300)); if(!want.size){ $('impStatus').textContent = 'No pages match that range.'; return; } }
  }
  // place below everything already on the page (and below imports still running there), then scroll there
  const cb = contentBox();
  const pageDoc = getDoc(cur.id), nameAfterPdf = (src.kind === 'pdf' || src.kind === 'docx') && !cb && !!src.name && !!pageDoc && !(pageDoc.data.title || '').trim() && !$('title').value.trim();
  const [vx, vy] = toWorld(W > 600 ? 48 : 16, 24);
  const x0 = cb ? cb[0] : vx;
  let y0 = cb ? cb[3] + 48 : vy;
  for(const j of impJobs) if(j.pid === cur.id) y0 = Math.max(y0, j.y + 24);
  imp = null;   // the job owns the file now; closing the dialog must not drop it
  hideModal('importDlg');
  setTool('pen');
  if(src.kind === 'img'){
    const wWorld = A4W * size, hWorld = wWorld * (side ? src.w / src.h : src.h / src.w);
    const scale = Math.min(1, 2400 / Math.max(src.w, src.h));
    let c = document.createElement('canvas');
    c.width = Math.round(src.w * scale); c.height = Math.round(src.h * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src.img, 0, 0, c.width, c.height);
    if(rot) c = rotCanvas(c, rot);
    const a = await saveAsset(await canvasBlob(c));
    if(!cur) return;
    addItems([{t: 'i', id: 'i' + newId(), x: x0, y: y0, w: wWorld, h: hWorld, a}]);
    cam.ox = (W > 600 ? 48 : 16) - x0 * cam.z; cam.oy = 24 - y0 * cam.z; invalidate(); saveCamSoon(); PT.soon();
    toast('Placed on the page');
    return;
  }
  if(nameAfterPdf){ $('title').value = src.name; await patchDoc(pageDoc, {title: src.name}); refreshPageItem(pageDoc.id); }
  cam.ox = (W > 600 ? 48 : 16) - x0 * cam.z; cam.oy = 24 - y0 * cam.z; invalidate(); saveCamSoon();
  const job = {pid: cur.id, y: y0 - 24, n: 0, fields: 0, stopped: null, cur: null, op: null};
  impJobs.add(job);
  const total = pages ? pages.length : want ? want.size : src.n;
  const about = !pages && !want && total > 1 ? 'about ' : '';
  const say = () => toast(`Placing page ${job.n + 1} of ${about}${Math.max(total, job.n + 1)}…`, 'Stop', () => { job.stopped = 'user'; });
  let err = null;
  try {
    if(src.kind === 'pdf'){
      for(let k = 0; k < pages.length && !job.stopped; k++){
        await impIdle(); if(job.stopped) break;
        say();
        const page = await src.pdf.getPage(pages[k]); const v1 = page.getViewport({scale: 1});
        const pf = await pdfFields(page), lines = await pdfLines(page); page.cleanup();
        const pw = side ? v1.height : v1.width, ph = side ? v1.width : v1.height;
        const wWorld = pw / 595.28 * A4W * size, hWorld = wWorld * ph / pw;
        const px = Math.round(clamp((v1.width / 595.28 * A4W * size) * 2.4, 900, 2000));
        const r = await renderPdfPage(src.pdf, pages[k], px, pf.f.length ? pf.blank : null);
        const pc = rot ? rotCanvas(r.canvas, rot) : r.canvas;
        const a = await saveAsset(await canvasBlob(pc));
        r.canvas.width = r.canvas.height = 1; pc.width = pc.height = 1;
        if(job.stopped) break;
        const item = {t: 'i', id: 'i' + newId(), x: x0, y: job.y + 24, w: wWorld, h: hWorld, a, doc: 1};
        // turned pages: the PDF's line positions no longer fit, so their text is read later like a scan
        if(!rot && hasRealText(lines)) await savePtxt(a, 'pdf', lines);   // searchable right away; scans are read by Claude later
        if(pf.f.length) item.f = rotFields(pf.f, rot);
        if(!await impPlace(job, item)) break;
        job.n++; job.fields += pf.f.length; job.y += 24 + hWorld;
      }
    } else {
      const last = want ? Math.max(...want) : Infinity;
      for(let i = 1; i <= last && !job.stopped; i++){
        let pg;
        if(i === 1) pg = src.first;
        else { await impIdle(); if(job.stopped) break; if(!want || want.has(i)) say(); pg = await src.d.next(); }
        if(!pg) break;
        if(want && !want.has(i)){ pg.canvas.width = pg.canvas.height = 1; continue; }
        const wWorld = A4W * size, hWorld = wWorld * (side ? pg.w / pg.h : pg.h / pg.w);
        const pc = rot ? rotCanvas(pg.canvas, rot) : pg.canvas;
        const a = await saveAsset(await canvasBlob(pc));
        pg.canvas.width = pg.canvas.height = 1; pc.width = pc.height = 1;
        if(job.stopped) break;
        if(!await impPlace(job, {t: 'i', id: 'i' + newId(), x: x0, y: job.y + 24, w: wWorld, h: hWorld, a, doc: 1})) break;
        job.n++; job.y += 24 + hWorld;
      }
    }
  } catch(e){ console.warn(e); err = e; }
  finally { impJobs.delete(job); if(src.close) src.close(); }
  if(job.n) PT.soon();
  const placed = job.n === 1 ? '1 page placed' : `${job.n} pages placed`;
  if(err) toast(`Import stopped: ${err.message || err}` + (job.n ? ` (${placed})` : ''));
  else if(job.stopped === 'undo') toast('Import stopped');
  else if(job.stopped === 'gone') toast('Import stopped: the page was deleted');
  else if(job.stopped === 'user') toast(`Import stopped · ${placed}`);
  else toast((job.n === 1 ? 'Placed on the page' : `Placed ${job.n} pages`) + (job.fields ? ` · ${job.fields} fillable field${job.fields === 1 ? '' : 's'}` : ''));
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
      out.push({box: fbox, h: `<div style="position:absolute;left:${fx}px;top:${fy}px;width:${fw}px;height:${fh}px;overflow:hidden;box-sizing:border-box;padding:0 ${fs * 0.15}px;font:${fs}px/1.15 Helvetica,Arial,sans-serif;color:${!mark && f.c ? f.c : '#111'};${!mark ? fieldCss(f) : ''}${lay}">${esc(txt)}</div>`});
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
  for(const pass of [2, 1, 0]) for(const it of cur.items.values()){
    if(it.t !== 's' || it.mk || inkPass(it) !== pass) continue;
    const q = itemBox(it);
    const fo = (pass === 1 ? 0.4 : 1) * opOf(it);
    // (1.62) highlights blend into the page (multiply), like on screen
    inks.push({a: q[1], b: q[3], hl: pass === 1, h: `<path d="${strokePath(it, true)}" fill="${inkColor(it.c, true)}"${fo < 1 ? ` fill-opacity="${+fo.toFixed(3)}"` : ''}/>`});
  }
  const tops = [];
  for(const it of cur.items.values()){
    if(it.t !== 'x' && it.t !== 'm') continue;
    const el = elMap.get(it.id); if(!el) continue;
    const c = el.cloneNode(true); c.removeAttribute('contenteditable'); c.style.transform = ''; c.style.zoom = '';
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
    const ik = J.hit(J.inks, k), hls = ik.filter(p => p.hl), rest = ik.filter(p => !p.hl);
    if(hls.length) body += `<svg style="position:absolute;left:0;top:0;overflow:visible;mix-blend-mode:multiply" width="1" height="1">${hls.map(p => p.h).join('')}</svg>`;
    body += `<svg style="position:absolute;left:0;top:0;overflow:visible" width="1" height="1">${rest.map(p => p.h).join('')}</svg>` + J.hit(J.tops, k).map(p => p.h).join('');
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
  el.style.left = '0px'; el.style.top = '0px'; el.style.transform = ''; el.style.zoom = '';
  box.appendChild(el); document.body.appendChild(box);
  try {
    const c = await html2canvas(box, {scale, backgroundColor: null, logging: false, useCORS: true});
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    c.width = c.height = 1;
    return new Uint8Array(await blob.arrayBuffer());
  } finally { box.remove(); }
}
// (1.66) how a page is cut into PDF pages: [{ya, yb, x0, cw, s, m, W, H}] (world top/bottom/left/width, scale,
// margin and page size in A4 units). A page made of imported document pages (PDF, Word, one under the other) gets one
// PDF page per imported page, so the numbers match the original (page 94 stays page 94); notes further down follow
// on A4 sheets. Anything else is cut into A4 sheets as before.
function pdfSheets(items, b){
  const margin = 40, pw = A4W - 2 * margin, ph = A4H - 2 * margin;
  const x0 = b[0] - 12, cw = b[2] - b[0] + 24, top = b[1] - 12, bottom = b[3] + 12;
  const out = [];
  const a4 = (ya, yb) => {
    const s = Math.min(1, pw / cw), slice = ph / s, n = Math.max(1, Math.ceil((yb - ya) / slice - 1e-6));
    for(let i = 0; i < n; i++) out.push({ya: ya + i * slice, yb: ya + (i + 1) * slice, x0, cw, s, m: margin, W: A4W, H: A4H});
  };
  const docs = items.filter(it => it.t === 'i' && it.doc && it.h > 0).sort((p, q) => p.y - q.y);
  const stacked = docs.length > 0 && docs.every((d, i) => !i || d.y >= docs[i - 1].y + docs[i - 1].h - 2);
  if(!stacked){ a4(top, bottom); return out; }
  // pages are cut at the edges of the imported pages; a gap between two of them is shared out only if something
  // was written into it. Writing beside a page makes that PDF page wider (and its content smaller).
  const boxes = items.filter(it => !(it.t === 'i' && it.doc)).map(it => itemBox(it));
  const used = (y0, y1) => boxes.some(q => q[3] > y0 + 1 && q[1] < y1 - 1);
  docs.forEach((d, i) => {
    const pv = docs[i - 1], nx = docs[i + 1];
    const ya = !pv ? Math.min(b[1], d.y) : used(pv.y + pv.h, d.y) ? (pv.y + pv.h + d.y) / 2 : d.y;
    const yb = !nx ? d.y + d.h : used(d.y + d.h, nx.y) ? (d.y + d.h + nx.y) / 2 : d.y + d.h;
    let px0 = d.x, px1 = d.x + d.w;
    for(const q of boxes) if(q[3] > ya && q[1] < yb){ px0 = Math.min(px0, q[0]); px1 = Math.max(px1, q[2]); }
    const s = A4W / (px1 - px0);
    out.push({ya, yb, x0: px0, cw: px1 - px0, s, m: 0, W: A4W, H: (yb - ya) * s, doc: true});
  });
  const end = out[out.length - 1].yb;
  if(b[3] > end + 1) a4(end, bottom);
  return out;
}
// "3", "2-5, 8" -> [1, 2, 3, 4, 7] (0-based, sorted), or null if it is not a list of pages 1..n
// (stricter than parsePages for imports: a page that does not exist is an error, not left out)
function exportPagesList(t, n){
  const set = new Set(), parts = String(t || '').replace(/\s*[-–]\s*/g, '-').split(/[\s,;]+/).filter(Boolean);
  for(const part of parts){
    const m = /^(\d+)(?:-(\d+))?$/.exec(part); if(!m) return null;
    let a = +m[1], z = m[2] ? +m[2] : a; if(a > z) [a, z] = [z, a];
    if(a < 1 || z > n) return null;
    for(let i = a; i <= z; i++) set.add(i - 1);
  }
  return set.size ? [...set].sort((a, b) => a - b) : null;
}
// [0, 1, 2, 5] -> "1–3, 6"
function pagesLabel(list){
  const out = [];
  for(let i = 0; i < list.length; i++){
    let j = i; while(j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(j > i ? `${list[i] + 1}–${list[j] + 1}` : String(list[i] + 1)); i = j;
  }
  return out.join(', ');
}
const Pdf = {abort: false, file: null, run: 0, page: null, n: 0, only: null};
async function exportPdfFile(){
  if(!cur) return;
  finishEditing();
  if(!contentBox()){ toast('This page is empty'); return; }
  Pdf.page = cur; Pdf.only = null; Pdf.n = 0;
  $('exportTitle').textContent = 'Export as PDF'; $('exportParts').innerHTML = ''; $('exportActs').hidden = false;
  $('exportPick').hidden = true; $('exportPages').value = ''; $('exportPages').hidden = true;
  $('exportPick').querySelectorAll('[data-pick]').forEach(x => x.classList.toggle('on', x.dataset.pick === 'all'));
  showModal('exportDlg');
  await makePdf();
}
// builds the PDF of Pdf.page: all pages, or only Pdf.only (0-based page numbers). A newer call stops an older one.
async function makePdf(){
  const run = ++Pdf.run, page0 = Pdf.page;
  Pdf.abort = false; Pdf.file = null;
  const stop = () => Pdf.abort || run !== Pdf.run;
  $('exportSave').disabled = true; $('exportInfo').textContent = 'Making the PDF…';
  const say = t => { if(run === Pdf.run) $('exportInfo').textContent = t; };
  const tick = () => new Promise(r => setTimeout(r, 0));
  const b = page0 === cur ? contentBox() : null;
  if(!b){ say('This page is empty'); return; }
  const title = ($('title').value || 'Inkwell page').trim();
  try {
    await pdfLibs();
    if(stop()) return;
    const {PDFDocument, LineCapStyle, pushGraphicsState, popGraphicsState, rectangle, clip, endPath} = PDFLib;
    const items = [...page0.items.values()];
    const all = pdfSheets(items, b);
    Pdf.n = all.length;
    $('exportPick').hidden = all.length < 2;
    const pick = Pdf.only ? Pdf.only.filter(i => i < all.length) : null;
    const sheets = pick && pick.length ? pick.map(i => all[i]) : all;
    const PW = 595.28, k = PW / A4W;
    const doc = await PDFDocument.create();
    doc.setTitle(title); doc.setCreator('Inkwell'); doc.setProducer('Inkwell');
    const box = it => itemBox(it);
    const reachAny = q => sheets.some(sh => q[3] >= sh.ya - 4 && q[1] <= sh.yb + 4);
    const sMax = Math.max(...sheets.map(sh => sh.s));
    // text boxes and formulas: rendered once each, placed on every sheet they reach
    const tops = [];
    const texts = items.filter(it => (it.t === 'x' || it.t === 'm') && elMap.get(it.id) && reachAny(box(it)));
    for(let i = 0; i < texts.length; i++){
      if(stop()) return;
      if(i % 4 === 0){ say(`Preparing text ${i + 1} of ${texts.length}…`); await tick(); }
      const it = texts[i], el = elMap.get(it.id), w = el.offsetWidth, h = el.offsetHeight;
      if(!w || !h) continue;
      const c = el.cloneNode(true); c.removeAttribute('contenteditable'); c.style.opacity = ''; c.style.transform = ''; c.style.zoom = '';
      if(it.t === 'm') c.style.color = it.c && it.c !== 'auto' ? inkColor(it.c, true) : '#18212B';
      const sc = Math.max(1, Math.min(sMax * 2.5, Math.sqrt(12e6 / (w * h))));
      const png = await doc.embedPng(await renderPng(c, w, h, sc));
      tops.push({it, png, x: it.x, y: it.y, w: w + 2, h: h + 2, b: [it.x, it.y, it.x + w, it.y + h]});
    }
    // form values on imported pages: one transparent overlay per page picture
    const overlays = new Map();
    for(const it of items.filter(i => i.t === 'i' && i.f && i.f.length && reachAny(box(i)))){
      if(stop()) return;
      const html = fieldParts(it, 0, 0).map(p => p.h).join(''); if(!html) continue;
      const d = document.createElement('div'); d.style.cssText = `position:absolute;width:${it.w}px;height:${it.h}px`; d.innerHTML = html;
      const sc = Math.max(1, Math.min(sMax * 2.5, Math.sqrt(12e6 / (it.w * it.h))));
      overlays.set(it.id, await doc.embedPng(await renderPng(d, it.w, it.h, sc)));
    }
    const pics = items.filter(it => it.t === 'i' && it.a), embedded = new Map();
    const inks = [2, 1, 0].flatMap(pass => items.filter(it => it.t === 's' && !it.mk && inkPass(it) === pass));
    const inkBoxes = new Map(inks.map(it => [it.id, box(it)]));
    for(let si = 0; si < sheets.length; si++){
      if(stop()) return;
      say(`Making page ${si + 1} of ${sheets.length}…`); await tick();
      const sh = sheets[si], {ya, yb, s, m} = sh, PH = sh.H * k;
      const X = wx => (m + (wx - sh.x0) * s) * k;
      const Y = wy => PH - (m + (wy - ya) * s) * k;
      const reach = (top, bottom) => bottom >= ya - 4 && top <= yb + 4;
      const page = doc.addPage([PW, PH]);
      page.pushOperators(pushGraphicsState(), rectangle(m * k, PH - (m + (yb - ya) * s) * k, (sh.W - 2 * m) * k, (yb - ya) * s * k), clip(), endPath());
      const at = {x: X(0), y: Y(0), scale: s * k};
      const d = paperPath(page0.bg, ya, yb, sh.x0, sh.x0 + sh.cw);
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
        page.drawSvgPath(strokePath(it, true), {...at, color: hexRgb(inkColor(it.c, true)), opacity: (it.hl ? 0.4 : 1) * opOf(it), ...(it.hl && PDFLib.BlendMode ? {blendMode: PDFLib.BlendMode.Multiply} : {})});
      }
      for(const t of tops){
        if(!reach(t.b[1], t.b[3])) continue;
        page.drawImage(t.png, {x: X(t.x), y: Y(t.y + t.h), width: t.w * s * k, height: t.h * s * k, opacity: opOf(t.it)});
      }
      page.pushOperators(popGraphicsState());
    }
    say('Saving…'); await tick();
    const bytes = await doc.save();
    if(stop()) return;
    const part = pick && pick.length ? (pick.length === 1 ? ` (page ${pick[0] + 1})` : ` (pages ${pagesLabel(pick).replace(/–/g, '-')})`) : '';
    const name = ((title + part).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Inkwell page') + '.pdf';
    Pdf.file = new File([bytes], name, {type: 'application/pdf'});
    const mb = bytes.length / 1048576, size = `${mb < 0.1 ? '< 0.1' : mb.toFixed(1)} MB`;
    say(pick && pick.length ? `Ready: page${pick.length === 1 ? '' : 's'} ${pagesLabel(pick)} of ${all.length}, ${size}.`
      : `Ready: ${all.length} page${all.length === 1 ? '' : 's'}${all.some(sh => sh.doc) ? ' (the imported pages keep their numbers)' : ''}, ${size}.`);
    $('exportSave').disabled = false;
  } catch(e){
    console.warn('pdf export', e);
    say('The PDF could not be made: ' + (e.message || e) + '. Try Print instead.');
  }
}
// (1.66) "All pages" or "Only pages: 3, 5-7": the PDF is made again with just those
$('exportPick').addEventListener('click', e => {
  const b = e.target.closest('[data-pick]'); if(!b) return;
  $('exportPick').querySelectorAll('[data-pick]').forEach(x => x.classList.toggle('on', x === b));
  const some = b.dataset.pick === 'some';
  $('exportPages').hidden = !some;
  if(some){ $('exportPages').focus(); if($('exportPages').value.trim()) pagesTyped(); else { Pdf.run++; Pdf.file = null; $('exportSave').disabled = true; $('exportInfo').textContent = `Type the pages you want, from 1 to ${Pdf.n}: e.g. 3 or 2-5, 8`; } }
  else if(Pdf.only){ Pdf.only = null; makePdf(); }
});
let pagesTimer = 0;
function pagesTyped(){
  clearTimeout(pagesTimer);
  const list = exportPagesList($('exportPages').value, Pdf.n);
  Pdf.run++; Pdf.file = null; $('exportSave').disabled = true;
  if(!list){ $('exportInfo').textContent = `Type the pages you want, from 1 to ${Pdf.n}: e.g. 3 or 2-5, 8`; return; }
  $('exportInfo').textContent = 'Making the PDF…';
  pagesTimer = setTimeout(() => { Pdf.only = list; makePdf(); }, 600);
}
$('exportPages').addEventListener('input', pagesTyped);
$('exportPages').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); $('exportPages').blur(); } });
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
