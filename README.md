# opencrab

Local, free crawl/scrape tool for AI agents — ladder-based fetch, BFS crawl, map, search, extract. A free local replacement for paid crawl APIs (Firecrawl, SerpAPI) at personal scale.

Fetch pages and data from websites that block curl/bots — 403s, captcha, "blocked by network security" — by climbing a ladder, stopping at the first rung that works:

1. curl with a browser User-Agent
2. real browser session (Playwright) — also handles JS-rendered pages
3. **search-hop unlock** — land on the target through a search-result redirect (DDG/Bing), which sets the session cookie that unlocks direct access (the only thing that works for Reddit)
4. **CloakBrowser stealth Chromium** (`--stealth`) — real Chromium with C++-level fingerprint patches, for sites that fingerprint the browser itself (Cloudflare Turnstile, FingerprintJS)

Adapted and generalized for [pi](https://github.com/badlogic/pi-mammoth) from the [reddit-fetch skill](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) in [ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips) (© YK Sugi, all rights reserved).

## Why agents pick opencrab

Measured head-to-head vs Firecrawl — same machine, interleaved runs, real API (full data & methodology in [Benchmark](#benchmark)):

- **Anti-bot real content: 4/7 vs 2/7.** Reddit and Instagram 403'd Firecrawl's own scrapers; opencrab's curl/browser rungs passed 3/3 runs each — Reddit in 4 s, Instagram in 1.3 s.
- **Faster single pages where it counts:** 1.7× on static HTML (718 vs 1 186 ms), 2× on PDF extraction (1 171 vs 2 398 ms).
- **Honest statuses.** Firecrawl returned Amazon's 404 page and 17 chars of Cloudflare challenge text as `success:true`; opencrab reports `blocked` / `http:404` so your agent can branch without re-validating content.
- **$0, local, unthrottled.** No API key, no 10-scrape/min free-tier ceiling, nothing leaves the machine. Polite by default (robots + Crawl-delay) — `--aggressive` when you own the target.

## Install

```bash
git clone https://github.com/hieusats/opencrab
cd opencrab
npm install
npm link          # optional — puts the `opencrab` command on PATH
```

That is the standard flow (clone → `npm install` runs deps + the postinstall hook; `npm link` registers the `bin`). Pick a [profile](#setup-step-by-step) if you want a lean install.

### Install for your agent harness

opencrab follows the [Agent Skills](https://agentskills.io) standard (`SKILL.md` + CLI), so it drops into any skills-aware harness:

```bash
# pi — package install (pinned tag; pi runs npm install in the clone for you)
pi install git:github.com/hieusats/opencrab@v2.0.0

# Claude Code — clone into the skills dir
git clone https://github.com/hieusats/opencrab ~/.claude/skills/opencrab && cd ~/.claude/skills/opencrab && npm install && npm link

# any machine, no harness — global CLI straight from git
npm install -g github:hieusats/opencrab
```

Other skills-standard harnesses (Codex, etc.): clone or symlink the repo into their skills directory the same way, then `npm install` inside it.

## Setup, step by step

**1. Node ≥ 20 recommended.** Deps realistically need Node ≥ 20 (jsdom/undici/unpdf engines ≥ 22, playwright-core ≥ 20). On Node 18 npm silently skips the browser optional deps — the rest works and the browser rung degrades to a clear exit-2 message. (`engines` stays `>=18` — spec-pinned.)

**2. Pick an install profile:**

```bash
npm install                      # full (default): browser + stealth rungs included
npm install --omit=optional      # lean: curl rung + text/markdown/PDF only
                                 # (cloakbrowser binary alone is ~200 MB)
```

Missing pieces never fail silently: browser rung without playwright-core → exit 2; `--stealth` without cloakbrowser → exit 2 — both with a clear setup message.

**3. Provide a chromium for the browser rung** (skip on lean installs). Auto-detection order:

1. `OPENCRAB_BROWSER=/path/to/chrome` env var — highest priority
2. System browser — first hit of: `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/usr/bin/brave-browser`
3. Playwright-bundled chromium in `~/.cache/ms-playwright/`

Get one, any way:

```bash
sudo pacman -S chromium                  # Arch
sudo apt install chromium                # Debian/Ubuntu
npx playwright-core install chromium     # no sudo — headless shell into ~/.cache/ms-playwright
```

Legacy alias: `BLOCKED_FETCH_BROWSER` is honored by the v1 wrapper (`scripts/fetch.js`) only — translated to `OPENCRAB_BROWSER`, which wins if both are set. The lib reads `OPENCRAB_BROWSER` exclusively.

**4. Verify:**

```bash
opencrab scrape https://example.com      # envelope JSON, "via":"curl"
npm run selftest                         # offline e2e (~2 min)
```

Note: the postinstall hook removes the legacy `~/.pi/agent/skills/blocked-fetch` skill if present — two skills with the same triggers fight each other. Manual fallback: `rm -rf ~/.pi/agent/skills/blocked-fetch`.

### CloakBrowser — optional stealth rung 4

Only needed when the target fingerprints the browser itself (Cloudflare Turnstile, FingerprintJS, Kasada). Included via optional deps; the **first `--stealth` run auto-downloads the stealth Chromium binary (~200MB)** into the cloakbrowser cache.

- **Free tier, no signup:** binary v146, 1 concurrent session. A GitHub key from <https://cloakbrowser.dev/free> unlocks the newest build (also free); `CLOAKBROWSER_LICENSE_KEY` env or `cloakbrowser login` enables Pro.
- **Linux font note:** for best Windows-spoofing fidelity install a full Windows font set (see [CloakBrowser font setup](https://github.com/CloakHQ/cloakbrowser#font-setup-on-linux)); harmless to skip — silence the warning with `CLOAKBROWSER_SUPPRESS_FONT_WARNING=1`.
- Optional proxy config:

```bash
CLOAKBROWSER_PROXY=http://user:pass@residential-proxy:port \  # residential IP beats datacenter
CLOAKBROWSER_LICENSE_KEY=... \                              # only for Pro
opencrab scrape 'https://hard-target.com' --text --stealth
```

## Usage

```bash
opencrab scrape URL [--raw|--text|--html] [--out F] [--max-bytes N]
            [--wait-for SELECTOR] [--screenshot F] [--stealth]
opencrab crawl URL --out DIR/ [--limit 50] [--depth 2] [--delay 1500]
            [--include G] [--exclude G] [--resume] [--changed-only] [--aggressive]
opencrab map URL [--limit 500] [--depth 3]                  # → JSON [{url,title}]
opencrab search "q" [--limit 10] [--scrape]                 # → [{title,url,snippet}]
opencrab extract URL --selector name=CSS [--selector name2=CSS2]
```

```bash
opencrab scrape 'https://www.reddit.com/r/python/hot.json?limit=10'    # full ladder + envelope
opencrab scrape 'https://example.com' --raw | jq '.'                   # bare markdown payload
opencrab search 'nodejs docx parse' --limit 5                          # 3-engine search, JSON to stdout
opencrab crawl 'https://example.com/' --out /tmp/site --limit 50       # polite BFS + index.jsonl
opencrab crawl 'https://example.com/' --out /tmp/site --resume --changed-only   # incremental
opencrab extract 'https://example.com' --selector links='main a' --selector h1=h1
```

- **Politeness (bulk commands):** `crawl`/`map`/`search --scrape` respect robots.txt (`User-agent: *`) and Crawl-delay (capped at 30s), default inter-request delay 1500ms; `--aggressive` bypasses robots + default delay. Single-URL `scrape`/`extract` never check robots — by design: the Reddit `.json` pattern depends on it.
- **Incremental:** state lives in `OPENCRAB_STATE_DIR` (default `~/.local/state/opencrab/state`); `--resume` skips terminal rows from the previous run, `--changed-only` sends conditional requests (304/etag) and hash-compares. Plain crawl ignores state.
- `--wait-for SELECTOR` / `--screenshot FILE` force the browser rung; the screenshot is written even on blocked pages (bot-wall debug evidence).

### Envelope & exit codes

`scrape` prints one JSON envelope; `search --scrape` prints one per line (JSONL); `crawl` writes one per row to `index.jsonl`:

```json
{"url":"...","finalUrl":"...","title":"...","status":"ok","via":"curl|browser|stealth","hopped":false,"ms":123,"markdown":"..."}
```

Exactly one payload key (`markdown` | `text` | `html` | `json` — default markdown); non-ok envelopes carry `"payload":null`. `--raw` prints the bare payload. `--max-bytes` (default 200000) caps stdout only — never `--out` or crawl files.

Exit codes: **0** ok · **1** blocked/partial · **2** usage/setup (bad args, no chromium, no cloakbrowser, browser-pidfile conflict). A command that needs the browser exits 2 immediately if another opencrab invocation holds it (pidfile in `~/.local/state/opencrab/browser.pid`); pure-curl commands are never blocked — sequential politeness over queuing is a deliberate trade-off.

### Environment

| Var | Meaning |
| --- | --- |
| `OPENCRAB_BROWSER` | Chromium/chrome path override (lib detection). |
| `BLOCKED_FETCH_BROWSER` | Legacy alias — honored by `scripts/fetch.js` only; translated to `OPENCRAB_BROWSER` (wins if both set). |
| `OPENCRAB_STATE_DIR` | State store + browser pidfile + profiles (default `~/.local/state/opencrab`; profiles `profile`/`profile-stealth`; old `~/.cache/blocked-fetch-profile*` migrates on first browser run). |
| `OPENCRAB_HOP` | `off` disables the search-hop rung (offline selftest uses this). |
| `CLOAKBROWSER_PROXY` / `CLOAKBROWSER_LICENSE_KEY` | Stealth rung proxy / Pro key. |

### Legacy wrapper (v1 backcompat)

`scripts/fetch.js` keeps the v1 CLI and v1 stdout format (no envelope — raw body, `--text` body text, `--selector` bare JSON array):

```bash
node scripts/fetch.js 'https://www.reddit.com/r/python/hot.json?limit=10'   # full ladder, JSON → compact
node scripts/fetch.js url1 url2 url3 --max-bytes 50000                      # batch, context-safe
node scripts/fetch.js 'https://example.com' --selector 'a'                  # → [{text,href}] (forces browser)
```

## Verify

```bash
npm run selftest         # deterministic, offline fixture tests (~2 min)
npm run selftest-live    # live checks (Reddit hop, real search snippets, stealth) — run by hand
```

Reset session profiles: `rm -rf ~/.local/state/opencrab/profile*`.

## Benchmark

Measured head-to-head vs Firecrawl — same machine, interleaved runs, real API (2026-08-29; Ryzen 7 7800X3D, Node 26, residential network). Full data & methodology: [docs/BENCHMARK.md](docs/BENCHMARK.md).

| Case | Firecrawl | opencrab | Winner |
|---|---|---|---|
| Static HTML | 1 186 ms | **718 ms** | opencrab 1.7× |
| Heavy HTML (Wikipedia) | **1 636 ms** | 3 348 ms | Firecrawl 2× |
| **Anti-bot JSON (Reddit)** | **403 — failed** | **4 272 ms, ok 3/3** | **opencrab** |
| Instagram profile | **403 — failed** | **1.3 s via curl, 199 KB** | **opencrab** |
| X profile | 7.7 s, 1.6 KB shell | 2.2 s via curl, 101 KB | **opencrab** |
| Quora / Booking.com | ok, deep | Quora shallow / blocked | Firecrawl |
| Yelp (hardest) | 403 | blocked (honest) | tie |
| PDF extract | 2 398 ms | **1 171 ms** | opencrab 2× |
| Cloudflare challenge | `success:true` w/ 17 chars of challenge text | honest `status:"blocked"` | opencrab honesty |
| Map 1 000-page site | **9.3 s / 1 200 links** (parallel) | 130 s / 100 links (polite sequential) | Firecrawl |

**Anti-bot real-content score: opencrab 4/7 vs Firecrawl 2/7** — Reddit and Instagram 403'd Firecrawl's own scrapers while opencrab's curl/browser rungs passed. Firecrawl's `success:true` is not a content guarantee (returned Amazon's 404 page and Cloudflare challenge text as "success"); opencrab reports honest statuses for agent branching. $0, local, unthrottled (vs free tier: 10 scrape/min).

## Attribution

Adapted from [reddit-fetch](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) by YK Sugi ([ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips)), generalized with permission-pending attribution (source is © YK Sugi, all rights reserved).
