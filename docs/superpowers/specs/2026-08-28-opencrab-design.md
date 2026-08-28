# opencrab v2.0 — Design Spec

Ngày: 2026-08-28 · Phiên bản spec: v1.2 (adversarial vòng 2 đã sửa) · Nền: council 3-advisor (Appendix A) + vòng lặp tấn công (Appendix B)

## 1. Mục tiêu & phi mục tiêu

**Mục tiêu:** biến blocked-fetch (skill fetch 1 URL qua thang chống-bot) thành **opencrab** — công cụ crawl/scratch địa phương miễn phí cho AI agent, thay các API crawl trả phí (Firecrawl, SerpAPI...) ở quy mô cá nhân.

**Phi mục tiêu:** HTTP server/API, quy mô công nghiệp (sequential politeness là chủ ý), LLM nhúng trong CLI, dep có native binding, simhash/persistent-queue/AutoThrottle/OCR.

**Ràng buộc:** miễn phí, local, Node.js, một máy, dùng cá nhân.

## 2. Quyết định sản phẩm (owner, đã chốt 2026-08-28)

| # | Quyết định | Lựa chọn |
| --- | --- | --- |
| D1 | Output mặc định của `scrape` | **JSON envelope** `{url,title,status,via,markdown}\|text\|json}`;`--raw` để lấy thân trần |
| D2 | PDF | **unpdf** (zero-dep) khi content-type `application/pdf` |
| D3 | Watch/incremental | **State store + `--resume` + `--changed-only` vào v2.0**; watch phase 2 chỉ là vòng lặp mỏng |
| D4 | P1 riders | Thêm **`--screenshot FILE`** + **`--wait-for SELECTOR`** |
| D5 | Interface | CLI thuần (không HTTP) — chốt từ trước council |
| D6 | Etiquette | Lịch sự mặc định (robots cho lệnh bulk, delay, `--aggressive` bypass) |

## 3. Kiến trúc — cấu trúc file

```text
scripts/
  fetch.js        # wrapper backcompat: flags/exit/stdout như cũ; map --selector→extract,
                  #   urls[]→scrape tuần tự (2s giữa URL), BLOCKED_FETCH_BROWSER→OPENCRAB_BROWSER (alias chỉ tồn tại trong wrapper)
  opencrab.js     # bin: argv dispatch chỉ 1 dòng → lệnh con
  lib/
    fetcher.js    # thang leo dời từ fetch.js: curl-UA → browser → hop → stealth
                  # export: fetch(), searchResults(q,{limit})→{engine,results:[{title,url,snippet}]}
                  #   (throw khi cả 3 engine bị challenge), extractLinks(html,baseUrl)→href tuyệt đối
                  #   CHƯA normalize (crawl.js normalize), close() — THROW, cấm process.exit
    md.js         # toMarkdown (readability→turndown qua jsdom, fallback full-body)
                  #   + htmlToText (dời từ fetch.js) + pdfToText (unpdf)
    crawl.js      # robots (~50 dòng, naive, comment ponytail về giới hạn Allow/Disallow
                  #   precedence), crawlBFS({linksOnly}), index.jsonl, state store, resume
testdata/         # fixture site: 4 trang liên kết + robots.txt + trang BLOCK_PAT + trang tiếng Việt + PDF nhỏ
```

- `map` = `crawlBFS({linksOnly:true})` — một engine, hai lệnh mỏng.
- `extract` chạy selector qua DOM (jsdom) trên HTML của rung curl; chỉ leo browser khi trang cần JS hoặc bị chặn.
- Dep (đều pure-JS): `playwright-core`, `cloakbrowser` (optional), `@mozilla/readability`, `turndown`, `jsdom`, `unpdf`.
- **Pidfile** (`~/.local/state/opencrab/lock`): CẢ hai entrypoint (opencrab.js lẫn wrapper fetch.js) cùng acquire — invocation thứ 2 fail-fast exit 2. SIGKILL chỉ áp cho pid stale. Giữ **killProfileOrphans scoped** (match đúng `--user-data-dir=` profile opencrab, không đụng browser thật) cho case ProcessSingleton: chromium mồ côi sau crash giữ lock trong khi pidfile đã chết. Handler SIGINT/SIGTERM gọi `fetcher.close()`.

## 4. Contracts — khoá trước khi code

**`fetch(url, opts) →`**

```js
{ ok: boolean, status: 'ok'|'blocked'|'http:NNN'|'error:msg',
  via: 'curl'|'browser'|'stealth', hopped: boolean, finalUrl,
  contentType, html, text, ms }
```

- `status` của fetch **không** có `'robots'` — robots là cổng phía caller (crawl engine) chạy trước khi gọi fetch; `'robots'`/`'dup'` chỉ xuất hiện ở dòng index.jsonl.
- `error:msg` = exception đã sanitize, msg cap 200 ký tự (không process.exit trong lib).
- `via` = cơ chế thành công cuối cùng; `hopped:true` = đã đi search-hop trước đó.
- `contentType`, `etag`, `lastModified` bắt ở cả 2 rung (curl: `-D` dump header rồi parse; browser: response headers) — quyết định nhánh PDF/JSON/markdown và nuôi INM/304.
- `bytes` = Buffer thân phản hồi gốc — curl rung đọc buffer (không utf8-string hóa; PDF/latin-1 nguyên vẹn tới unpdf); `html`/`text` là chuỗi suy ra cho content-type text; `text` = innerText (browser) | htmlToText(html) (curl).
- Retry: rung browser gặp 429 → backoff 10s, retry đúng 1 lần (giữ hành vi fetch.js); không retry nào khác.
- Browser rung bắt **cả `page.content()` (html) lẫn innerText** — không thì readability/extract chết ở đúng mục tiêu khó.

**Dòng index.jsonl** (mỗi trang 1 dòng, JSON append; `hash` = sha256 hex của **bytes payload suy ra** (chuỗi markdown/text/json) — deterministic, dùng chung cho dedup + state kể cả khi không ghi file; `status` ngoài enum của fetch còn `'robots'` (bỏ vì robots) và `'dup'` (nội dung trùng, bỏ ghi); trường không có giá trị = `null`, không omit; dòng đầu = `{"seed":"<url>","ts":<ms>}` cho `--resume` đối chiếu; robots/dup/304 **không** tính là failure; 304 ghi dòng `http:304` — để `--resume` thấy là done):

```js
{ url, finalUrl, file, title, hash, status, via, ms, ts }
```

**State store** `~/.local/state/opencrab/state/<host>.json` (KHÔNG `~/.cache` — tmpfiles xén cache ~10 ngày):

```js
{ "<normalizedUrl>": { hash, etag, lastModified, lastSeen } }  // lastSeen: informational only, không prune ở v2.0
```

**Envelope & format (khoá):**

- Payload mặc định = `markdown`; flag tường minh `--text`/`--html` **luôn thắng**; content-type áp khi không có flag: JSON → payload `json` (đã parse), PDF → payload `text` (unpdf). Envelope: `{url, finalUrl, title, status, via, hopped, ms, <payload>}`; `title` từ `<title>` (jsdom hoặc `page.title()`), `null` cho payload phi-HTML.
- `--raw` in payload trần thay envelope; `--out F` ghi đúng format đã chọn (envelope mặc định). `--max-bytes` (mặc định 200000): chế độ envelope chỉ cắt **trường payload** (envelope vẫn là JSON hợp lệ) + stderr warning trỏ `--out`; `--raw` cắt byte như cũ; không bao giờ áp cho file crawl.
- `search` in bare array `[{title,url,snippet}]`; `search --scrape` in **một envelope JSON mỗi dòng** (JSONL). `map` thuần stdout: không ghi file, không đụng state. `extract` element = `{text, href?}` — `text` từ `textContent` trim (jsdom KHÔNG có innerText!), cap 300 ký tự / 500 phần tử; leo browser theo đúng predicate bị-chặn của fetch (403/429/BLOCK_PAT), **không** leo vì "0 match".
- `--wait-for SELECTOR` và `--screenshot FILE` **ép rung browser**; screenshot `fullPage: true` mặc định.

## 5. CLI surface

```bash
opencrab.js scrape URL [--raw|--text|--html] [--out F] [--max-bytes N]
            [--wait-for SELECTOR] [--screenshot F] [--stealth]
opencrab.js crawl URL --out DIR/ [--limit 50] [--depth 2] [--delay 1500]
            [--include G] [--exclude G] [--resume] [--changed-only] [--aggressive]
opencrab.js map URL [--limit 500] [--depth 3]        # → JSON [{url,title}]
opencrab.js search "q" [--limit 10] [--scrape]       # → [{title,url,snippet}] (+scrape từng kết quả)
opencrab.js extract URL --selector name=CSS [--selector name2=CSS2]   # → {"name":[...]}
# watch: phase 2 — vòng lặp mỏng trên crawl --changed-only + state
```

- `crawl` **bắt buộc** `--out DIR`; stdout chỉ in summary cuối (n ok / n failed / n http / n unchanged(304) / n skipped-robots / n dup / path index).
- `--resume` trên DIR có index của **seed khác** → error exit 2.
- Exit 1 iff có dòng index `status ∈ {blocked, error:*}`; `http:NNN` (kể cả 304) vào bucket `n http`/`n unchanged`, **không** phải failure; robots-block-all → exit 0.
- Exit codes: `0` ok · `1` một phần/bị chặn · `2` usage/setup (kể cả pidfile conflict).
- `package.json`: `engines: {node: ">=18"}`, `bin: {opencrab: "scripts/opencrab.js"}` (shebang + chmod +x), `cloakbrowser` chuyển sang `optionalDependencies` (không kéo 200MB theo mỗi install).

## 6. Crawl engine

1. **Normalization trước enqueue**: strip `#fragment`, `utm_*`/`fbclid`, resolve relative, host lowercase, strip trailing-slash trừ root. Dedup frontier bằng Set fingerprint. **Depth**: seed = 0, link trên trang depth-d → d+1, URL từ sitemap → depth 1; `--limit` đếm số trang *được fetch*.
2. **Sitemap discovery**: thử `/sitemap.xml` + dòng `Sitemap:` trong robots.txt (curl trước); URL từ sitemap **lọc same-host** trước khi enqueue.
3. **Same-host**: so **hostname chính xác** (ponytail: không PSL/eTLD+1 tới khi mục tiêu thật cần; www↔apex là 2 host khác nhau). Allowed host = host của `finalUrl` của seed (chốt 1 lần sau khi fetch seed). Enqueue iff host(normalized link) == allowed host. Trang có `finalUrl` lệch host: vẫn ghi file/index nhưng **không đóng góp link**.
4. **Robots**: parse chỉ group `User-agent: *`; robots 404/lỗi fetch → cho phép tất cả. `isAllowed()` dùng chung cho crawl/map/search --scrape; **KHÔNG áp cho `scrape`/`extract` đơn URL** (bản chất công cụ là fetcher chống bot-wall; pattern Reddit `.json` phụ thuộc việc này). UA giữ spoofed mọi rung — leo thang theo thiết kế. **Delay rule (một công thức)**: per-request delay = `--aggressive` ? (`--delay` ?? 0) : max(`--delay` ?? 1500, min(crawlDelay, 30s)); khi bị cap 30s in stderr warning. `--aggressive` = bỏ cổng robots + bỏ delay mặc định.
5. **File layout**: trang ok → `DIR/<sha1(normalizedUrl)>.md` chứa payload mặc định (markdown; PDF → `.txt` chứa text unpdf); `file` = path tương đối DIR; robots/dup/unchanged **không ghi file**. **Exact content dedup**: hash trùng → skip write (ghi dòng index `status:'dup'`).
6. **`--resume`**: bỏ qua URL đã `ok`/`http:304` trong index. **`--changed-only`**: rung curl gửi `If-None-Match`/`If-Modified-Since` từ state (304 → skip hẳn, ghi dòng `http:304`); không 304 hoặc rung browser → fetch, so hash, **skip ghi** nếu không đổi.
7. Cookie lapse giữa chừng → ghi status, tiếp tục, không retry-storm.
8. **`--include/--exclude`**: glob naive → RegExp (`*`→`.*`, `?`→`.`) match trên **URL tuyệt đối đã normalize**; không thêm dep — ponytail: ceiling chấp nhận, thay picomatch khi cần thật.

## 7. Markdown pipeline

- Đường duy nhất: HTML → **jsdom** → Readability (thất bại/kết quả quá ngắn < 200 ký tự → fallback full-body) → turndown → markdown.
- ponytail: jsdom parse ~1–3s/trang HTML lớn — chấp nhận ở limit 50; nếu crawl chậm thật, nâng cấp = chạy Readability in-page (`addScriptTag`) cho rung browser, jsdom chỉ còn rung curl.
- Rung curl lẫn browser chạy cùng đường (browser lấy `page.content()`).
- PDF: content-type `application/pdf` → unpdf → text (không OCR; PDF scan không text-layer → báo rõ stderr, không ghi file rỗng).

## 8. Rebrand (không cosmetic)

- Package/repo/dir/dev-remote → `opencrab` v2.0.0; GitHub rename làm thủ công bởi user.
- **SKILL.md description phải giữ cả hai bề mặt trigger**: triệu chứng bot-blocked (403, captcha, "network security") LẪN động từ crawl/scrape/search — nếu mất một trong hai, skill ngừng kích hoạt đúng.
- **Xoá `~/.pi/agent/skills/blocked-fetch` khi install opencrab** — 2 skill cùng trigger sẽ đánh nhau.
- Profile browser: dời hẳn vào `~/.local/state/opencrab/profile{,-stealth}` (cùng lý do tmpfiles với state — cookie là asset đắt nhất, không để nơi bị xén); migrate-on-first-run từ `~/.cache/blocked-fetch-profile*` nếu còn.
- Env: `BLOCKED_FETCH_BROWSER` → `OPENCRAB_BROWSER` (không giữ alias); `CLOAKBROWSER_*` giữ nguyên (của dependency).

## 9. Testing

- Fixture `testdata/` + `python3 -m http.server` (python 3.14 có sẵn — đã verify):
  - 4 trang liên kết nhau + `robots.txt` (chặn 1 path + dòng `Crawl-delay: 5`) + **1 trang body khớp BLOCK_PAT** + **1 trang tiếng Việt** (readability diacritics) + **1 PDF nhỏ có text-layer**.
  - Kỳ vọng BLOCK_PAT page: fixture chạy với `OPENCRAB_HOP=off` (lib coi hop không khả dụng — **zero network call**, không đốt rate-limit IP vào DDG/Bing mỗi selftest) → escalation curl→browser xảy ra (log line), status cuối `'blocked'`, exit 1 — assertion deterministic cho nửa dưới của ladder. Bản test hop thật nằm ở selftest-live.sh.
- `selftest.sh` = fixture tests (deterministic, offline) làm mặc định; các check live (Reddit/hop/stealth) tách `selftest-live.sh` chạy tay.
- Verify per bước implementation: map đủ 4 link + bỏ link robots; crawl sinh đúng file + index; crawl tôn trọng Crawl-delay fixture; scrape envelope chứa heading; scrape PDF → envelope chứa text; extract selector JSON đúng; --resume bỏ qua URL đã ok; --changed-only chạy 2 lần → lần 2 skip ghi toàn bộ.

## 10. Phasing

- **v2.0**: refactor lib + contracts + scrape/crawl/map/search/extract + state/resume/changed-only + PDF + screenshot/wait-for + pidfile + fixture tests + rebrand + SKILL.md/README.
- **v2.1**: `watch` (vòng lặp định kỳ trên crawl --changed-only, summary diff), `--action` engine (chỉ khi có site thật cần click/type).

## 11. Rủi ro còn mở

- CloakBrowser free tier 1 session — chưa test BFS 50 trang giữ session (fallback: `--resume`; test thủ công khi implement).
- Readability trên trang phi-bài (listing/dashboard) có thể strip bảng — envelope + steer-to-`extract` giảm nhẹ, không triệt để (documented).
- Selector drift ở DDG/Bing làm hỏng `search`/hop theo thời gian — giữ chuỗi 3 engine, best-effort.
- Pidfile fail-fast: scrape song song với crawl đang giữ browser → exit 2 (không xếp hàng) — trade-off chấp nhận cho dùng cá nhân, ghi rõ README.
- jsdom perf ceiling (đã đánh dấu ponytail §7).

---

## Appendix A — Council Pass 1 (đã hội tụ, không cần Pass 2)

**Roster (fallback, không có profile council-\*)**: `oracle` run e5053ce8 (fork — có ngữ cảnh cha) · `reviewer` run ce6c3dd1 (context runtime-default) · `researcher` run 9f00e995 (context runtime-default). Workflow 933895b4. Pass cap 2, dừng ở pass 1 vì các điểm còn lại là owner decision, không phải claim giải quyết được bằng bằng chứng.

**Chấp nhận** (gộp vào spec §3–§9): 13 điểm đồng thuận — contracts khoá trước, page.content() thêm ở browser rung, URL normalization + request dedup, hash dedup + --resume, map=linksOnly crawlBFS, cấm process.exit trong lib + guard stdout-only, robots trong lib + Crawl-delay cap, fixture BLOCK_PAT + Việt ngữ, state ở ~/.local/state, SKILL.md hai bề mặt trigger + xoá skill cũ, --wait-for/--screenshot, danh sách SKIP, APPROVE không pivot.

**Bác, có lý do**:

1. researcher: robots + honest UA `opencrab/2.0` cho mọi lệnh kể cả scrape đơn → **bác**: mâu thuẫn bản chất fetcher chống bot-wall; Reddit `.json` chết nếu tuân robots ở scrape. Robots giữ bulk-only.
2. reviewer giả định jsdom đi kèm readability → **sai đã verify** (`@mozilla/readability` zero runtime-dep) → jsdom trở thành dep tường minh thứ 3.

**Owner decisions**: D1–D6 ở §2 (user chốt 2026-08-28, theo khuyến nghị council/parent).

**Điều kiện đổi quyết định** (change-my-mind gộp): mục tiêu chính là PDF/doc nhiều hơn HTML → mở rộng nhánh document; crawl thường xuyên >200 trang/run → nâng checkpoint thành crawl-state đầy đủ + pacing theo host; agent khác cần drop-in API Firecrawl → thêm HTTP shim ~50 dòng phase 3.

**Confidence**: high (cả 3 advisor; repo đã đọc trực tiếp; 5 crawler đối chiếu theo docs chính thức; chỉ 2 unknown runtime — CloakBrowser session longevity, readability phi-bài — đều test khi implement).

## Appendix B — Adversarial loop log

- **Vòng 1** (parent tự tấn công): 20 lỗ hổng → v1.1 (commit 9c9982f).
- **Vòng 2** (2 reviewer fresh-context, run f4b6b2ee contracts + 0126ccc4 ops, verdict FIX_FIRST × 2): ~19 findings material, tất cả sửa trong v1.2 — file layout crawl + hash payload-bytes (hết tính tuần hoàn), công thức delay/aggressive một dòng, same-host predicate + redirect semantics, payload precedence (flag > content-type; PDF→text; title null phi-HTML), etag/lastModified/bytes Buffer vào contract + 304 = index row không failure, selftest offline bằng OPENCRAB_HOP=off, wrapper compat rõ ràng (env alias ở wrapper, --selector→extract, 2s giữ nguyên), index null-semantics + schema dòng đầu, bucket n http/n unchanged, --max-bytes cắt payload-field trong envelope mode, extract element textContent + predicate leo browser (không leo khi 0 match), glob match URL đã normalize, sitemap depth 1, lastSeen informational, pidfile cả 2 entrypoint + giữ killProfileOrphans scoped, retry 429 vào contract, cloakbrowser → optionalDependencies, profile dời ~/.local/state, map thuần stdout, searchResults/extractLinks contract khoá.
- **Vòng 3**: đang chờ kết quả.
