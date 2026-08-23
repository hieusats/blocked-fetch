---
name: blocked-fetch
description: Fetch pages and data from websites that block curl/bots — 403s, "blocked by network security", captcha or robot challenge pages. Ladder of curl-with-browser-UA → real browser session → search-hop unlock (DDG/Bing) → CloakBrowser stealth Chromium. Covers Reddit's .json API, Indeed, Cloudflare-protected sites, and similar bot-walled sites. Use for web crawling/scraping when a site refuses plain HTTP clients.
---

# Blocked Fetch

Many sites block plain HTTP clients while allowing real browsers. Don't give up on a 403 — climb the ladder. Each rung is cheap; stop at the first that works.

## The ladder

1. **curl with a browser User-Agent** — fastest, surprisingly often enough (Amazon, LinkedIn currently allow it from many IPs).
   ```bash
   UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
   curl -s -L -o /tmp/page.txt -w "%{http_code}" -H "User-Agent: $UA" 'URL'
   ```
   Fetch to a temp file (`-o`), never pipe raw output into context.
2. **Real browser session** (`scripts/fetch.js`) — handles JS-rendered pages and most bot walls (Indeed 403s curl but serves browsers fine).
3. **Search-hop unlock** — for sites that block even fresh browser sessions (Reddit). Landing on the site *through a search-result redirect* sets a session cookie that unlocks direct access. `fetch.js` does this automatically across engines (DDG html → DDG lite → Bing); see "How the hop works" to do it manually via the Playwright MCP.
4. **Stealth Chromium** (`--stealth`, [CloakBrowser](https://github.com/CloakHQ/cloakbrowser)) — for sites that fingerprint the browser itself (Cloudflare Turnstile, FingerprintJS, Kasada). Real Chromium with C++-level fingerprint patches; also beats bot detection at search engines. Opt-in: `npm install cloakbrowser` (~200MB binary, free tier). For the hardest targets add a residential proxy via `CLOAKBROWSER_PROXY` env.

## Quick path: fetch.js

Setup once:
```bash
cd /path/to/blocked-fetch && npm install   # installs playwright-core (no browser download)
```

```bash
node scripts/fetch.js 'https://www.reddit.com/r/python/hot.json?limit=10'    # JSON → compact JSON out
node scripts/fetch.js 'https://example.com/page' --text                      # plain text out
node scripts/fetch.js 'https://cloudflare-protected.com' --text --stealth    # CloakBrowser rung
node scripts/fetch.js 'URL' | jq '.'                                        # readable JSON
```

- Browser: auto-detects `/usr/bin/chromium`, chrome, brave, or playwright's bundled chromium. Override with `BLOCKED_FETCH_BROWSER=/path/to/browser`.
- Persistent profile at `~/.cache/blocked-fetch-profile` (stealth: `-stealth` suffix) — cookies survive between runs, so the hop happens only when actually needed. Delete those dirs to reset.
- Stealth mode needs `npm install cloakbrowser` in the skill dir. Optional proxy: `CLOAKBROWSER_PROXY=http://user:pass@host:port` (+ `CLOAKBROWSER_LICENSE_KEY` for Pro).
- Exit codes: 0 ok · 1 blocked/unreachable · 2 setup/usage error.

## How the hop works (manual, via Playwright MCP)

In pi, Playwright MCP tools go through the `mcp` gateway: `mcp({ tool: "playwright_browser_navigate", args: { url } })`, `mcp({ tool: "playwright_browser_evaluate", args: { function } })`.

1. Navigate to a search engine scoped to the target: `https://html.duckduckgo.com/html/?q=site:TARGETHOST+query` (or `https://www.bing.com/search?q=site:TARGETHOST`)
2. Evaluate `() => document.querySelector('.result__a')?.href` (DDG html; Bing: `li.b_algo h2 a`). DDG's href is a redirect with a `rut` token (`https://duckduckgo.com/l/?uddg=...&rut=...`) — the token is required; the bare `/l/?uddg=` without it 400s. Bing's href is a `bing.com/ck/a` redirect that lands on the target.
3. Navigate to that full href. Any real page on the target domain sets the cookie.
4. Navigate to the real target. Done. If a challenge page appears mid-session, re-do the hop — possibly via a different engine: **DDG itself rate-limits and serves its own captcha ("select all squares containing a duck") after several hops, so rotate engines.**

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

- No parallel requests. Sequential with `sleep 2-3` between fetches.
- Empty response (0 bytes): wait 3-5s, retry. HTTP 429: back off 10-15s.
- Challenge page mid-session = cookie lapsed → re-do the hop (or delete `~/.cache/blocked-fetch-profile*` with fetch.js).
- Search engines rate-limit hops too — after several hops DDG serves a captcha; Bing still works. Rotate engines rather than hammering one.
- Stealth mode uses CloakBrowser's free tier (1 concurrent session, binary v146; v150 free with a GitHub key from https://cloakbrowser.dev/free).

## Adapted from

[reddit-fetch](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) by YK Sugi ([ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips)), generalized with permission-pending attribution (source is © YK Sugi, all rights reserved).
