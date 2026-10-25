/* Inkwell core: Reading typed maths: calculator expressions, graph formulas, LaTeX to plain text.
   Plain script (no build step): in the app it defines window.InkText (loaded before app.js);
   in Node (tests/unit) it is a CommonJS module. Moved unchanged out of app.js in 1.61.3. */
(function(root, make){
  const api = make(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.InkText = api;
})(typeof self !== 'undefined' ? self : this, function(root){
'use strict';

// Small safe formula parser for y = f(x): numbers, x (or t), + - * / ^, brackets, implicit multiplication,
// sin cos tan asin acos atan sqrt abs exp ln log, pi, e
function parseFn(src){
  const s = String(src || '').replace(/^\s*[yf]\s*(\(\s*[xt]\s*\))?\s*=/i, '').replace(/·|×/g, '*').replace(/−/g, '-').replace(/,/g, '.').trim();
  if(!s) return null;
  const toks = []; let i = 0;
  while(i < s.length){
    const c = s[i];
    if(/\s/.test(c)){ i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if(num && !(num[2] && /^e[a-z]/i.test(s.slice(i + num[1].length)))){ toks.push({t: 'n', v: parseFloat(num[0])}); i += num[0].length; continue; }
    const id = /^[a-z]+/i.exec(s.slice(i));
    if(id){ toks.push({t: 'i', v: id[0].toLowerCase()}); i += id[0].length; continue; }
    if('+-*/^()'.includes(c)){ toks.push({t: c}); i++; continue; }
    throw new Error('Unknown sign "' + c + '"');
  }
  const F = {sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10};
  let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const startsPrimary = t => t && (t.t === 'n' || t.t === 'i' || t.t === '(');
  function expr(){ let a = term(); while(peek() && (peek().t === '+' || peek().t === '-')){ const op = next().t, l = a, r = term(); a = op === '+' ? x => l(x) + r(x) : x => l(x) - r(x); } return a; }
  function term(){
    let a = unary();
    for(;;){
      const t = peek();
      if(t && (t.t === '*' || t.t === '/')){ next(); const l = a, r = unary(); a = t.t === '*' ? x => l(x) * r(x) : x => l(x) / r(x); }
      else if(startsPrimary(t)){ const l = a, r = power(); a = x => l(x) * r(x); }
      else return a;
    }
  }
  function unary(){ const t = peek(); if(t && (t.t === '-' || t.t === '+')){ next(); const a = unary(); return t.t === '-' ? x => -a(x) : a; } return power(); }
  function power(){ const b = primary(); if(peek() && peek().t === '^'){ next(); const e = unary(); return x => Math.pow(b(x), e(x)); } return b; }
  function primary(){
    const t = next();
    if(!t) throw new Error('The formula ends too early');
    if(t.t === 'n'){ const v = t.v; return () => v; }
    if(t.t === '('){ const a = expr(); if(!peek() || next().t !== ')') throw new Error('A bracket is not closed'); return a; }
    if(t.t === 'i'){
      if(t.v === 'x' || t.v === 't') return x => x;
      if(t.v === 'pi') return () => Math.PI;
      if(t.v === 'e') return () => Math.E;
      if(F[t.v]){
        const f = F[t.v];
        if(peek() && peek().t === '('){ next(); const a = expr(); if(!peek() || next().t !== ')') throw new Error('A bracket is not closed'); return x => f(a(x)); }
        const a = power(); return x => f(a(x));
      }
      throw new Error('Unknown name "' + t.v + '"');
    }
    throw new Error('Unexpected "' + t.t + '"');
  }
  const f = expr();
  if(p < toks.length) throw new Error('Unexpected "' + (toks[p].v ?? toks[p].t) + '"');
  return f;
}
const GREEK = {alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', omega: 'ω', eta: 'η', Delta: 'Δ', Omega: 'Ω', Sigma: 'Σ', Phi: 'Φ', Gamma: 'Γ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π'};
const SUP = {'0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '+': '⁺', 'n': 'ⁿ'};
const SUB = {'0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉'};
// Inline maths as readable plain text for a text box (the text box cannot show LaTeX).
function texPlain(t){
  let s = String(t);
  for(let i = 0; i < 6; i++){
    const before = s;
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => (/^[\w.]+$/.test(a) ? a : '(' + a + ')') + '/' + (/^[\w.]+$/.test(b) ? b : '(' + b + ')'))
         .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, a) => '√' + (/^[\w.]+$/.test(a) ? a : '(' + a + ')'))
         .replace(/\\(?:text|mathrm|mathbf|operatorname|mathit)\s*\{([^{}]*)\}/g, '$1');
    if(s === before) break;
  }
  s = s.replace(/\^\{?\\circ\}?/g, '°').replace(/\\degree/g, '°')
       .replace(/\^\{([0-9+\-n]+)\}|\^([0-9+\-n])/g, (_, a, b) => [...(a || b)].map(ch => SUP[ch] || ch).join(''))
       .replace(/_\{([0-9]+)\}|_([0-9])/g, (_, a, b) => [...(a || b)].map(ch => SUB[ch] || ch).join(''))
       .replace(/\\(cdot)/g, '·').replace(/\\times/g, '×').replace(/\\div/g, '÷').replace(/\\pm/g, '±').replace(/\\approx/g, '≈')
       .replace(/\\neq?/g, '≠').replace(/\\le(q)?/g, '≤').replace(/\\ge(q)?/g, '≥').replace(/\\infty/g, '∞').replace(/\\(?:right|Right)arrow|\\to/g, '→')
       .replace(/\\Rightarrow/g, '⇒').replace(/\\left|\\right/g, '').replace(/\\[,;:!]|\\quad|\\qquad|~/g, ' ')
       .replace(/\\([A-Za-z]+)/g, (m, w) => GREEK[w] || w).replace(/[{}]/g, '').replace(/\s{2,}/g, ' ');
  return s.trim();
}
// Safe evaluator: + − × ÷ ^ ( ) % ! E, implicit multiplication, functions, π, e, Ans; missing ")" are added.
function calcEval(src, ans, deg){
  const s = String(src).replace(/×10\^/g, 'E');
  const toks = []; let i = 0;
  while(i < s.length){
    const c = s[i];
    if(/\s/.test(c)){ i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if(num){ toks.push({t: 'n', v: parseFloat(num[0])}); i += num[0].length; continue; }
    const id = /^(asin|acos|atan|sin|cos|tan|sqrt|cbrt|ln|log|exp|abs|pi|Ans|e)/.exec(s.slice(i));
    if(id){ toks.push({t: 'i', v: id[0]}); i += id[0].length; continue; }
    if('+-*/^()%!E'.includes(c)){ toks.push({t: c}); i++; continue; }
    throw new Error('Unknown sign ' + c);
  }
  const open = toks.filter(t => t.t === '(').length - toks.filter(t => t.t === ')').length;
  for(let k = 0; k < open; k++) toks.push({t: ')'});
  const D = deg ? Math.PI / 180 : 1;
  const F = {sin: x => Math.sin(x * D), cos: x => Math.cos(x * D), tan: x => { const r = Math.tan(x * D); return deg && Math.abs(((x % 180) + 180) % 180 - 90) < 1e-12 ? NaN : r; },
    asin: x => Math.asin(x) / D, acos: x => Math.acos(x) / D, atan: x => Math.atan(x) / D,
    sqrt: Math.sqrt, cbrt: Math.cbrt, ln: Math.log, log: Math.log10, exp: Math.exp, abs: Math.abs};
  let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const starts = t => t && (t.t === 'n' || t.t === 'i' || t.t === '(');
  const fact = n => { if(n < 0 || n !== Math.floor(n) || n > 170) return NaN; let r = 1; for(let k = 2; k <= n; k++) r *= k; return r; };
  function expr(){ let a = term(); while(peek() && (peek().t === '+' || peek().t === '-')){ const op = next().t, b = term(); a = op === '+' ? a + b : a - b; } return a; }
  function term(){
    let a = unary();
    for(;;){
      const t = peek();
      if(t && (t.t === '*' || t.t === '/')){ next(); const b = unary(); a = t.t === '*' ? a * b : a / b; }
      else if(starts(t)){ a *= power(); }
      else return a;
    }
  }
  function unary(){ const t = peek(); if(t && (t.t === '-' || t.t === '+')){ next(); const a = unary(); return t.t === '-' ? -a : a; } return power(); }
  function power(){ const b = postfix(); if(peek() && peek().t === '^'){ next(); return Math.pow(b, unary()); } return b; }
  function postfix(){
    let a = primary();
    for(;;){
      const t = peek();
      if(t && t.t === '%'){ next(); a /= 100; }
      else if(t && t.t === '!'){ next(); a = fact(a); }
      else if(t && t.t === 'E'){ next(); a *= Math.pow(10, unary()); }
      else return a;
    }
  }
  function primary(){
    const t = next();
    if(!t) throw new Error('Incomplete');
    if(t.t === 'n') return t.v;
    if(t.t === '('){ const a = expr(); if(!peek() || peek().t !== ')') throw new Error('Missing )'); next(); return a; }
    if(t.t === 'i'){
      if(t.v === 'pi') return Math.PI;
      if(t.v === 'e') return Math.E;
      if(t.v === 'Ans') return ans;
      const f = F[t.v];
      if(peek() && peek().t === '('){ next(); const a = expr(); if(peek() && peek().t === ')') next(); return f(a); }
      return f(power());
    }
    throw new Error('Incomplete');
  }
  const v = expr();
  if(p < toks.length) throw new Error('Check the expression');
  return v;
}

return {calcEval, parseFn, GREEK, SUP, SUB, texPlain};
});
