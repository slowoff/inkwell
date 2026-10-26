/* Inkwell spell check worker (1.66). Runs Hunspell (hunspell.js, WebAssembly) off the main thread so typing never waits.
   Messages in:  {id, op: 'check', lang, words: [..]}  -> {id, bad: [..]}   (words that are not spelled right)
                 {id, op: 'suggest', lang, word}      -> {id, list: [..]}
                 {id, op: 'load', lang}               -> {id}  load a language ahead of time
   A language that cannot be loaded (offline before it was ever downloaded) answers {id, error}. */
'use strict';
importScripts('hunspell.js');
const LANGS = ['de-CH', 'de-DE', 'en-GB', 'en-US', 'pt-PT', 'pt-BR'];
let factory = null;
const loaded = new Map(), order = [];   // lang -> Promise<Hunspell>; at most 3 kept in memory
async function bytes(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(url + ': ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
function get(lang){
  if(!LANGS.includes(lang)) lang = 'en-GB';
  if(loaded.has(lang)){ order.splice(order.indexOf(lang), 1); order.push(lang); return loaded.get(lang); }
  const p = (async () => {
    if(!factory) factory = await self.HunspellAsm.loadModule();
    const [aff, dic] = await Promise.all([bytes('dict/' + lang + '.aff'), bytes('dict/' + lang + '.dic')]);
    const n = lang + '-' + Date.now(), a = factory.mountBuffer(aff, n + '.aff'), d = factory.mountBuffer(dic, n + '.dic');
    const h = factory.create(a, d);
    factory.unmount(a); factory.unmount(d);   // Hunspell has read them; the copies would only take memory
    return h;
  })();
  p.catch(() => { loaded.delete(lang); const i = order.indexOf(lang); if(i >= 0) order.splice(i, 1); });
  loaded.set(lang, p); order.push(lang);
  while(order.length > 3){ const old = order.shift(), q = loaded.get(old); loaded.delete(old); q.then(h => h.dispose()).catch(() => {}); }
  return p;
}
self.onmessage = async e => {
  const m = e.data || {};
  try {
    const h = await get(m.lang);
    if(m.op === 'check') self.postMessage({id: m.id, bad: (m.words || []).filter(w => !h.spell(w))});
    else if(m.op === 'suggest') self.postMessage({id: m.id, list: h.suggest(m.word).slice(0, 6)});
    else self.postMessage({id: m.id});
  } catch(err){
    self.postMessage({id: m.id, error: String(err && err.message || err)});
  }
};
