// Load-order check for app code split into several classic scripts that share one global scope.
// Inside one big function every function declaration was visible from the start ("hoisting"); after a split a
// function only exists once its file has loaded. So: code that runs while a file loads (not later from an event,
// a timer or boot()) must not use anything declared in a later file.
// Follows immediate code: top-level statements (not function declarations), callbacks that run at once
// (forEach/map/…, new Promise, IIFEs), and the bodies of top-level functions and object methods it calls.
// usage (module): check([{name, src}, ...]) -> [{file, line, name, declaredIn}]
const acorn = require('acorn');
const walk = require('acorn-walk');
const SYNC_CB = new Set(['forEach', 'map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'sort', 'replace', 'replaceAll', 'from']);
function check(files){
  const decl = new Map();   // name -> {file, kind, node}
  const parsed = files.map((f, fi) => {
    const ast = acorn.parse(f.src, {ecmaVersion: 2023, sourceType: 'script', locations: true});
    for(const st of ast.body){
      if(st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') decl.set(st.id.name, {file: fi, kind: st.type, node: st});
      else if(st.type === 'VariableDeclaration') for(const d of st.declarations){
        const names = []; walk.full(d.id, n => { if(n.type === 'Identifier') names.push(n.name); });
        if(d.id.type === 'Identifier') names.splice(0, names.length, d.id.name);
        for(const nm of names) decl.set(nm, {file: fi, kind: st.kind, node: d});
      }
    }
    return ast;
  });
  const problems = [], seenFn = new Set();
  // walk an immediately executed node; fi = file whose load is running
  function run(node, fi, scopeObj){
    const visit = (n, parent) => {
      if(!n || typeof n.type !== 'string') return;
      if(n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'){
        // runs now only if called right away or handed to a synchronous callback / new Promise
        const p = parent;
        const now = p && ((p.type === 'CallExpression' && p.callee === n) ||
          (p.type === 'CallExpression' && p.arguments.includes(n) && p.callee.type === 'MemberExpression' && !p.callee.computed && SYNC_CB.has(p.callee.property.name)) ||
          (p.type === 'NewExpression' && p.callee.type === 'Identifier' && p.callee.name === 'Promise'));
        if(now) visit(n.body, n);
        return;
      }
      if(n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') return;   // nested declarations: only when called
      if(n.type === 'Property' || n.type === 'MethodDefinition'){
        // object literal values that are functions are not run; other values are
        if(n.computed) visit(n.key, n);
        const v = n.value;
        if(v && (v.type === 'FunctionExpression' || v.type === 'ArrowFunctionExpression')) return;
        visit(v, n); return;
      }
      if(n.type === 'Identifier'){
        const p = parent;
        if(p && p.type === 'MemberExpression' && p.property === n && !p.computed) return;
        const d = decl.get(n.name);
        if(d && d.file > fi) problems.push({file: files[fi].name, line: n.loc.start.line, name: n.name, declaredIn: files[d.file].name});
        // a function called now: its body runs now too
        if(d && d.kind === 'FunctionDeclaration' && p && p.type === 'CallExpression' && p.callee === n && !seenFn.has(n.name + '@' + fi)){
          seenFn.add(n.name + '@' + fi); visit(d.node.body, d.node);
        }
        return;
      }
      if(n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed){
        // Obj.method() / this.method() on a top-level object literal: that method's body runs now
        const o = n.callee.object, m = n.callee.property.name;
        const objName = o.type === 'Identifier' ? o.name : o.type === 'ThisExpression' ? scopeObj : null;
        const d = objName && decl.get(objName);
        if(d && d.node.init && d.node.init.type === 'ObjectExpression'){
          const prop = d.node.init.properties.find(q => q.key && (q.key.name === m || q.key.value === m));
          if(prop && prop.value && /Function/.test(prop.value.type) && !seenFn.has(objName + '.' + m + '@' + fi)){
            seenFn.add(objName + '.' + m + '@' + fi);
            const save = scopeObj; scopeObj = objName; visit(prop.value.body, prop.value); scopeObj = save;
          }
        }
      }
      for(const k of Object.keys(n)){
        if(k === 'loc' || k === 'start' || k === 'end') continue;
        const c = n[k];
        if(Array.isArray(c)) c.forEach(x => x && typeof x.type === 'string' && visit(x, n));
        else if(c && typeof c.type === 'string') visit(c, n);
      }
    };
    visit(node, null);
  }
  parsed.forEach((ast, fi) => {
    for(const st of ast.body){
      if(st.type === 'FunctionDeclaration') continue;
      if(st.type === 'VariableDeclaration'){ for(const d of st.declarations) if(d.init) run(d.init, fi, d.id.name); continue; }
      run(st, fi, null);
    }
  });
  // unique
  const key = p => p.file + ':' + p.line + ':' + p.name;
  return [...new Map(problems.map(p => [key(p), p])).values()];
}
module.exports = {check};
