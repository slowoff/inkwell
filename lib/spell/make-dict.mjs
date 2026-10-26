// Copies the Hunspell dictionaries into lib/spell/dict. de-CH: the npm package (wooorm/dictionaries 3.0.0) still has
// ß in its word list; Swiss spelling has none, so ß becomes ss (and duplicate lines are dropped).
import fs from 'fs';
const out = process.argv[2];
const L = {'de-CH': 'de-ch', 'de-DE': 'de', 'en-GB': 'en-gb', 'en-US': 'en', 'pt-PT': 'pt-pt', 'pt-BR': 'pt'};
fs.mkdirSync(out, {recursive: true});
for(const [code, pkg] of Object.entries(L)){
  const dir = `node_modules/dictionary-${pkg}/`;
  let aff = fs.readFileSync(dir + 'index.aff', 'utf8'), dic = fs.readFileSync(dir + 'index.dic', 'utf8');
  if(code === 'de-CH'){
    aff = aff.replace(/ß/g, 'ss');
    const lines = dic.split('\n'), head = lines.shift(), seen = new Set(), keep = [];
    for(const l of lines){ const v = l.replace(/ß/g, 'ss'); if(v && !seen.has(v)){ seen.add(v); keep.push(v); } }
    dic = keep.length + '\n' + keep.join('\n') + '\n';
  }
  fs.writeFileSync(`${out}/${code}.aff`, aff); fs.writeFileSync(`${out}/${code}.dic`, dic);
  fs.copyFileSync(dir + 'license', `${out}/${code}.license.txt`);
  console.log(code, (aff.length / 1024).toFixed(0) + 'K', (dic.length / 1024).toFixed(0) + 'K', JSON.parse(fs.readFileSync(dir + 'package.json')).license);
}
