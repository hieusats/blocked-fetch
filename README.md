# blocked-fetch (pi skill)

Fetch pages and data from websites that block curl/bots — 403s, "blocked by network security", captcha/robot challenge pages.

Ladder of escalation, stopping at the first rung that works:
1. curl with a browser User-Agent
2. real browser session (Playwright) — also handles JS-rendered pages
3. **search-hop unlock** — land on the target through a search-result redirect (DDG/Bing), which sets the session cookie that unlocks direct access (the only thing that works for Reddit)
4. **CloakBrowser stealth Chromium** (`--stealth`) — real Chromium with C++-level fingerprint patches, for sites that fingerprint the browser itself (Cloudflare Turnstile, FingerprintJS)

Ships with `scripts/fetch.js`: one command that runs the ladder automatically, with a persistent browser profile so the hop only happens when needed.

Adapted and generalized for [pi](https://github.com/badlogic/pi-mammoth) from the [reddit-fetch skill](https://github.com/ykdojo/claude-code-tips/tree/main/skills/reddit-fetch) in [ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips) (© YK Sugi, all rights reserved).

## Install

### 1. Skill + Playwright (rungs 1–3)

```bash
git clone https://github.com/hieusats/blocked-fetch ~/.pi/agent/skills/blocked-fetch
cd ~/.pi/agent/skills/blocked-fetch
npm install            # playwright-core — no browser download
```

The browser rung needs a chromium/chrome on the system. Auto-detection order:

1. `BLOCKED_FETCH_BROWSER` env var, if set
2. System browser: `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/usr/bin/brave-browser`
3. Playwright-bundled chromium in `~/.cache/ms-playwright/`

If none exists, either install your distro's chromium (e.g. Arch: `sudo pacman -S chromium`, Debian/Ubuntu: `sudo apt install chromium`) or let Playwright download one (no sudo needed):

```bash
npx playwright-core install chromium   # headless shell into ~/.cache/ms-playwright
```

Or clone anywhere and add the path to pi `settings.json`:

```json
{ "skills": ["/path/to/blocked-fetch"] }
```

### 2. CloakBrowser — optional stealth rung 4

Only needed when the target fingerprints the browser itself (Cloudflare Turnstile, FingerprintJS, Kasada):

```bash
cd ~/.pi/agent/skills/blocked-fetch
npm install cloakbrowser
```

- **First `--stealth` run auto-downloads the stealth Chromium binary (~200MB)** into the cloakbrowser cache.
- **Free tier, no signup:** binary v146, 1 concurrent session. A GitHub key from <https://cloakbrowser.dev/free> unlocks the newest build (also free); `CLOAKBROWSER_LICENSE_KEY` env or `cloakbrowser login` enables Pro.
- **Linux font note:** for best Windows-spoofing fidelity install a full Windows font set (see [CloakBrowser font setup](https://github.com/CloakHQ/cloakbrowser#font-setup-on-linux)); harmless to skip — silence the warning with `CLOAKBROWSER_SUPPRESS_FONT_WARNING=1`.
- Optional proxy config:

```bash
CLOAKBROWSER_PROXY=http://user:pass@residential-proxy:port \  # residential IP beats datacenter
CLOAKBROWSER_LICENSE_KEY=... \                              # only for Pro
node scripts/fetch.js 'https://hard-target.com' --text --stealth
```

### 3. Verify

```bash
node scripts/fetch.js 'https://www.reddit.com/r/python/hot.json?limit=3'   # rungs 1–3
node scripts/fetch.js 'https://www.reddit.com/r/python/hot.json?limit=3' --stealth   # rung 4
```

Both should print compact JSON (`exit 0`). The first run may show the hop log lines (`[#] ... hopping via ...`) — that's normal.

## Usage

Load with `/skill:blocked-fetch`, or just ask pi to fetch/scrape a site that returns 403 — the skill activates on blocked-site symptoms.

```bash
node scripts/fetch.js 'https://www.reddit.com/r/python/hot.json?limit=10'
node scripts/fetch.js 'https://www.indeed.com/jobs?q=python' --text
node scripts/fetch.js 'https://hard-target.com' --text --stealth   # after: npm install cloakbrowser
node scripts/fetch.js 'URL' | jq '.'
```

Stealth mode extras: `CLOAKBROWSER_PROXY=http://user:pass@host:port` for a residential proxy (auto geoip), `CLOAKBROWSER_LICENSE_KEY` for CloakBrowser Pro.

Exit codes: 0 ok · 1 blocked · 2 setup error. Reset the session profile with `rm -rf ~/.cache/blocked-fetch-profile`.
