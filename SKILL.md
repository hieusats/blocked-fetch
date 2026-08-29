---
name: opencrab
description: Fetch pages and data from websites that block curl/bots — 403s, captcha, "blocked by network security" — AND crawl, scrape, map, search, extract data from any site as a free local replacement for paid crawl APIs. Ladder: curl-UA → browser → search-hop → CloakBrowser stealth.
---

# opencrab

Many sites block plain HTTP clients while allowing real browsers. Don't give up on a 403 — climb the ladder. Each rung is cheap; stop at the first that works.

1. **curl with a browser User-Agent** — fastest, surprisingly often enough (Amazon, LinkedIn currently allow it from many IPs). Built into every opencrab command: rung 1 is always tried first.
2. **Real browser session** — handles JS-rendered pages and most bot walls (Indeed 403s curl but serves browsers fine).
3. **Search-hop unlock** — for sites that block even fresh browser sessions (Reddit). Landing on the site *through a search-result redirect* (DDG html → DDG lite → Bing) sets a session cookie that unlocks direct access. Done automatically; see "How the hop works" for the manual route.
4. **Stealth Chromium** (`--stealth`, [CloakBrowser](https://github.com/CloakHQ/cloakbrowser)) — for sites that fingerprint the browser itself (Cloudflare Turnstile, FingerprintJS, Kasada). Real Chromium with C++-level fingerprint patches; also beats bot detection at search engines. Needs `npm install` with optional deps (cloakbrowser ~200MB binary, free tier). For the hardest targets add a residential proxy via `CLOAKBROWSER_PROXY`.

## CLI (scripts/opencrab.js)

```bash
opencrab scrape URL [--raw|--text|--html] [--out F] [--max-bytes N]
            [--wait-for SELECTOR] [--screenshot F] [--stealth]
opencrab crawl URL --out DIR/ [--limit 50] [--depth 2] [--delay 1500]
            [--include G] [--exclude G] [--resume] [--changed-only] [--aggressive]
opencrab map URL [--limit 500] [--depth 3]                  # → JSON [{url,title}]
opencrab search "q" [--limit 10] [--scrape]                 # → [{title,url,snippet}]
opencrab extract URL --selector name=CSS [--selector name2=CSS2]
```

`npm link` once to put `opencrab` on PATH, or use `node scripts/opencrab.js ...` from the repo.

- `scrape` — one URL through the ladder. Default payload **markdown** (Readability→turndown); JSON responses → `json` payload, PDFs → `text` (unpdf). `--raw` prints the bare payload instead of the envelope.
- `crawl` — polite BFS same-host crawl; writes `DIR/<sha1>.md|.txt|.json` + `index.jsonl`. Honors robots.txt (`User-agent: *`) and Crawl-delay (capped 30s); default delay 1500ms; `--aggressive` bypasses both. `--resume`/`--changed-only` reuse the state store: skip already-fetched / unchanged pages.
- `map` — `crawl --links-only`: bare `[{url,title}]` to stdout, no files, no state.
- `search` — 3-engine web search (DDG html → DDG lite → Bing, rotating past challenges). `--scrape` fetches each result into a JSONL envelope stream (robots-gated, 1500ms apart).
- `extract` — named CSS selectors → `{"name":[{text,href?}]}` on the curl rung; escalates to the browser only when actually blocked (never because of 0 matches).
- `--wait-for SELECTOR` / `--screenshot FILE` force the browser rung; the screenshot is written **even on blocked pages** (that's the debug evidence).

### Envelope & exit codes

Every `scrape` prints one JSON envelope; `search --scrape` and `crawl` output reuse the same shape per row:

```json
{"url":"...","finalUrl":"...","title":"...","status":"ok","via":"curl|browser|stealth","hopped":false,"ms":123,"markdown":"..."}
```

- Exactly one payload key: `markdown` | `text` | `html` | `json`; non-ok envelopes carry `"payload":null`.
- stdout caps at 200KB (`--max-bytes N`) — files (`--out`, crawl output) are never truncated.
- Exit codes: **0** ok · **1** blocked/partial · **2** usage/setup (bad args, no chromium, no cloakbrowser, browser-pidfile conflict).

### Environment

- `OPENCRAB_BROWSER=/path/to/chromium` — override browser auto-detection (system chromium/chrome/brave, then playwright-bundled).
- `OPENCRAB_STATE_DIR` — state store, browser pidfile, browser profiles (default `~/.local/state/opencrab`; profiles `profile` / `profile-stealth`; old `~/.cache/blocked-fetch-profile*` migrates on first browser run).
- `OPENCRAB_HOP=off` — disable the search-hop rung (used by the offline selftest).
- `CLOAKBROWSER_PROXY` / `CLOAKBROWSER_LICENSE_KEY` — stealth rung proxy/Pro key.
- Legacy: `BLOCKED_FETCH_BROWSER` still works through the v1 wrapper `scripts/fetch.js` only (it translates to `OPENCRAB_BROWSER`; if both are set `OPENCRAB_BROWSER` wins).

**Pidfile trade-off:** one browser per machine — a command that needs the browser exits **2 immediately** if another opencrab invocation holds it (pure-curl commands are never blocked). Sequential politeness is by design; kill a wedged holder with `kill $(cat ~/.local/state/opencrab/browser.pid)`.

## Legacy wrapper: fetch.js (v1 backcompat)

Same ladder, v1 stdout format (no envelope — raw body / `--text` body text / `--selector` bare JSON array):

```bash
node scripts/fetch.js 'https://www.reddit.com/r/python/hot.json?limit=10'   # full ladder, JSON → compact
node scripts/fetch.js 'https://example.com/page' --text                     # plain text out
node scripts/fetch.js url1 url2 url3 --max-bytes 50000                      # batch, context-safe (2s between URLs)
node scripts/fetch.js 'https://example.com' --selector 'a'                  # → JSON [{text,href}] (forces browser rung)
node scripts/fetch.js 'https://hard-target.com' --text --stealth
```

## Reddit specifics (deepest case)

Reddit 403s curl **and** fresh browser sessions, but after the hop its public JSON API works — append `.json` to any Reddit URL:

```text
/r/SUB/hot.json?limit=15                          # swap hot for new/top (top: &t=day|week|month|year|all)
/r/SUB/comments/POST_ID.json?limit=20&sort=top    # [0]=post, [1]=comment tree
/r/SUB/search.json?q=QUERY&restrict_sr=on&sort=new&limit=15
```

- Listings: `.data.children[].data` → `title`, `score`, `num_comments`, `author`, `id`.
- Threads: `[1].data.children[]` filter `kind == "t1"` → `author`, `score`, `body`, nested `replies` of same shape. Truncate bodies (`.body[:300]`) to keep output readable.
- Use `www.reddit.com` for browser navigation.
- More comments than `.json?limit=` allows: scrape the rendered page — `document.querySelectorAll('shreddit-comment')`, fields in attributes `author`, `score`, text in `.md`.

## Rate limiting

- No parallel requests. Sequential with `sleep 2-3` between fetches (crawl/search already do this internally).
- Empty response (0 bytes): wait 3-5s, retry. HTTP 429: back off 10-15s (the browser rung auto-retries once after 10s).
- Challenge page mid-session = cookie lapsed → re-do the hop (or delete `~/.local/state/opencrab/profile*` to reset).
- Search engines rate-limit hops too — after several hops DDG serves a captcha; Bing still works. Rotate engines rather than hammering one.
- Stealth mode uses CloakBrowser's free tier (1 concurrent session, binary v146; v150 free with a GitHub key from <https://cloakbrowser.dev/free>).

## How the hop works (manual, via Playwright MCP)

1. Navigate to a search engine scoped to the target: `https://html.duckduckgo.com/html/?q=site:TARGETHOST+query` (or `https://www.bing.com/search?q=site:TARGETHOST`)
2. Evaluate `() => document.querySelector('.result__a')?.href` (DDG html; Bing: `li.b_algo h2 a`). DDG's href is a redirect with a `rut` token (`https://duckduckgo.com/l/?uddg=...&rut=...`) — the token is required; the bare `/l/?uddg=` without it 400s.
3. Navigate to that full href. Any real page on the target domain sets the cookie.
4. Navigate to the real target. Done. If a challenge page appears mid-session, re-do the hop — possibly via a different engine: **DDG itself rate-limits and serves its own captcha ("select all squares containing a duck") after several hops, so rotate engines.**

## Verify & install

```bash
npm run selftest         # deterministic, offline (~2 min)
npm run selftest-live    # live: Reddit hop, real search snippets, stealth — run by hand
```

Install (pi skill): `git clone https://github.com/hieusats/opencrab ~/.pi/agent/skills/opencrab && cd ~/.pi/agent/skills/opencrab && npm install`. opencrab's postinstall removes the legacy `~/.pi/agent/skills/blocked-fetch` skill automatically (manual fallback: `rm -rf ~/.pi/agent/skills/blocked-fetch`) — two skills with the same triggers fight each other.

## Adapted from

[reddit-fetch](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) by YK Sugi ([ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips)), generalized with permission-pending attribution (source is © YK Sugi, all rights reserved).
