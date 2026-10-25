// Lint settings (1.61.3). Run by tests/run.sh and the Tests workflow; it only reads the code, never changes it.
// Only real mistakes are errors and fail the tests (a name that does not exist, a name declared twice); unused code is a
// warning (shown, not failing); style is not checked.
const globals = require('globals');
const LIBS = {pdfjsLib: 'readonly', katex: 'readonly', supabase: 'readonly', PDFLib: 'readonly', JSZip: 'readonly', docx: 'readonly', html2canvas: 'readonly',
  InkUtil: 'readonly', InkGeo: 'readonly', InkMerge: 'readonly', InkText: 'readonly'};
module.exports = [
  {ignores: ['lib/**', 'tests/**', 'supabase/**', 'node_modules/**']},
  {
    files: ['app.js', 'core/*.js', 'sw.js', 'config.js'],
    languageOptions: {ecmaVersion: 2023, sourceType: 'script', globals: {...globals.browser, ...globals.serviceworker, ...LIBS, module: 'readonly', require: 'readonly'}},
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'warn',
      'no-unused-vars': ['warn', {args: 'none', caughtErrors: 'none'}]
    }
  }
];
