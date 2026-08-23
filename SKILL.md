---
name: blocked-fetch
description: Fetch pages and data from websites that block curl/bots — 403s, "blocked by network security", captcha or robot challenge pages. Ladder of curl-with-browser-UA → real browser session → DuckDuckGo-hop unlock. Covers Reddit's .json API, Indeed, and similar bot-walled sites. Use for web crawling/scraping when a site refuses plain HTTP clients.
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
3. **DuckDuckGo-hop unlock** — for sites that block even fresh browser sessions (Reddit). Landing on the site *through a DDG result redirect* sets a session cookie that unlocks direct access. `fetch.js` does this automatically; see "How the hop works" to do it manually via the Playwright MCP.

## Quick path: fetch.js

Setup once:
```bash
cd /path/to/blocked-fetch && npm install   # installs playwright-core (no browser download)
```

```bash
node scripts/fetch.js 'https://www.reddit.com/r/python/hot.json?limit=10'    # JSON → compact JSON out
node scripts/fetch.js 'https://example.com/page' --text                      # plain text out
node scripts/fetch.js 'URL' | jq '.'                                        # readable JSON
```

- Browser: auto-detects `/usr/bin/chromium`, chrome, brave, or playwright's bundled chromium. Override with `BLOCKED_FETCH_BROWSER=/path/to/browser`.
- Persistent profile at `~/.cache/blocked-fetch-profile` — cookies survive between runs, so the hop happens only when actually needed. Delete that dir to reset.
- Exit codes: 0 ok · 1 blocked/unreachable · 2 setup/usage error.

## How the hop works (manual, via Playwright MCP)

In pi, Playwright MCP tools go through the `mcp` gateway: `mcp({ tool: "playwright_browser_navigate", args: { url } })`, `mcp({ tool: "playwright_browser_evaluate", args: { function } })`.

1. Navigate to `https://html.duckduckgo.com/html/?q=site:TARGETHOST+query`
2. Evaluate `() => document.querySelector('.result__a')?.href` — a DDG redirect with a `rut` token (`https://duckduckgo.com/l/?uddg=...&rut=...`). The token is required; the bare `/l/?uddg=` without it 400s.
3. Navigate to that full href. Any real page on the target domain sets the cookie.
4. Navigate to the real target. Done. If a challenge page appears mid-session, re-do the hop.

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

- **No parallel requests.** Sequential with `sleep 2-3` between fetches.
- Empty response (0 bytes): wait 3-5s, retry. HTTP 429: back off 10-15s.
- Challenge page mid-session = cookie lapsed → re-do the hop (or delete `~/.cache/blocked-fetch-profile` with fetch.js).

## Adapted from

[reddit-fetch](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) by YK Sugi ([ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips)), generalized with permission-pending attribution (source is © YK Sugi, all rights reserved).
