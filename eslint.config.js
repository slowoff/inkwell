// Lint settings (1.61.3, app/ files since 1.62.1). Run by tests/run.sh and the Tests workflow; it only reads the
// code, never changes it. Only real mistakes are errors and fail the tests (a name that does not exist, a name
// declared twice); unused code is a warning (shown, not failing); style is not checked.
// The app/ files share one global scope (loaded in order by index.html), so every top-level name of one app file is
// known in the others: they are collected here.
const fs = require('fs');
const path = require('path');
const globals = require('globals');
const espree = require('espree');
const LIBS = {pdfjsLib: 'readonly', katex: 'readonly', supabase: 'readonly', PDFLib: 'readonly', JSZip: 'readonly', docx: 'readonly', html2canvas: 'readonly',
  InkUtil: 'readonly', InkGeo: 'readonly', InkMerge: 'readonly', InkText: 'readonly'};
const APP = {};
for(const f of fs.readdirSync(path.join(__dirname, 'app')).filter(f => f.endsWith('.js'))){
  const ast = espree.parse(fs.readFileSync(path.join(__dirname, 'app', f), 'utf8'), {ecmaVersion: 2023, sourceType: 'script'});
  for(const st of ast.body){
    if(st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') APP[st.id.name] = 'readonly';
    else if(st.type === 'VariableDeclaration'){
      const add = n => { if(!n) return; if(n.type === 'Identifier') APP[n.name] = st.kind === 'const' ? 'readonly' : 'writable';
        else if(n.type === 'ObjectPattern') n.properties.forEach(p => add(p.value || p.argument)); else if(n.type === 'ArrayPattern') n.elements.forEach(add);
        else if(n.type === 'AssignmentPattern') add(n.left); else if(n.type === 'RestElement') add(n.argument); };
      st.declarations.forEach(d => add(d.id));
    }
  }
}
const base = {ecmaVersion: 2023, sourceType: 'script'};
const rules = {
  'no-undef': 'error',
  'no-redeclare': ['error', {builtinGlobals: false}],
  'no-dupe-keys': 'error',
  'no-unreachable': 'warn',
  'no-unused-vars': ['warn', {args: 'none', caughtErrors: 'none', vars: 'local'}]
};
module.exports = [
  {ignores: ['lib/**', 'tests/**', 'supabase/**', 'node_modules/**']},
  {files: ['app/*.js'], languageOptions: {...base, globals: {...globals.browser, ...LIBS, ...APP}}, rules},
  {files: ['app.js', 'core/*.js', 'sw.js', 'config.js'], languageOptions: {...base, globals: {...globals.browser, ...globals.serviceworker, ...LIBS, module: 'readonly', require: 'readonly'}}, rules}
];
