#!/usr/bin/env bash
# Runs the Inkwell tests in headless Chromium against fake Supabase/Google/R2 servers.
# Usage:
#   tests/run.sh                      all tests
#   tests/run.sh field_format spell   only these files (test_ prefix and .py optional)
#   JOBS=1 tests/run.sh               one file at a time (old behaviour)
# (needs: pip install playwright pillow; a Chromium for Playwright)
# (1.67.3) Test files run side by side (JOBS at once, default: number of CPUs, 2..4). Safe because every file
# launches its own browser with its own fake backends and only reads the shared static server. Longest files start
# first. Each file's output is printed in one piece when it finishes, with its time. A file that fails is run once
# more on its own afterwards: if it passes then, it is reported as FLAKY (passed alone, failed under load) and does
# not fail the run; if it fails again, the run fails.
# On GitHub, failed checks also show up as annotations on the run (readable without the log).
set -u
cd "$(dirname "$0")/.."
T0=$(date +%s)
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

# which test files
FILES=()
if [ $# -gt 0 ]; then
  for a in "$@"; do
    n=$(basename "$a"); n=${n%.py}; n=${n#test_}
    if [ -f "tests/test_$n.py" ]; then FILES+=("tests/test_$n.py"); else echo "No such test: $a"; exit 2; fi
  done
else
  FILES=(tests/test_*.py)
fi

# (1.61.3) fast checks first: the pure code in core/ with Node (a second), then the lint report if ESLint is there.
# Skipped when only some files were asked for.
if [ $# -eq 0 ]; then
  echo "=== tests/unit (Node)"
  if node --test tests/unit/*.test.js > "$OUT/unit.log" 2>&1; then grep -E '^# (pass|fail)' "$OUT/unit.log"
  else
    cat "$OUT/unit.log"; echo "FAILED: tests/unit"; fail=1
    [ -n "${GITHUB_ACTIONS:-}" ] && grep -E '^not ok' "$OUT/unit.log" | head -20 | while IFS= read -r line; do echo "::error title=unit tests::${line//%/%25}"; done
  fi
  ESL="${ESLINT:-}"; [ -z "$ESL" ] && [ -x node_modules/.bin/eslint ] && ESL=node_modules/.bin/eslint
  if [ -n "$ESL" ]; then
    echo "=== lint (ESLint)"
    if ! "$ESL" --no-config-lookup -c eslint.config.js app.js app/*.js core/*.js sw.js config.js; then echo "FAILED: lint"; fail=1; fi
  fi
fi

# longest first: estimate a file's length by the waits written in it
ORDER=$(for t in "${FILES[@]}"; do
  w=$(grep -oE 'wait_for_timeout\([0-9]+\)' "$t" | grep -oE '[0-9]+' | awk '{s+=$1} END {print s+0}')
  echo "$w $t"
done | sort -rn | awk '{print $2}')

if [ -z "${JOBS:-}" ]; then JOBS=$(nproc 2>/dev/null || echo 2); [ "$JOBS" -lt 2 ] && JOBS=2; [ "$JOBS" -gt 4 ] && JOBS=4; fi
NFILES=${#FILES[@]}
[ "$JOBS" -gt "$NFILES" ] && JOBS=$NFILES
echo "=== ${NFILES} browser test files, ${JOBS} at a time"

run_one(){  # $1 = test file, $2 = tag for the log name
  local t=$1 log="$OUT/$(basename "$1").$2.log" s=$(date +%s) code
  timeout -s INT -k 30 480 python3 -u "$t" > "$log" 2>&1; code=$?
  echo "$code $(( $(date +%s) - s ))" > "$log.res"
}
PRINTED=" "
FAILED=()
show_done(){  # print every finished file once, in one piece
  local r t log code secs
  for r in "$OUT"/*.p.log.res; do
    [ -e "$r" ] || continue
    log=${r%.res}; t="tests/$(basename "$log" .p.log)"
    case "$PRINTED" in *" $t "*) continue;; esac
    PRINTED="$PRINTED$t "
    read -r code secs < "$r"
    echo "=== $t (${secs} s)"; cat "$log"
    if [ "$code" != 0 ]; then echo "failed: $t (exit $code), will run again alone"; FAILED+=("$t"); fi
  done
}

PIDS=()
running(){  # number of test processes still going (not the web server)
  local p n=0 keep=()
  for p in "${PIDS[@]}"; do kill -0 "$p" 2>/dev/null && { n=$((n+1)); keep+=("$p"); }; done
  PIDS=("${keep[@]}"); echo "$n"
}
for t in $ORDER; do
  while [ "$(running)" -ge "$JOBS" ]; do sleep 0.5; show_done; done
  run_one "$t" p &
  PIDS+=($!)
done
while [ "$(running)" -gt 0 ]; do sleep 0.5; show_done; done
for p in "${PIDS[@]}"; do wait "$p" 2>/dev/null; done
show_done

# failed files once more, one at a time
for t in "${FAILED[@]}"; do
  echo "=== $t again, alone"
  run_one "$t" r
  log="$OUT/$(basename "$t").r.log"; read -r code secs < "$log.res"
  cat "$log"
  if [ "$code" = 0 ]; then
    echo "FLAKY: $t failed while running beside others, passed alone (${secs} s)"
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning title=$(basename "$t")::failed beside other tests, passed alone"
  else
    echo "FAILED: $t (exit $code)"; fail=1
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
      grep '^FAIL ' "$log" | head -20 | while IFS= read -r line; do echo "::error title=$(basename "$t")::${line//%/%25}"; done
      tail -n 15 "$log" | tr '\n' '|' | sed 's/%/%25/g' | { read -r tl; echo "::error title=$(basename "$t") last lines::$tl"; }
    fi
  fi
done

echo "=== took $(( ($(date +%s) - T0) / 60 )) min $(( ($(date +%s) - T0) % 60 )) s"
[ $fail = 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit $fail
