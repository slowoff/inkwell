/* Inkwell core: Merging a doc edited on two devices: stable JSON, field-by-field and item-by-item three-way merge.
   Plain script (no build step): in the app it defines window.InkMerge (loaded before app.js);
   in Node (tests/unit) it is a CommonJS module. Moved unchanged out of app.js in 1.61.3. */
(function(root, make){
  const api = make(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.InkMerge = api;
})(typeof self !== 'undefined' ? self : this, function(root){
'use strict';
  const {newId} = typeof module === 'object' && module.exports ? require('./util.js') : root.InkUtil;

function stable(v){
  if(Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if(v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return v === undefined ? 'null' : JSON.stringify(v);
}
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
function mergeContent(b, l, r, lNew, keep){
  const map = d => new Map(((d && d.items) || []).filter(it => it && it.id).map(it => [it.id, it]));
  const bi = map(b), li = map(l), ri = map(r);
  const pick = new Map(), extra = [];
  let copies = 0;
  for(const id of new Set([...li.keys(), ...ri.keys()])){
    const B = bi.get(id), L = li.get(id), R = ri.get(id);
    const kb = B ? stable(B) : null, kl = L ? stable(L) : null, kr = R ? stable(R) : null;
    let v;
    if(kl === kr) v = L;
    else if(kl === kb) v = !R && keep && keep(id) ? L : R;   // changed (or deleted) only on the other device
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

return {stable, mergeKeys, mergeContent};
});
