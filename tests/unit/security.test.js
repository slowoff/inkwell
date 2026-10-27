// (1.67.1) guards for the security fixes found in the 2026-10-27 check: they must not come back by accident.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const app = fs.readdirSync(path.join(root, 'app')).filter(f => f.endsWith('.js')).map(f => [f, fs.readFileSync(path.join(root, 'app', f), 'utf8')]);

test('PDFs are only opened through pdfOpen, with isEvalSupported: false (CVE-2024-4367)', () => {
  for(const [f, s] of app){
    for(const m of s.matchAll(/getDocument\(([^)]*)\)/g)){
      assert.ok(/isEvalSupported:\s*false/.test(m[1]), `${f}: getDocument without isEvalSupported: false`);
    }
  }
  const all = app.map(x => x[1]).join('\n');
  assert.strictEqual((all.match(/getDocument\(/g) || []).length, 1, 'only pdfOpen calls getDocument');
});

test('Word import never renders altChunk web pages (unsandboxed iframe)', () => {
  for(const [f, s] of app){
    for(const m of s.matchAll(/renderAsync\(([\s\S]*?)\}\)/g)){
      assert.ok(/renderAltChunks:\s*false/.test(m[1]), `${f}: docx renderAsync without renderAltChunks: false`);
    }
  }
});
