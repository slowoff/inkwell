Inkwell spell check (1.66)

worker.js     Inkwell's own code: runs Hunspell in a Web Worker (see the comment at the top).
hunspell.js   Hunspell (the spell checker of LibreOffice and Firefox) compiled to WebAssembly by the npm package
              hunspell-asm 4.0.2 (MIT, https://github.com/kwonoj/hunspell-asm; Hunspell itself is
              MPL-1.1 / GPL-2.0 / LGPL-2.1, https://github.com/hunspell/hunspell), with its helpers
              emscripten-wasm-loader and nanoid (MIT). Made once with:
                printf "const {loadModule} = require('hunspell-asm/dist/cjs/index.js');\nself.HunspellAsm = {loadModule};\n" > entry.js
                npx esbuild entry.js --bundle --minify --platform=browser --format=iife --target=safari15 --outfile=hunspell.js
dict/         Word lists from https://github.com/wooorm/dictionaries (npm packages, version 3.0.0), copied with
              make-dict.mjs (run in a folder with the dictionary-* packages installed:
              node make-dict.mjs <inkwell>/lib/spell/dict). Each list keeps its own licence next to it
              (<lang>.license.txt):
                de-CH  dictionary-de-ch  GPL-2.0 or GPL-3.0 (igerman98). The package still has "ß";
                       make-dict.mjs changes it to "ss" for Swiss spelling.
                de-DE  dictionary-de     GPL-2.0 or GPL-3.0 (igerman98)
                en-GB  dictionary-en-gb  MIT and BSD (SCOWL)
                en-US  dictionary-en     MIT and BSD (SCOWL)
                pt-PT  dictionary-pt-pt  GPL-2.0, LGPL-2.1 or MPL-1.1
                pt-BR  dictionary-pt     LGPL-3.0 or MPL-2.0

The service worker keeps hunspell.js and the word lists in their own cache ("inkwell-spell-1") that survives
app updates; a language is downloaded the first time it is used. If a list or hunspell.js is ever replaced,
raise the number in that cache name in sw.js.
