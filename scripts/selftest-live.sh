#!/usr/bin/env bash
# selftest-live.sh — live network checks (spec §9). Run BY HAND: bash scripts/selftest-live.sh
# NOT part of the offline gate (scripts/selftest.sh stays deterministic via OPENCRAB_HOP=off).
# Hits Reddit + real search engines — mind rate limits; uses the default state dir so hop
# cookies persist (that is the point). Exit codes: 0 pass · 1 fail.
set -u
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $1"; exit 1; }

# 1) Reddit .json — the REAL hop (ladder rung 3): Reddit 403s curl and fresh browsers;
#    only a search-result redirect sets the unlocking cookie.
REDDIT='https://www.reddit.com/r/python/hot.json?limit=3'
node scripts/opencrab.js scrape "$REDDIT" >/tmp/oc-live-reddit.json 2>/tmp/oc-live-reddit.err
RC=$?
[ $RC = 0 ] || { cat /tmp/oc-live-reddit.err; fail "reddit .json scrape exit $RC"; }
node -e "const e=JSON.parse(require('fs').readFileSync('/tmp/oc-live-reddit.json'));if(e.status!=='ok'||!e.json)process.exit(1)" \
  || fail "reddit .json envelope (status=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/oc-live-reddit.json')).status") — expected ok + json payload)"

# 2) search — real searchResults; whichever engine wins, snippets must be NON-EMPTY
#    (pins the T9 sibling-td fix: ddg-lite snippet is a sibling td in the same tr).
node scripts/opencrab.js search 'nodejs' --limit 5 >/tmp/oc-live-search.json 2>/tmp/oc-live-search.err
RC=$?
[ $RC = 0 ] || { cat /tmp/oc-live-search.err; fail "search exit $RC"; }
node -e "const a=JSON.parse(require('fs').readFileSync('/tmp/oc-live-search.json'));if(!Array.isArray(a)||!a.length)process.exit(1);for(const r of a)if(!String(r.title).trim()||!String(r.url).trim()||!String(r.snippet).trim())process.exit(2)" \
  || fail "search: empty/missing title·url·snippet in winning engine's results"

# 3) --stealth — only meaningful with cloakbrowser installed (optional dep)
if [ -d node_modules/cloakbrowser ]; then
  node scripts/opencrab.js scrape "$REDDIT" --stealth --raw >/tmp/oc-live-stealth.json 2>/tmp/oc-live-stealth.err
  RC=$?
  [ $RC = 0 ] || { cat /tmp/oc-live-stealth.err; fail "stealth scrape exit $RC"; }
  grep -qi '"kind": *"listing"' /tmp/oc-live-stealth.json || fail "stealth: payload is not a Reddit listing"
else
  echo "SKIP: cloakbrowser not installed — stealth probe skipped (npm install to enable)"
fi

echo "PASS: selftest-live"
