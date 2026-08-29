# opencrab

Local, free crawl/scrape tool for AI agents — ladder-based fetch, BFS crawl, map, search, extract. A free local replacement for paid crawl APIs (Firecrawl, SerpAPI) at personal scale.

Fetch pages and data from websites that block curl/bots — 403s, captcha, "blocked by network security" — by climbing a ladder, stopping at the first rung that works:

1. curl with a browser User-Agent
2. real browser session (Playwright) — also handles JS-rendered pages
3. **search-hop unlock** — land on the target through a search-result redirect (DDG/Bing), which sets the session cookie that unlocks direct access (the only thing that works for Reddit)
4. **CloakBrowser stealth Chromium** (`--stealth`) — real Chromium with C++-level fingerprint patches, for sites that fingerprint the browser itself (Cloudflare Turnstile, FingerprintJS)

Adapted and generalized for [pi](https://github.com/badlogic/pi-mammoth) from the [reddit-fetch skill](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) in [ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips) (© YK Sugi, all rights reserved).

## Install

```bash
git clone https://github.com/hieusats/opencrab
cd opencrab
npm install
npm link          # optional — puts the `opencrab` command on PATH
```

- `playwright-core` and `cloakbrowser` are **optional dependencies**: installed by default, skipped with `npm install --omit=optional` (the cloakbrowser binary alone is ~200MB). The browser rung needs playwright-core; `--stealth` needs cloakbrowser — both degrade to a clear setup error (exit 2) when missing.
- **Node version:** the deps realistically need Node ≥ 20 (jsdom/undici/unpdf engines ≥ 22, playwright-core ≥ 20). On Node 18 npm silently skips those browser optional deps, so the browser rung degrades to a clear exit-2 message. The `engines` field stays `>=18` (spec-pinned; the owner may bump it later).
- The postinstall hook removes the legacy `~/.pi/agent/skills/blocked-fetch` skill if present — two skills with the same triggers fight each other. Manual fallback: `rm -rf ~/.pi/agent/skills/blocked-fetch`.

The browser rung needs a chromium/chrome on the system. Auto-detection order:

1. `OPENCRAB_BROWSER` env var, if set
2. System browser: `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/usr/bin/brave-browser`
3. Playwright-bundled chromium in `~/.cache/ms-playwright/`

Legacy alias: `BLOCKED_FETCH_BROWSER` still works **through the v1 wrapper only** (`scripts/fetch.js` translates it to `OPENCRAB_BROWSER`; if both are set, `OPENCRAB_BROWSER` wins). The lib reads `OPENCRAB_BROWSER` exclusively.

If none exists, either install your distro's chromium (e.g. Arch: `sudo pacman -S chromium`, Debian/Ubuntu: `sudo apt install chromium`) or let Playwright download one (no sudo needed):

```bash
npx playwright-core install chromium   # headless shell into ~/.cache/ms-playwright
```

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

Measured head-to-head vs Firecrawl (same machine, interleaved runs): [docs/BENCHMARK.md](docs/BENCHMARK.md) — single-page latency parity or better, anti-bot JSON where Firecrawl got 403'd, $0 and unthrottled; Firecrawl wins bulk crawl throughput (parallel infra vs polite sequential by design).

## Attribution

Adapted from [reddit-fetch](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) by YK Sugi ([ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips)), generalized with permission-pending attribution (source is © YK Sugi, all rights reserved).
