#!/usr/bin/env bash
# Self-test: the canonical checks. Run: bash scripts/selftest.sh (or npm run selftest)
set -u
cd "$(dirname "$0")/.."
fail=0
check() { local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS $name"; else echo "FAIL $name"; fail=1; fi }

check "rung1 curl fast path (example.com)" node scripts/fetch.js https://example.com --text
check "ladder: reddit json (browser rung)"  node scripts/fetch.js "https://www.reddit.com/r/python/hot.json?limit=3"
check "selector extraction (browser rung)"  node scripts/fetch.js https://example.com --selector a

[ -d node_modules/cloakbrowser ] && \
  check "stealth rung (CloakBrowser)" node scripts/fetch.js "https://www.reddit.com/r/python/hot.json?limit=3" --stealth

exit $fail
