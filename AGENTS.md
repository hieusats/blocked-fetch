# AGENTS.md — opencrab

Free, local, CLI-only crawl/scrape tool for AI agents. Ladder: curl-UA → browser → search-hop → CloakBrowser stealth. Full design authority: `docs/superpowers/specs/2026-08-28-opencrab-design.md` (v1.13); implementation argument: `docs/superpowers/plans/2026-08-28-opencrab-v2.md`.

## Commands

```bash
node --test              # unit tests (18) — fast, offline
npm run selftest         # full offline e2e (~2 min, polite delays by design)
npm run selftest-live    # live network checks — run by hand only
bash -n scripts/selftest-live.sh   # syntax check when touching it
```

## Hard rules (spec-pinned — don't break these)

- **Exit codes:** 0 ok · 1 content-level failure · 2 setup/usage (missing browser, pidfile conflict, bad args). `SetupError` → exit 2.
- **`lib/` throws, bins decide:** library modules only throw (`SetupError`); only `scripts/*.js` set `process.exitCode`. No `process.exit()` mid-flight (breaks stdout flush).
- **Envelope contract:** non-ok responses carry `"payload": null` (never omit the key). Fields are spec §4 — consumers depend on them.
- **Politeness is the default:** robots.txt honored, 1.5 s inter-page delay, `Crawl-delay` respected (capped 30 s). Bypass only via `--aggressive`. Never make impolite the default path.
- **Dep whitelist frozen:** `playwright-core`, `cloakbrowser` (optionalDependencies), `@mozilla/readability`, `turndown`, `jsdom`, `unpdf`. Node ≥18. No new deps without a spec amendment.
- **Tests are offline and deterministic:** fixture server (`tests/serve.js`, `testdata/`) only. Live checks belong in `scripts/selftest-live.sh`, never in `node --test` or CI.
- **Fixture purity:** if a test fails, fix the code — never edit `testdata/` to make a test pass.

## Layout

- `lib/fetcher.js` — fetch ladder, searchResults, SetupError, envelope
- `lib/crawl.js` — normalizeUrl, robots, BFS crawl/map/extract, state+resume (`state/<host>.json` under `$OPENCRAB_STATE_DIR`)
- `lib/md.js` — htmlToText / toMarkdown / pdfToText
- `scripts/opencrab.js` — CLI (scrape/crawl/map/search/extract)
- `scripts/fetch.js` — v1 backcompat wrapper (keep v1 output format)

## Conventions

- Language: code + docs in English; user-facing stderr notes may use the terse `[#]` prefix.
- Commits: `git -c user.name=hieusats -c user.email=hieusats@users.noreply.github.com commit` (global identity unset on this machine).
- Never commit secrets/API keys. Benchmarks use env vars (`FIRECRAWL_API_KEY` lives in `~/.bashrc`, not the repo).
- Known deferred items (sitemap-delay politeness, truncEnvelope json-string type change on cap, cmdMap exit2 asymmetry) are ledgered in `.superpowers/sdd/2026-08-28-opencrab-v2/progress.md` — deliberate, don't "fix" silently.
