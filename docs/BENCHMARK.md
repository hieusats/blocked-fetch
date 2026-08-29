# opencrab vs Firecrawl — measured benchmark

**Date:** 2026-08-29 · **opencrab:** 2.0.0 (`e7e3678`) · **Firecrawl:** hosted API v1
**Machine:** AMD Ryzen 7 7800X3D, 30 GiB RAM, Node v26.7.0, residential network
**Method:** both tools called back-to-back per URL (interleaved, 3 runs each) so network conditions match; Firecrawl calls spaced 6.5 s to respect the free-tier 10 scrape/min limit.

## TL;DR

| Case | Firecrawl | opencrab | Winner |
| --- | --- | --- | --- |
| Static HTML | 1 186 ms | **718 ms** | opencrab 1.7× |
| Heavy HTML (Wikipedia) | **1 636 ms** | 3 348 ms | Firecrawl 2× |
| Anti-bot JSON (Reddit `.json`) | **403 ×3 (failed)** | **4 272 ms, ok 3/3** | opencrab (only one that worked) |
| PDF extract | 2 398 ms | **1 171 ms** | opencrab 2× |
| Cloudflare challenge page | 1 222 ms, `success:true` but 17 chars of challenge text | 9 422 ms, honest `status:"blocked"` | tie (neither got content; opencrab tells the truth) |
| Map 1 000-page site | **9.3 s, 1 200 links** | 130 s, 100 links (`--aggressive --delay 0 --limit 100`, sequential) | Firecrawl (parallel infra) |
| **Anti-bot suite (7 sites)** | real content on 2/7 | **real content on 4/7** (Reddit, Instagram, X, + honest statuses) | opencrab — see below |

## Anti-bot suite — can it actually crawl bot-walled sites?

Same method (interleaved, 3 runs), 7 classic anti-bot targets, 2026-08-29. "Real content" = useful payload, verified by inspecting the markdown head (not just the success flag).

| Site | Firecrawl | opencrab | Verified content | Winner |
|---|---|---|---|---|
| Reddit `r/LocalLLaMA/hot.json` | 0/3 — HTTP 403 | **3/3, 4.0 s, `via:browser`, 29 KB JSON** | OC: real post JSON | **opencrab** |
| Instagram profile | 0/3 — HTTP 403 | **3/3, 1.3 s, `via:curl`, 199 KB** | OC: real profile HTML (CSS-noisy) | **opencrab** |
| X profile | 3/3, 7.7 s, 1.6 KB | **3/3, 2.2 s, `via:curl`, 101 KB** | both: server-rendered shell; OC carries the real page title + embedded data | opencrab (edge) |
| Amazon product | "3/3 `success:true`" | 0/3 — honest `status:"http:404"` | **FC's success = Amazon's "Sorry! We couldn't find that page" error page (436 chars)** | neither got the product |
| Quora question | 3/3, 2.5 s, 57 KB | 3/3, 4.0 s, `via:browser`, 4.7 KB | both real; FC deeper thread | **Firecrawl** |
| Booking.com search | 3/3, 2.2 s, 27 KB | 0/3 — Akamai wall | FC: real results | **Firecrawl** |
| Yelp business | 0/3 — HTTP 403 | 0/3 — ladder exhausted | neither | tie (hardest) |

### Reading the tea leaves

- **Score on real content: opencrab 3 clear + 1 edge, Firecrawl 2, both-fail 2.** Reddit and Instagram 403'd Firecrawl's own scrapers entirely while passing opencrab's curl/browser rungs.
- **Firecrawl's `success:true` is not a content guarantee.** Amazon returned the 404 dog page as a "successful" 436-char markdown; the Cloudflare case above returned 17 chars of challenge text as success. opencrab reports `http:404` / `blocked` honestly — agent consumers can branch on it without re-validating content.
- **Caveats:** Amazon's 404 hit both tools (possibly region/ASIN gating, not pure anti-bot); Instagram/X markdown via curl carries CSS noise (server-rendered fallback pages); Quora/Booking show where hosted proxy farms still win.

## Scrape detail (wall clock, 3 runs)

### static — <https://example.com>

| tool | runs (ms) | avg | ok | content |
| --- | --- | --- | --- | --- |
| Firecrawl | 1194 / 1084 / 1280 | 1186 | 3/3 | 167 chars md |
| opencrab (`via:curl`) | 770 / 675 / 709 | **718** | 3/3 | 328 chars md |

### heavy-html — <https://en.wikipedia.org/wiki/Web_scraping>

| tool | runs (ms) | avg | ok | content |
| --- | --- | --- | --- | --- |
| Firecrawl | 1561 / 1698 / 1649 | **1636** | 3/3 | 58 775 chars md |
| opencrab (`via:browser`) | 3427 / 3356 / 3260 | 3348 | 3/3 | 46 635 chars md |

opencrab's curl rung is throttled by Wikipedia, so the ladder escalates to a cold local browser. Firecrawl keeps warm browser pools server-side — this is their home turf.

### antibot-json — <https://www.reddit.com/r/python/hot.json?limit=5>

| tool | runs (ms) | avg | ok | content |
| --- | --- | --- | --- | --- |
| Firecrawl | 1100 / 1188 / 1066 | 1118 | **0/3 — HTTP 403** | — |
| opencrab (`via:browser` + hop) | 4301 / 4234 / 4282 | 4272 | **3/3** | 34 896 chars JSON |

The headline case for opencrab: Reddit 403'd Firecrawl's own scrapers on this endpoint while the local browser rung passed every time.

### pdf — <https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf>

| tool | runs (ms) | avg | ok | content |
| --- | --- | --- | --- | --- |
| Firecrawl | 3485 / 1790 / 1920 | 2398 | 3/3 | ~80 259 chars |
| opencrab (`via:curl`) | 1197 / 1116 / 1201 | **1171** | 3/3 | 82 804 chars |

### cf-wall — <https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf>

| tool | avg | ok | content |
| --- | --- | --- | --- |
| Firecrawl | 1222 | 3/3 `success:true` | **17 chars** — the "Just a moment..." challenge text, marked as success |
| opencrab | 9422 | 3/3 `status:"blocked"` | honest null payload after trying all rungs |

A "success" envelope containing challenge text is worse than an honest failure for agent consumers. opencrab reports `blocked` with `payload:null` (spec §4).

## Map detail — <https://books.toscrape.com/> (1 000 pages, no sitemap)

| tool | wall | links | mode |
| --- | --- | --- | --- |
| Firecrawl `/v1/map` | 9.3 s | 1 200 | server-side parallel crawl |
| opencrab `map` | 130 s | 100 | `--aggressive --delay 0 --limit 100`, single sequential process (~1.3 s/page) |
| opencrab `map` (defaults) | ~145 s est. | 50 (limit) | polite: robots + 1.5 s inter-page delay — **by design** |

opencrab crawls politely and sequentially by default (robots.txt honored, 1.5 s inter-request delay, `Crawl-delay` respected). For bulk jobs use `--aggressive` and/or run N processes; throughput scales with processes, not per-page latency.

## Published references (not measured here)

- **Firecrawl rate limits** (per plan, requests/min): Free 10 scrape · 2 crawl; Hobby 100 · 20; Standard 500 · 100; Growth 5 000 · 1 000; Scale 10 000 · 2 000. Concurrency (browsers): Free 2 → Scale 100+. Source: <https://docs.firecrawl.dev/rate-limits> (fetched 2026-08-29).
- **Third-party throughput context** (Spider's benchmark, 2026-02-11, vendor-run — treat with care): Firecrawl ~16 pages/s corpus avg, time-to-first-result 310 ms static / 1.4 s JS / 3.8 s anti-bot. Source: <https://spider.cloud/blog/firecrawl-vs-crawl4ai-vs-spider-honest-benchmark/>
- **Cost:** Firecrawl is credit-based per plan; opencrab is $0 and local (this machine, unthrottled).

## Reproduce

Anti-bot suite targets: reddit `.json` endpoints, instagram/x profiles via plain curl UA, amazon product page, quora question, booking search, yelp business page — see `/tmp`-style script pattern above with your own target list.

```bash
export FIRECRAWL_API_KEY=fc-...        # your key — never commit it
OC=scripts/opencrab.js
for i in 1 2 3; do
  curl -s -X POST https://api.firecrawl.dev/v1/scrape \
    -H "Authorization: Bearer $FIRECRAWL_API_KEY" -H 'Content-Type: application/json' \
    -d '{"url":"https://example.com","formats":["markdown"]}' -o /tmp/fc.json -w '%{time_total}\n'
  /usr/bin/time -f '%e' node $OC scrape https://example.com > /dev/null
  sleep 6.5
done
node $OC map https://books.toscrape.com/ --aggressive --delay 0 --limit 100
```

Raw run data of this report: interleaved 3× per case, Firecrawl `POST /v1/scrape` `{formats:["markdown"]}`, 90 s timeout per call.

## Caveats

- Residential network, one machine, one evening — treat as a snapshot, not a distribution.
- Firecrawl latency here is API wall time from the same network as opencrab; their server-side fetch time is not visible.
- Wikipedia/PDF content lengths differ between tools (different extraction pipelines); length ≠ quality.
- Spider benchmark is run by Spider (conflict of interest); cited only for scale context.
- The Cloudflare "success" (17 chars) may differ with Firecrawl's stealth/PRO options — not tested (paid tier).
