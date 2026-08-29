#!/usr/bin/env bash
# selftest.sh — deterministic, offline (spec §9). Live checks: selftest-live.sh
set -u
cd "$(dirname "$0")/.."
STATE_DIR="$(mktemp -d)"
export OPENCRAB_STATE_DIR="$STATE_DIR"
export OPENCRAB_HOP=off
SRV_PID=""
PORT=""
cleanup() { [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$STATE_DIR"; }
trap cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }

start_fixture() {
  python3 -u -m http.server 0 --directory testdata >/tmp/oc-srv.log 2>&1 &  # -u: banner is block-buffered when redirected; readiness grep below never sees the port without it
  SRV_PID=$!
  for _ in $(seq 1 50); do
    PORT=$(grep -oE ':[0-9]+' /tmp/oc-srv.log | head -1 | tr -d ':')
    [ -n "$PORT" ] && curl -sf "http://127.0.0.1:$PORT/index.html" >/dev/null && return 0
    sleep 0.1
  done
  fail "fixture server did not start"
}

start_fixture
BASE="http://127.0.0.1:$PORT"
echo "fixture: $BASE"

run() { "$@" >/tmp/oc-out.json 2>/tmp/oc-err.txt; echo $?; }
# scrape envelope html
[ "$(run node scripts/opencrab.js scrape "$BASE/a.html")" = "0" ] || fail "scrape exit"
grep -q '"status":"ok"' /tmp/oc-out.json || fail "envelope status"
grep -q 'Page A' /tmp/oc-out.json || fail "envelope markdown"
node -e "const e=JSON.parse(require('fs').readFileSync('/tmp/oc-out.json'));if(e.title!=='Page A'||typeof e.markdown!=='string')process.exit(1)" || fail "envelope shape"
# scrape blocked (hop off)
[ "$(run node scripts/opencrab.js scrape "$BASE/blocked.html")" = "1" ] || fail "blocked exit 1"
grep -q '"status":"blocked"' /tmp/oc-out.json || fail "blocked status"
grep -q '"payload":null' /tmp/oc-out.json || fail "non-ok envelope payload"
# scrape PDF
[ "$(run node scripts/opencrab.js scrape "$BASE/doc.pdf")" = "0" ] || fail "pdf exit"
grep -qi 'opencrab' /tmp/oc-out.json || fail "pdf text"
# scrape --raw
node scripts/opencrab.js scrape "$BASE/doc.pdf" --raw | grep -qi opencrab || fail "--raw payload"

# wrapper (Task 6): stdout format cũ (spec §3)
node scripts/fetch.js "$BASE/a.html" | grep -q 'Page A' || fail "wrapper raw"
node scripts/fetch.js "$BASE/a.html" --text | grep -q 'Page A' || fail "wrapper --text"
node scripts/fetch.js "$BASE/a.html" --selector 'h1' | grep -q '"text":"Page A"' || fail "wrapper --selector"
OUT=$(node scripts/fetch.js "$BASE/blocked.html" 2>/dev/null); RC=$?
[ $RC = 1 ] && [ -z "$OUT" ] || fail "wrapper blocked empty+1"
OUT404=$(node scripts/fetch.js "$BASE/nope.html"); RC404=$?
[ $RC404 = 1 ] || fail "wrapper 404 exit"

# crawl (Task 7): POLITE mặc định — robots được tôn trọng: 5 file + 1 robots-skip, exit 0 (~25s: Crawl-delay 5s)
CRAWL_DIR="$STATE_DIR/crawl"
T0=$(date +%s)  # Task 8: Crawl-delay e2e — polite crawl ≥ 4×5s delay → tổng ≥ 20s (spec §9)
[ "$(run node scripts/opencrab.js crawl "$BASE/" --out "$CRAWL_DIR")" = "0" ] || fail "crawl exit"
T1=$(date +%s)
[ $((T1-T0)) -ge 20 ] || fail "Crawl-delay not honored (<20s)"
grep -q 'ok=5 failed=0 http=0 unchanged=0 robots=1 dup=0 resumed=0' /tmp/oc-out.json || fail "crawl summary"
NFILES=$(find "$CRAWL_DIR" -type f ! -name 'index.jsonl' | wc -l)
[ "$NFILES" = "5" ] || fail "crawl payload files ($NFILES != 5)"
grep -q '"status":"robots"' "$CRAWL_DIR/index.jsonl" || fail "crawl robots row"
# map (Task 7): linksOnly — 5 hàng [{url,title}] stdout, exit 0
[ "$(run node scripts/opencrab.js map "$BASE/")" = "0" ] || fail "map exit"
node -e "const a=JSON.parse(require('fs').readFileSync('/tmp/oc-out.json','utf8'));if(!Array.isArray(a)||a.length!==5||a.some(p=>!p.url||!p.title))process.exit(1)" || fail "map rows"

# extract (Task 9): named selectors qua jsdom + cross-host href (spec §4)
[ "$(run node scripts/opencrab.js extract "$BASE/a.html" --selector h1=h1 --selector p=p)" = "0" ] || fail "extract exit"
node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/oc-out.json'));if(JSON.stringify(j.h1)!=='[{\"text\":\"Page A\"}]'||!j.p[0].text.includes('Alpha'))process.exit(1)" || fail "extract selectors"
[ "$(run node scripts/opencrab.js extract "$BASE/c.html" --selector ext=a)" = "0" ] || fail "extract c exit"
grep -q '"href":"https://example.com/external"' /tmp/oc-out.json || fail "extract cross-host href"

node --test || fail "unit tests"  # no dir arg: Node v26 treats an explicit dir with zero test files as a module entry and fails; bare --test discovers tests/*.test.js

echo "PASS: selftest"
