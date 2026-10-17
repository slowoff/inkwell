#!/usr/bin/env bash
# Runs every Inkwell test in headless Chromium against fake Supabase/Google/R2 servers.
# Usage: tests/run.sh   (needs: pip install playwright pillow; a Chromium for Playwright)
set -u
cd "$(dirname "$0")/.."
export INKWELL_PORT="${INKWELL_PORT:-8766}"
python3 -m http.server "$INKWELL_PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
fail=0
for t in tests/test_*.py; do
  echo "=== $t"
  if ! timeout 600 python3 "$t"; then echo "FAILED: $t"; fail=1; fi
done
[ $fail = 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit $fail
