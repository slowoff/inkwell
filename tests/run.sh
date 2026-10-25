#!/usr/bin/env bash
# Runs every Inkwell test in headless Chromium against fake Supabase/Google/R2 servers.
# Usage: tests/run.sh   (needs: pip install playwright pillow; a Chromium for Playwright)
# On GitHub, failed checks also show up as annotations on the run (readable without the log).
set -u
cd "$(dirname "$0")/.."
export INKWELL_PORT="${INKWELL_PORT:-8766}"
python3 -m http.server "$INKWELL_PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
# wait until the local server answers (a slow runner may need more than a second)
for i in $(seq 1 50); do
  python3 -c "import urllib.request,sys; urllib.request.urlopen('http://localhost:$INKWELL_PORT/index.html', timeout=1)" 2>/dev/null && break
  sleep 0.2
done
OUT=$(mktemp -d)
fail=0
# (1.61.3) fast checks first: the pure code in core/ with Node (a second), then the lint report if ESLint is there
echo "=== tests/unit (Node)"
if node --test tests/unit/*.test.js > "$OUT/unit.log" 2>&1; then grep -E '^# (pass|fail)' "$OUT/unit.log"
else
  cat "$OUT/unit.log"; echo "FAILED: tests/unit"; fail=1
  [ -n "${GITHUB_ACTIONS:-}" ] && grep -E '^not ok' "$OUT/unit.log" | head -20 | while IFS= read -r line; do echo "::error title=unit tests::${line//%/%25}"; done
fi
ESL="${ESLINT:-}"; [ -z "$ESL" ] && [ -x node_modules/.bin/eslint ] && ESL=node_modules/.bin/eslint
if [ -n "$ESL" ]; then
  echo "=== lint (ESLint)"
  if ! "$ESL" --no-config-lookup -c eslint.config.js app/*.js core/*.js sw.js config.js; then echo "FAILED: lint"; fail=1; fi
fi
for t in tests/test_*.py; do
  echo "=== $t"
  log="$OUT/$(basename "$t").log"
  timeout -s INT -k 30 480 python3 -u "$t" 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}
  if [ "$code" != 0 ]; then
    echo "FAILED: $t (exit $code)"; fail=1
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
      grep '^FAIL ' "$log" | head -20 | while IFS= read -r line; do echo "::error title=$(basename "$t")::${line//%/%25}"; done
      tail -n 15 "$log" | tr '\n' '|' | sed 's/%/%25/g' | { read -r tl; echo "::error title=$(basename "$t") last lines::$tl"; }
    fi
  fi
done
[ $fail = 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit $fail
