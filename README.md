# blocked-fetch (pi skill)

Fetch pages and data from websites that block curl/bots — 403s, "blocked by network security", captcha/robot challenge pages.

Ladder of escalation, stopping at the first rung that works:
1. curl with a browser User-Agent
2. real browser session (Playwright) — also handles JS-rendered pages
3. **DuckDuckGo-hop unlock** — land on the target through a DDG result redirect, which sets the session cookie that unlocks direct access (the only thing that works for Reddit)

Ships with `scripts/fetch.js`: one command that runs the ladder automatically, with a persistent browser profile so the hop only happens when needed.

Adapted and generalized for [pi](https://github.com/badlogic/pi-mammoth) from the [reddit-fetch skill](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) in [ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips) (© YK Sugi, all rights reserved).

## Install

```bash
git clone https://github.com/hieusats/blocked-fetch ~/.pi/agent/skills/blocked-fetch
cd ~/.pi/agent/skills/blocked-fetch && npm install   # playwright-core only, no browser download
```

A chromium/chrome must exist on the system (auto-detected; override with `BLOCKED_FETCH_BROWSER`). Or clone anywhere and add the path to pi `settings.json`:

```json
{ "skills": ["/path/to/blocked-fetch"] }
```

## Usage

Load with `/skill:blocked-fetch`, or just ask pi to fetch/scrape a site that returns 403 — the skill activates on blocked-site symptoms.

```bash
node scripts/fetch.js 'https://www.reddit.com/r/python/hot.json?limit=10'
node scripts/fetch.js 'https://www.indeed.com/jobs?q=python' --text
node scripts/fetch.js 'URL' | jq '.'
```

Exit codes: 0 ok · 1 blocked · 2 setup error. Reset the session profile with `rm -rf ~/.cache/blocked-fetch-profile`.
