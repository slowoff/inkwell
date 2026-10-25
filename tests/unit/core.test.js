// Fast tests (1.61.3) for the pure code in core/*.js. Plain Node, no browser, no packages: node --test tests/unit
// They run in a second or two, before the slow browser tests (tests/run.sh and the Tests workflow).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../../core/util.js');
const G = require('../../core/ink.js');
const M = require('../../core/merge.js');
const T = require('../../core/text.js');

test('server times: same moment written differently compares equal, order kept', () => {
  assert.ok(U.tsEq('2026-10-25T15:15:45.181416+00:00', '2026-10-25T15:15:45.181416Z'));
  assert.ok(U.tsEq('2026-10-25T15:15:45.1+00:00', '2026-10-25T15:15:45.100000+00:00'));
  assert.ok(!U.tsEq('2026-10-25T15:15:45.181416+00:00', '2026-10-25T15:15:45.181417+00:00'));
  assert.ok(!U.tsEq(null, null));
  // microseconds count (Safari's Date.parse stops at milliseconds)
  assert.ok(U.tsKey('2026-10-25T15:15:45.181416+00:00') < U.tsKey('2026-10-25T15:15:45.181417+00:00'));
  assert.ok(U.tsKey('2026-10-25T15:15:45.999999+00:00') < U.tsKey('2026-10-25T15:15:46.000000+00:00'));
  assert.equal(U.tsKey(''), '');
});

test('small helpers', () => {
  assert.equal(U.esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(U.esc(null), '');
  assert.equal(U.clamp(5, 0, 3), 3);
  assert.equal(U.clamp(-1, 0, 3), 0);
  assert.equal(U.pad2(7), '07');
  assert.notEqual(U.newId(), U.newId());
  assert.equal(U.fmtDate(0), '');
  let n = 0; const d = U.debounce(() => ++n, 1000);
  d(); d(); assert.ok(d.pending()); d.flush(); assert.equal(n, 1); assert.ok(!d.pending());
});

test('stored points: encode/decode keeps positions to 0.25 and pressure to 1/31', () => {
  const p = [10.13, 20.88, 0.5, 11.5, 22.26, 0.9, -3.3, 400.01, 0];
  const back = G.decPts(G.encPts(p));
  assert.equal(back.length, p.length);
  for(let i = 0; i < p.length; i += 3){
    assert.ok(Math.abs(back[i] - p[i]) <= 0.125 + 1e-9);
    assert.ok(Math.abs(back[i+1] - p[i+1]) <= 0.125 + 1e-9);
    assert.ok(Math.abs(back[i+2] - p[i+2]) <= 1 / 62 + 1e-9);
  }
  assert.deepEqual(G.decPts(''), []);
  const it = {t: 's', id: 's1', c: '#000', w: 2, hl: 0, p};
  assert.equal(typeof G.ser(it).p, 'string');
  assert.ok(Array.isArray(G.deser(G.ser(it)).p));
  assert.deepEqual(G.ser({t: 'x', id: 'x', html: 'a'}), {t: 'x', id: 'x', html: 'a'});
});

test('fade value', () => {
  assert.equal(G.opOf({o: 0.5}), 0.5);
  assert.equal(G.opOf({}), 1);
  assert.equal(G.opOf({o: 1.2}), 1);
  assert.equal(G.opOf(null), 1);
});

const line = (n, f) => { const p = []; for(let i = 0; i < n; i++){ const [x, y] = f(i); p.push(x, y, 0.5); } return p; };

test('stroke shape: ends stay where the pen touched, every recorded point is found again', () => {
  const p = line(30, i => [i * 7, 50 + 20 * Math.sin(i / 3)]);
  const sh = G.strokeShape({w: 3, hl: 0, p});
  assert.equal(sh.xs[0], p[0]); assert.equal(sh.ys[0], p[1]);
  assert.equal(sh.xs[sh.n - 1], p[p.length - 3]); assert.equal(sh.ys[sh.n - 1], p[p.length - 2]);
  assert.equal(sh.at.length, 30);
  for(let i = 1; i < sh.at.length; i++) assert.ok(sh.at[i] > sh.at[i - 1]);
  assert.equal(sh.at[29], sh.n - 1);
  assert.ok(sh.n > 30);   // smooth curve between points
});

test('stroke shape is local: a part computed alone equals the same part of the whole stroke', () => {
  const p = line(200, i => [i * 2 + 10 * Math.cos(i / 4), 100 + 15 * Math.sin(i / 2.7)]);
  const full = G.strokeShape({w: 2.4, hl: 0, p});
  const a = 80, b = 120, w0 = a - 6, end = b + 6;
  const part = G.strokeShape({w: 2.4, hl: 0, p: p.slice(w0 * 3, (end + 1) * 3)});
  const s0 = part.at[a - w0], s1 = part.at[b - w0], f0 = full.at[a];
  for(let k = s0; k <= s1; k++){
    assert.ok(Math.abs(part.xs[k] - full.xs[f0 + k - s0]) < 1e-9);
    assert.ok(Math.abs(part.ys[k] - full.ys[f0 + k - s0]) < 1e-9);
    assert.ok(Math.abs(part.rs[k] - full.rs[f0 + k - s0]) < 1e-9);
  }
});

test('outline: ordinary writing is one outline, a sharp back-and-forth is filled as pieces (no holes)', () => {
  const smooth = {t: 's', w: 2, hl: 0, p: line(60, i => [i * 3, 40 + 8 * Math.sin(i / 5)])};
  const d1 = G.strokePath(smooth, true);
  assert.equal(G.strokePath.lastMode, 'outline');
  assert.equal((d1.match(/M/g) || []).length, 1);
  const zig = {t: 's', w: 26, hl: 1, p: []};
  for(let k = 0; k < 8; k++) zig.p.push(100 + k * 14, 100, 0.5, 107 + k * 14, 280, 0.5);
  const d2 = G.strokePath(zig, true);
  assert.equal(G.strokePath.lastMode, 'pieces');
  assert.ok((d2.match(/M/g) || []).length > 10);
  assert.ok(!/NaN|Infinity/.test(d1 + d2));
});

test('outline: a dot is a round dot', () => {
  const d = G.strokePath({t: 's', w: 4, hl: 0, p: [5, 5, 0.5]}, true);
  assert.match(d, /^M[\d.]+ 5a/);
});

test('stroke box covers the pen width', () => {
  assert.deepEqual(G.strokeBox({w: 4, p: [10, 20, .5, 30, 5, .5]}), [7, 2, 33, 23]);
});

test('draw order: fills, then highlighter, then ink', () => {
  assert.equal(G.inkPass({fl: 1}), 2); assert.equal(G.inkPass({hl: 1}), 1); assert.equal(G.inkPass({}), 0);
});

test('stable JSON ignores key order and undefined', () => {
  assert.equal(M.stable({b: 1, a: [1, {d: 2, c: undefined}]}), M.stable({a: [1, {d: 2}], b: 1}));
  assert.notEqual(M.stable({a: 1}), M.stable({a: 2}));
});

test('three-way merge of fields: each side keeps its own changes', () => {
  const base = {name: 'Old', color: 1, order: 3};
  const local = {name: 'Mine', color: 1, order: 3};
  const remote = {name: 'Old', color: 4, order: 3};
  assert.deepEqual(M.mergeKeys(base, local, remote, false), {name: 'Mine', color: 4, order: 3});
  // both changed one field: the newer side wins
  assert.equal(M.mergeKeys(base, {name: 'A'}, {name: 'B'}, true).name, 'A');
  assert.equal(M.mergeKeys(base, {name: 'A'}, {name: 'B'}, false).name, 'B');
});

const s = (id, x) => ({t: 's', id, c: '#000', w: 2, hl: 0, p: `${x},0,10,1,1,10`});
test('page merge: strokes added on both devices are all kept, in a sensible order', () => {
  const base = {bg: {type: 'grid'}, items: [s('a', 0)]};
  const local = {bg: {type: 'grid'}, items: [s('a', 0), s('mine', 1)]};
  const remote = {bg: {type: 'grid'}, items: [s('a', 0), s('theirs', 2)]};
  const m = M.mergeContent(base, local, remote, true);
  assert.deepEqual(m.data.items.map(i => i.id).sort(), ['a', 'mine', 'theirs']);
  assert.equal(m.data.items[0].id, 'a');
  assert.equal(m.copies, 0);
});

test('page merge: erasing on one device removes the stroke; erasing vs editing keeps the edit', () => {
  const base = {items: [s('a', 0), s('b', 1)]};
  const m1 = M.mergeContent(base, {items: [s('a', 0), s('b', 1)]}, {items: [s('a', 0)]}, false);
  assert.deepEqual(m1.data.items.map(i => i.id), ['a']);
  const m2 = M.mergeContent(base, {items: [s('a', 0)]}, {items: [s('a', 0), s('b', 9)]}, true);
  assert.deepEqual(m2.data.items.map(i => i.id).sort(), ['a', 'b']);
});

test('page merge: a text box changed on both devices keeps both versions', () => {
  const x = html => ({t: 'x', id: 'x1', x: 10, y: 10, w: 200, fs: 1, html});
  const m = M.mergeContent({items: [x('<p>a</p>')]}, {items: [x('<p>mine</p>')]}, {items: [x('<p>theirs</p>')]}, true);
  assert.equal(m.copies, 1);
  const htmls = m.data.items.map(i => i.html).sort();
  assert.deepEqual(htmls, ['<p>mine</p>', '<p>theirs</p>']);
  const copy = m.data.items.find(i => i.html === '<p>theirs</p>');
  assert.notEqual(copy.id, 'x1'); assert.equal(copy.x, 34);
});

test('page merge: keep() protects a new local stroke the other side lacks', () => {
  const base = {items: [s('a', 0), s('fresh', 1)]};
  const local = {items: [s('a', 0), s('fresh', 1)]};
  const remote = {items: [s('a', 0)]};
  assert.deepEqual(M.mergeContent(base, local, remote, false).data.items.map(i => i.id), ['a']);
  assert.deepEqual(M.mergeContent(base, local, remote, false, id => id === 'fresh').data.items.map(i => i.id), ['a', 'fresh']);
});

test('calculator', () => {
  assert.equal(T.calcEval('2+3*4'), 14);
  assert.equal(T.calcEval('2^10'), 1024);
  assert.ok(Math.abs(T.calcEval('sin(90)', 0, true) - 1) < 1e-12);
  assert.ok(Math.abs(T.calcEval('sin(pi/2)', 0, false) - 1) < 1e-12);
  assert.equal(T.calcEval('Ans*2', 5, false), 10);
  assert.equal(T.calcEval('5!'), 120);
  assert.throws(() => T.calcEval('2+'));
});

test('graph formulas', () => {
  const f = T.parseFn('y = x^2 + 1');
  assert.equal(f(3), 10);
  assert.equal(T.parseFn('f(x) = 2·x')(4), 8);
  assert.equal(T.parseFn(''), null);
});

test('formula as plain text', () => {
  assert.equal(T.texPlain('\\frac{a+b}{2}'), '(a+b)/2');
  assert.match(T.texPlain('\\sqrt{x}'), /√x/);
});
