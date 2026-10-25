// (1.62.1) The app is split into app/NN-*.js classic scripts sharing one global scope. Checks:
// - code that runs while a file loads uses nothing from a later file (it would not exist yet)
// - no top-level name is declared in two files (the second file would fail to load)
// - index.html loads core/ then app/ files in file-name order, and sw.js keeps all of them for offline use
// Needs the acorn parser (installed by the Tests workflow; locally: npm i --no-save acorn acorn-walk).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
let acorn = null;
try { acorn = require('acorn'); require('acorn-walk'); } catch {}
const appFiles = fs.readdirSync(path.join(root, 'app')).filter(f => f.endsWith('.js')).sort();
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('index.html loads core/ and app/ files in order, sw.js keeps them offline', () => {
  const html = read('index.html');
  const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  const core = ['core/util.js', 'core/ink.js', 'core/merge.js', 'core/text.js'];
  const want = [...core, ...appFiles.map(f => 'app/' + f)];
  const got = srcs.filter(s => s.startsWith('core/') || s.startsWith('app/'));
  assert.deepEqual(got, want);
  assert.ok(srcs.indexOf('config.js') < srcs.indexOf(want[0]), 'config.js first');
  assert.ok(!srcs.includes('app.js'), 'no app.js any more');
  const sw = read('sw.js');
  for(const f of want) assert.ok(sw.includes(`'./${f}'`), `sw.js keeps ${f}`);
  assert.ok(!sw.includes("'./app.js'"));
});

test('every app file starts strict and none is empty', () => {
  for(const f of appFiles){
    const s = read('app/' + f);
    assert.match(s, /^\/\*[\s\S]*?\*\/\n'use strict';\n/, f);
    assert.ok(s.length > 1000, f);
  }
});

test('no top-level name is declared in two app files', {skip: !acorn && 'acorn not installed'}, () => {
  const seen = new Map();
  for(const f of appFiles){
    const ast = acorn.parse(read('app/' + f), {ecmaVersion: 2023, sourceType: 'script'});
    for(const st of ast.body){
      const names = st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration' ? [st.id.name]
        : st.type === 'VariableDeclaration' ? st.declarations.flatMap(d => d.id.type === 'Identifier' ? [d.id.name] : []) : [];
      for(const n of names){ assert.ok(!seen.has(n), `${n} in ${seen.get(n)} and ${f}`); seen.set(n, f); }
    }
  }
  assert.ok(seen.size > 500);
});

test('code that runs while a file loads only uses earlier files', {skip: !acorn && 'acorn not installed'}, () => {
  const {check} = require('./loadorder.js');
  const files = appFiles.map(f => ({name: 'app/' + f, src: read('app/' + f)}));
  const p = check(files);
  assert.deepEqual(p.map(x => `${x.file}:${x.line} ${x.name} (from ${x.declaredIn})`), []);
  // the check itself works: a planted call into a later file is found
  files[0] = {...files[0], src: files[0].src + '\nrenderNav();\n'};
  assert.ok(check(files).some(x => x.name === 'renderNav'));
});
