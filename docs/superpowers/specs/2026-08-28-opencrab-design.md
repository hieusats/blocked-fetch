# opencrab v2.0 — Design Spec

Ngày: 2026-08-28 · Phiên bản spec: v1.12 (adversarial vòng 11 đã sửa) · Nền: council 3-advisor (Appendix A) + vòng lặp tấn công (Appendix B)

## 1. Mục tiêu & phi mục tiêu

**Mục tiêu:** biến blocked-fetch (skill fetch 1 URL qua thang chống-bot) thành **opencrab** — công cụ crawl/scratch địa phương miễn phí cho AI agent, thay các API crawl trả phí (Firecrawl, SerpAPI...) ở quy mô cá nhân.

**Phi mục tiêu:** HTTP server/API, quy mô công nghiệp (sequential politeness là chủ ý), LLM nhúng trong CLI, dep có native binding, simhash/persistent-queue/AutoThrottle/OCR.

**Ràng buộc:** miễn phí, local, Node.js, một máy, dùng cá nhân.

## 2. Quyết định sản phẩm (owner, đã chốt 2026-08-28)

| # | Quyết định | Lựa chọn |
| --- | --- | --- |
| D1 | Output mặc định của `scrape` | **JSON envelope** đúng định nghĩa ở §4 (payload mặc định `markdown`); `--raw` in payload trần |
| D2 | PDF | **unpdf** (zero-dep) khi content-type `application/pdf` |
| D3 | Watch/incremental | **State store + `--resume` + `--changed-only` vào v2.0**; watch phase 2 chỉ là vòng lặp mỏng |
| D4 | P1 riders | Thêm **`--screenshot FILE`** + **`--wait-for SELECTOR`** |
| D5 | Interface | CLI thuần (không HTTP) — chốt từ trước council |
| D6 | Etiquette | Lịch sự mặc định (robots cho lệnh bulk, delay, `--aggressive` bypass) |

## 3. Kiến trúc — cấu trúc file

```text
scripts/
  fetch.js        # wrapper backcompat — stdout GIỮ ĐÚNG FORMAT CŨ (không envelope):
                  #   mặc định → thân thô (giữ bước compact-if-JSON của fetch.js cũ;
                  #   PDF → payload text theo §4, như --out);
                  #   --text → text trần; --selector CSS → extract (name "elements",
                  #   bare array, ÉP RUNG BROWSER như fetch.js cũ — qua opts.forceBrowser);
                  #   --out → file = đúng bytes stdout cũ (blocked/error → **không ghi file**; PDF là ngoại lệ documented:
                  #   payload text theo §4 — bytes PDF thô không còn đường nào ra);
                  #   --max-bytes → cắt byte thô như cũ; non-200 → body nếu có, ngược lại "(http N)" (khớp v1); blocked → stdout rỗng + stderr hint + exit 1; error:msg → stdout rỗng + stderr msg + exit 1 (exit-0-silent-error của v1 là bug, sửa documented); --wait MS → opts.waitMs;
                  #   --stealth/--text/--out 1:1; urls[] → scrape tuần tự (2s giữa URL);
                  #   BLOCKED_FETCH_BROWSER→OPENCRAB_BROWSER (alias chỉ tồn tại trong wrapper)
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
- `extract` chạy selector qua DOM (jsdom) trên HTML của rung curl; chỉ leo browser khi **bị chặn theo predicate §4** (không leo vì 0 match, không có tiêu chí "cần JS").
- Dep (đều pure-JS): `playwright-core`, `cloakbrowser` (optional), `@mozilla/readability`, `turndown`, `jsdom`, `unpdf`.
- **Pidfile lazy** (`$OPENCRAB_STATE_DIR/browser.pid`, mặc định `~/.local/state/opencrab/browser.pid`): acquire đúng lúc lần đầu cần launch browser profile — rung curl thuần không bao giờ lock (scrape trang tĩnh song song với crawl nền vẫn chạy). Cả 2 entrypoint dùng chung cơ chế; invocation đã giữ lock → fail-fast exit 2. SIGKILL chỉ áp cho pid stale. Giữ **killProfileOrphans scoped** (match đúng `--user-data-dir=` profile opencrab, không đụng browser thật) cho case chromium mồ côi sau crash. Handler SIGINT/SIGTERM gọi `fetcher.close()`.

## 4. Contracts — khoá trước khi code

**`fetch(url, opts) →`**

```js
{ ok: boolean, status: 'ok'|'blocked'|'http:NNN'|'error:msg',
  via: 'curl'|'browser'|'stealth', hopped: boolean, finalUrl,
  contentType, etag, lastModified, bytes, html, text, ms }
```

- `opts = { stealth, waitMs (settle, mặc định 1500), waitFor (selector; timeout 30s → proceed + stderr), screenshot (path), conditional: { etag, lastModified }, forceBrowser (chỉ wrapper dùng cho --selector cũ) }` — chỉ thế; robots/delay/limit là trách nhiệm caller (crawl engine).
- **Predicate bị chặn/leo thang (định nghĩa MỘT LẦN, mọi lệnh dùng chung)**: HTTP ∈ {403, 429, 503} hoặc `BLOCK_PAT.test(body.slice(0, 4096))` (cửa sổ prefix thống nhất — v1 dùng 800/500 lệch nhau giữa 2 rung).
- Rung curl: body > 32MB (maxBuffer kế thừa fetch.js) → coi rung curl thất bại, leo browser + stderr note.

- `status` của fetch **không** có `'robots'` — robots là cổng phía caller (crawl engine) chạy trước khi gọi fetch; `'robots'`/`'dup'` chỉ xuất hiện ở dòng index.jsonl.
- `error:msg` = exception đã sanitize, msg cap 200 ký tự (không process.exit trong lib).
- `via` = rung thành công cuối; nếu không rung nào thành công (blocked/error) = **rung cuối được thử** (không bao giờ null). `ok` ≡ (`status === 'ok'`). `hopped:true` = đã đi search-hop trước đó.
- `contentType`, `etag`, `lastModified` bắt ở cả 2 rung (curl: `-D` dump header rồi parse; browser: response headers) — quyết định nhánh PDF/JSON/markdown và nuôi INM/304.
- `bytes` = Buffer thân phản hồi gốc — curl rung đọc buffer (không utf8-string hóa; PDF/latin-1 nguyên vẹn tới unpdf); browser rung: `resp.body()` nếu có, fallback `Buffer.from(page.content())`. `html`/`text` là chuỗi suy ra cho content-type text; `text` = innerText (browser) | htmlToText(html) (curl).
- Retry: rung browser gặp 429 → backoff 10s, retry đúng 1 lần (giữ hành vi fetch.js); không retry nào khác.
- Browser rung bắt **cả `page.content()` (html) lẫn innerText** — không thì readability/extract chết ở đúng mục tiêu khó.

**Dòng index.jsonl** (mỗi trang 1 dòng, JSON append; `hash` = sha256 hex của **bytes payload suy ra** (chuỗi markdown/text/json) — deterministic, dùng chung cho dedup + state kể cả khi không ghi file; `status` ngoài enum của fetch còn `'robots'` (bỏ vì robots), `'dup'` (nội dung trùng URL khác) và `'unchanged'` (fetch rồi, hash không đổi); trường không có giá trị = `null`, không omit; dòng đầu = `{"seed":"<normalized url>","ts":<ms>}` (seed đã normalize — chống false-positive khi `--resume` đối chiếu); robots/dup/304 **không** tính là failure; 304 ghi dòng `http:304` — để `--resume` thấy là done):

```js
{ url, finalUrl, file, title, hash, status, via, ms, ts }
```

`url` = URL **đã normalize** (cùng khóa với state `<normalizedUrl>` và tên file `<sha1(normalizedUrl)>` — một nguồn khóa duy nhất); `finalUrl` = URL đã resolve (cũng đã normalize).

**State store** `~/.local/state/opencrab/state/<host>.json` (`<host>` = **allowed host của run** — host của `finalUrl` seed, §6.3; KHÔNG `~/.cache` — tmpfiles xén cache ~10 ngày); override bằng `OPENCRAB_STATE_DIR` (selftest trỏ vào `mktemp -d` để idempotent giữa các lần chạy):

```js
{ "<normalizedUrl>": { hash, etag, lastModified, lastSeen } }  // lastSeen: informational only, không prune ở v2.0
```

Ghi atomic (tmp + rename); SIGINT/SIGTERM flush dòng index đang bay trước khi `close()`; đọc state JSON hỏng → coi như rỗng + stderr note.

**Envelope & format (khoá):**

- Payload mặc định = `markdown`; flag tường minh `--text`/`--html` **luôn thắng** (giá trị: `--text` → htmlToText(html) cho HTML / unpdf text cho PDF / htmlToText(raw) cho JSON — kế thừa v1; `--html` → chuỗi HTML gốc, nguồn phi-HTML (JSON/PDF) → `null`); content-type áp khi không có flag — matcher pin MỘT NƠI ở đây: **JSON = content-type chứa `json`** (kể cả suffix `+json` như `application/ld+json`), **PDF = content-type chứa `application/pdf`** (miễn nhiễm param suffix như `; charset=`), còn lại → HTML path: JSON → payload `json` (đã parse; parse thất bại → xử như HTML, payload markdown + stderr note; **chuỗi chuẩn để hash / ghi file `.json` / `--raw` = raw response body** — parse chỉ để dựng envelope object, chống server reformat JSON làm giả "changed"), PDF → payload `text` (unpdf). Envelope: `{url, finalUrl, title, status, via, hopped, ms, <payload>}` — `url` = URL như gọi lệnh (raw), `finalUrl` = đã resolve; `<payload>` là **đúng một khóa tên loại** (`markdown`|`text`|`html`|`json`); envelope không-ok → payload = `null`; mọi trường không có giá trị = `null` (không omit, như index row); `title` từ `<title>` (jsdom hoặc `page.title()`) — `null` iff **nguồn** (content-type) không phải HTML, không phụ thuộc payload flag.
- `--raw` in payload trần thay envelope (payload `null` → stdout rỗng); `--out F` ghi đúng format đã chọn (envelope mặc định). `--max-bytes` (mặc định 200000): chế độ envelope chỉ cắt **trường payload — N ký tự của chuỗi payload** (envelope vẫn là JSON hợp lệ) + stderr warning trỏ `--out`; `--raw` cắt byte như cũ; không bao giờ áp cho file (scrape `--out` lẫn file crawl).
- `search` in bare array `[{title,url,snippet}]`; `search --scrape` in **một envelope JSON mỗi dòng** (JSONL). `map` thuần stdout: không ghi file, không đụng state. `extract` element = `{text, href?}` — `text` từ `textContent` trim (jsdom KHÔNG có innerText!; browser rung cũng dùng `textContent` — lệch whitespace với `innerText` v1 là deviation documented của wrapper), cap 300 ký tự / 500 phần tử; leo browser theo đúng **predicate bị-chặn của §4** (không liệt kê lại ở đây — một nguồn chân lý), **không** leo vì "0 match".
- `--wait-for SELECTOR` và `--screenshot FILE` **ép rung browser**; screenshot `fullPage: true` mặc định, **ghi file bất kể status cuối** (kể cả blocked — chính là bằng chứng debug bot-wall); `--wait-for` timeout 30s → **proceed** (không fail) + stderr note.

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

- `crawl` **bắt buộc** `--out DIR`; stdout chỉ in summary cuối (n ok / n failed / n http / n unchanged (gồm 304 + fetched-unchanged) / n skipped-robots / n dup / n resumed / path index).
- `--resume` trên DIR có index của **seed khác** → error exit 2.
- Exit 1 iff **dòng index của lần chạy hiện tại** có `status ∈ {blocked, error:*}` (dòng cũ từ run trước không tính — `--resume` trên DIR có dòng blocked cũ không tự exit 1); `http:NNN` (kể cả 304) vào bucket `n http`/`n unchanged`, **không** phải failure; robots-block-all → exit 0. `scrape`/`extract`: exit 1 iff status ≠ ok (giữ hành vi fetch.js cũ). `map`: trang blocked/error bị **bỏ khỏi mảng stdout** + stderr note; exit 1 iff ≥1 trang fetch bị blocked/error:* (robots-skip không tính). `search` throw (cả 3 engine bị challenge) → stderr + exit 1; `search --scrape`: exit 1 iff throw HOẶC envelope nào status ≠ ok; delay cố định 1500ms giữa các kết quả.
- Exit codes: `0` ok · `1` một phần/bị chặn · `2` usage/setup (kể cả pidfile conflict). Cơ chế thoát: bin + wrapper set `process.exitCode` rồi return — **không bao giờ `process.exit()` khi stdout còn treo** (fetch.js cũ truncate envelope khi pipe — thay đổi documented).
- `package.json`: `engines: {node: ">=18"}`, `bin: {opencrab: "scripts/opencrab.js"}` (shebang + chmod +x), `cloakbrowser` chuyển sang `optionalDependencies` (không kéo 200MB theo mỗi install).

## 6. Crawl engine

1. **Normalization trước enqueue**: normalize = parse qua `new URL()` (WHATWG, Node ≥18), áp mutation trên URL object, serialize bằng `.href` (giết residue dangling-`?`/default-port/percent-encoding); mutation: strip `#fragment`, `utm_*`/`fbclid`, resolve relative, host lowercase, strip trailing-slash trừ root. Dedup frontier bằng Set fingerprint. **Depth**: seed = 0, link trên trang depth-d → d+1, URL từ sitemap → depth 1; **link chỉ extract từ trang fetch có `status:'ok'`** (trang 404/blocked không đóng góp link); `--limit` đếm mọi trang **được gọi fetch** (kể cả 304).
2. **Sitemap discovery**: thử `/sitemap.xml` + dòng `Sitemap:` trong robots.txt (curl trước); URL từ sitemap **lọc same-host** trước khi enqueue. **Seed fetch không `ok` → ghi header + dòng status của seed rồi kết thúc** (không sitemap, không BFS — allowed host không chốt được; dòng lỗi non-terminal nên `--resume` fetch lại seed).
3. **Same-host**: so **hostname chính xác** (ponytail: không PSL/eTLD+1 tới khi mục tiêu thật cần; www↔apex là 2 host khác nhau). Allowed host = host của `finalUrl` của seed (chốt 1 lần sau khi fetch seed). Enqueue iff host(normalized link) == allowed host. Trang có `finalUrl` lệch host: vẫn ghi file/index nhưng **không đóng góp link**.
4. **Robots**: parse chỉ group `User-agent: *`; robots 404/lỗi fetch → cho phép tất cả. `isAllowed()` dùng chung cho crawl/map/search --scrape; **KHÔNG áp cho `scrape`/`extract` đơn URL** (bản chất công cụ là fetcher chống bot-wall; pattern Reddit `.json` phụ thuộc việc này). UA giữ spoofed mọi rung — leo thang theo thiết kế. **Delay rule (một công thức, đơn vị ms)**: `crawlDelayMs = Crawl-delay(giây) × 1000`; per-request delay = `--aggressive` ? (`--delay` ?? 0) : max(`--delay` ?? 1500, min(crawlDelayMs, 30000)); khi bị cap 30000 in stderr warning. `--aggressive` = bỏ cổng robots + bỏ delay mặc định. `map` dùng cùng công thức.
5. **File layout**: trang ok → `DIR/<sha1(normalizedUrl)>.md` (payload markdown), `.txt` (PDF → text unpdf), `.json` (chuỗi JSON payload) — **bytes file ≡ chuỗi payload đã hash, không newline cuối**, mọi loại; `file` = path tương đối DIR; robots/dup/unchanged/resumed/http:304 **không ghi file**. PDF-scan (không text-layer): status `ok`, `file:null`, payload `text` rỗng, stderr warning — không phải failure. **Exact content dedup**: hash trùng URL khác → skip write (dòng `status:'dup'`); **payload rỗng (vd PDF-scan) → không tham gia so hash** (dedup lẫn unchanged) — ghi bình thường, `hash` = `null` (không ghi sha256('') giả trùng).
6. **`--resume`**: **frontier dựng từ mọi URL từng có dòng trong index cũ** (seed bị skip thì link không extract lại được — index là nguồn URL); **mỗi URL lấy dòng CUỐI CÙNG làm verdict** (last row wins — URL từng ok rồi blocked sẽ được fetch lại). URL có dòng cuối `status ∈ {ok, http:304, unchanged, robots, dup}` → terminal (mọi trạng thái phi-failure): không fetch lại, **không ghi dòng mới** — bucket: `ok`/`http:304`/`unchanged` → `n resumed`, `robots` → `n skipped-robots`, `dup` → `n dup` (memoized như robots); `{blocked, error:*, http≠304}` → fetch lại. `n resumed` chỉ đếm skip `ok`/`http:304`/`unchanged`. Dòng index parse lỗi (append đứt giữa chừng vì SIGKILL/mất điện) → bỏ dòng + stderr note (mirror rule state); **header dòng đầu hỏng → coi index như không tồn tại: fresh crawl + stderr note**. `--resume` trên DIR không có index → coi như fresh crawl + stderr note. **`--changed-only`**: rung curl gửi `If-None-Match`/`If-Modified-Since` từ state (304 → skip hẳn, ghi dòng `http:304`, bucket `n unchanged` — state **giữ hash cũ**, chỉ cập nhật etag/lastModified/lastSeen); không 304 hoặc rung browser → fetch, so hash: không đổi → dòng `status:'unchanged'` (bucket `n unchanged`, không ghi file), đổi → ghi bình thường. **304/resume-skip không có body → link cho BFS lấy từ dòng index cũ** (URL phái sinh enqueue toàn bộ, depth = depth(trang skip)+1 — ponytail: over-crawl khi `--depth` hẹp hơn run cũ; nâng cấp = ghi depth vào dòng index khi cần thật); body mới chỉ bổ sung link cho trang thực sự được fetch. **Crawl không cờ: không đọc state** — fetch vô điều kiện, mọi dòng thành công là `ok` (hash-compare chỉ tồn tại dưới `--changed-only`). **State ghi cho mọi dòng `ok`/`http:304`/`unchanged` của mọi lần crawl, bất kể cờ.**
7. Cookie lapse giữa chừng → ghi status, tiếp tục, không retry-storm.
8. **`--include/--exclude`**: glob naive → RegExp (`*`→`.*`, `?`→`.`) **anchor full-match `^pattern$`** trên **URL tuyệt đối đã normalize**; flag lặp lại được (OR trong cùng flag); seed **luôn** được fetch; bộ lọc áp cho link + URL sitemap khi enqueue — URL đi qua iff (match ≥1 include nếu có) AND (không match exclude nào); không thêm dep — ponytail: ceiling chấp nhận, thay picomatch khi cần thật.

## 7. Markdown pipeline

- Đường duy nhất: HTML → **jsdom** → Readability (thất bại hoặc `article.textContent.length` < 200 → fallback full-body) → turndown → markdown.
- ponytail: jsdom parse ~1–3s/trang HTML lớn — chấp nhận ở limit 50; nếu crawl chậm thật, nâng cấp = chạy Readability in-page (`addScriptTag`) cho rung browser, jsdom chỉ còn rung curl.
- Rung curl lẫn browser chạy cùng đường (browser lấy `page.content()`).
- PDF: content-type `application/pdf` → unpdf → text (không OCR; PDF scan không text-layer → status `ok`, payload `text` rỗng, `file:null`, stderr warning — thống nhất cho scrape lẫn crawl).

## 8. Rebrand (không cosmetic)

- Package/repo/dir/dev-remote → `opencrab` v2.0.0; GitHub rename làm thủ công bởi user.
- **SKILL.md description phải giữ cả hai bề mặt trigger**: triệu chứng bot-blocked (403, captcha, "network security") LẪN động từ crawl/scrape/search — nếu mất một trong hai, skill ngừng kích hoạt đúng.
- **Xoá `~/.pi/agent/skills/blocked-fetch` lúc install opencrab**: postinstall script tự xoá nếu thấy + log; README ghi lệnh fallback thủ công — 2 skill cùng trigger sẽ đánh nhau.
- Profile browser: `$OPENCRAB_STATE_DIR/profile{,-stealth}` (mặc định `~/.local/state/opencrab/profile{,-stealth}` — cùng cơ chế override với pidfile nên hai selftest song song không chung profile; cùng lý do tmpfiles: cookie là asset đắt nhất, không để nơi bị xén); migrate-on-first-run từ `~/.cache/blocked-fetch-profile*` (nguồn giữ nguyên literal) — copy → tmp → rename (atomic, crash giữa chừng không tạo profile nửa vời).
- Env: `BLOCKED_FETCH_BROWSER` → `OPENCRAB_BROWSER` (lib không giữ alias — **wrapper dịch `BLOCKED_FETCH_BROWSER` sang `OPENCRAB_BROWSER` như §3**; cùng set cả hai thì `OPENCRAB_BROWSER` thắng); `CLOAKBROWSER_*` giữ nguyên (của dependency).

## 9. Testing

- Fixture `testdata/` + `python3 -m http.server` (python 3.14 có sẵn — đã verify):
  - **Manifest (khoá)**: `index.html` (seed) link → `a.html`, `b.html`, `c.html`, `d.html` (d = tiếng Việt) + `blocked.html` (robots-disallow path, body khớp BLOCK_PAT, link từ index — test robots-skip ở crawl/map VÀ escalation khi scrape trực tiếp); `doc.pdf` truy cập trực tiếp (không link). `robots.txt`: `Disallow: /blocked.html` + `Crawl-delay: 5`.
  - Kỳ vọng BLOCK_PAT page: fixture chạy với `OPENCRAB_HOP=off` (lib coi hop không khả dụng — **zero network call**, không đốt rate-limit IP vào DDG/Bing mỗi selftest) → escalation curl→browser xảy ra (log line), status cuối `'blocked'`, exit 1 — assertion deterministic cho nửa dưới của ladder. Bản test hop thật nằm ở selftest-live.sh.
- `selftest.sh` = fixture tests (deterministic, offline) làm mặc định; các check live (Reddit/hop/stealth) tách `selftest-live.sh` chạy tay. Server fixture: `python3 -m http.server 0` (port ephemeral parse từ stderr — không đụng port 8000 của dev server), `trap 'kill $SRV_PID 2>/dev/null; rm -rf $STATE_DIR' EXIT` (không leak process/state).
- Verify per bước implementation: map = 5 hàng, blocked bị bỏ; crawl = **5 file (kể cả seed) + index + 1 skipped-robots, exit 0**; inter-request ≥ 5000ms (Crawl-delay fixture); scrape envelope chứa heading; scrape `blocked.html` → `blocked`, exit 1; scrape `doc.pdf` → envelope chứa text PDF; extract JSON đúng shape; `--resume` → `n resumed` = **5** + `n skipped-robots` = 1 (memo), **không dòng index mới**; `--changed-only` chạy 2 lần → lần 2 toàn bộ `unchanged`; selftest export `OPENCRAB_STATE_DIR=$(mktemp -d)`.

## 10. Phasing

- **v2.0** (một release, 3 mốc land tuần tự, mỗi mốc có verify-list riêng từ §9):
  - **S1**: lib/fetcher (contracts §4) + wrapper fetch.js + `scrape` + fixture cốt lõi (BLOCK_PAT/robots/vi) — verify: các kỳ vọng scrape của §9.
  - **S2**: `crawl` + `map` + state/resume/changed-only — verify: crawl/map/resume/changed-only của §9.
  - **S3**: `search` + `extract` + PDF + screenshot/wait-for + pidfile lazy + migrate profile + rebrand + SKILL.md/README — verify: phần còn lại của §9.
- **v2.1**: `watch` (vòng lặp định kỳ trên crawl --changed-only, summary diff), `--action` engine (chỉ khi có site thật cần click/type).

## 11. Rủi ro còn mở

- CloakBrowser free tier 1 session — chưa test BFS 50 trang giữ session (fallback: `--resume`; test thủ công khi implement).
- Readability trên trang phi-bài (listing/dashboard) có thể strip bảng — envelope + steer-to-`extract` giảm nhẹ, không triệt để (documented).
- Selector drift ở DDG/Bing làm hỏng `search`/hop theo thời gian — giữ chuỗi 3 engine, best-effort.
- Pidfile fail-fast: lệnh **cần browser** chạy song song với crawl đang giữ browser → exit 2 (không xếp hàng; rung curl thuần không bị ảnh hưởng) — trade-off chấp nhận cho dùng cá nhân, ghi rõ README.
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
- **Vòng 3** (impl-tdd reviewer b45ca03f + oracle-drift 184240ce, FIX_FIRST × 2): 24 findings — đáng kể: code block §4 thiếu 3 trường (artifact vòng 2: sửa bullets, quên block), `opts` surface chưa định nghĩa, pidfile over-reach (khóa cả rung curl) → lazy acquire, v2.0 monolith → slice S1/S2/S3, đơn vị giây→ms của Crawl-delay, wrapper stdout-format table, JSON file layout crawl, fixture manifest khoá + `OPENCRAB_STATE_DIR` + `OPENCRAB_HOP=off`, bucket `n resumed` + status `unchanged`, PDF-scan status `ok` thống nhất (parent arbitrate giữa 2 advisor), exit code scrape/search, predicate leo thang chuẩn hoá {403,429,503}+BLOCK_PAT. Tất cả sửa trong v1.3.
- **Vòng 3.5** (parent fresh-eyes full-read): 3 chỉnh đính — crawl kỳ vọng 5 file thay vì 4 (seed cũng được fetch+ghi, khớp map 5 hàng), bỏ sót "cần JS" ở §3 (mâu thuẫn predicate §4), pidfile risk thêm điều kiện "cần browser".
- **Vòng 4** (crossref dfc9d80b + dryrun bcd75dc9, FIX_FIRST × 2): 18 findings — P1: wrapper --selector ép browser cũ (opts.forceBrowser), via khi mọi rung thất bại = rung cuối được thử, **resume frontier dựng từ index cũ + memo robots verdict** (không vậy §9 không đạt được), **304 không body → BFS link từ index cũ**; P2: `ok` ≡ status, khóa payload = tên loại + envelope không-ok null-semantics, map exit + bỏ hàng blocked khỏi stdout (parent arbitrate giữa 2 advisor), search --scrape exit tổ hợp, exit tính trên dòng run hiện tại, title null theo NGUỒN không theo flag, pidfile path tường minh, wrapper compact-if-JSON + PDF documented-change, payload rỗng không so hash, plain-crawl không đọc state, --resume không index = fresh. Tất cả sửa trong v1.4.
- **Vòng 5** (sysmiss d26e5aab, FIX_FIRST): 10 findings — P1: resume **last-row-wins** (URL nhiều dòng lịch sử), selftest port ephemeral + trap teardown, profile theo `$OPENCRAB_STATE_DIR` (2 selftest song song không SIGKILL browser nhau), state atomic tmp+rename + flush SIGINT + đọc hỏng = rỗng, cấm `process.exit()` khi stdout treo (bug truncate pipe kế thừa v1), wrapper mapping stdout cho blocked/error (exit-0-silent-error v1 = bug sửa documented); P2: seed dòng đầu normalized, maxBuffer 32MB ceiling + leo browser, --max-bytes không áp --out, migrate profile atomic. Tất cả sửa trong v1.5.
- **Vòng 6** (verify-hunt 912b18e5, FIX_FIRST): 8 findings — P1: tập verdict resume bỏ sót `unchanged`/`dup` (reachable qua changed-only → interrupt → resume); P2: state giữ hash cũ trên 304, depth URL phái sinh từ index (ponytail over-crawl), envelope.url = raw arg, wrapper non-200 in body nếu có (khớp v1), JSON parse-fail → HTML path, --raw payload null → stdout rỗng, payload rỗng → hash null. Tất cả sửa trong v1.6.
- **Vòng 7** (converge b62a382f, FIX_FIRST): 6 findings — P1: câu stale "n resumed chỉ đếm ok/http:304" sót lại cạnh mapping mới của chính R6 (patch-artifact); P2: dòng index parse lỗi → bỏ dòng + stderr (mirror state), link chỉ extract từ trang ok, extract textContent thống nhất cả browser rung (deviation documented so với innerText v1), chuỗi chuẩn JSON = raw body (quyết định hash/file/--raw), BLOCK_PAT cửa sổ prefix 4096 thống nhất. Tất cả sửa trong v1.7.
- **Vòng 7.5** (parent fresh-eyes): 3 chỉnh đính — bỏ liệt kê predicate trùng ở dòng extract (thiếu 503 so với chuẩn), danh sách không-ghi-file thêm `http:304`, pin `url` dòng index = normalized (một nguồn khóa với state + tên file).
- **Vòng 8** (final-gate 40ea9570, FIX_FIRST): 7 findings — P1: §3 vs §8 mâu thuẫn alias env (cùng quyết định khai báo 2 nơi, §8 không ai đọc lại từ vòng 1); P2: wrapper stdout PDF, seed không ok → dừng (không sitemap/BFS), đo readability trên `article.textContent.length`, giá trị --text/--html trên nguồn phi-HTML, screenshot ghi bất kể status, header index hỏng = fresh crawl. Tất cả sửa trong v1.8.
- **Vòng 9** (clause-sweep 2fffc922, FIX_FIRST, confidence medium — đang nạo đáy): 4 findings — P1: seed-fail không pin có dòng index hay không (artifact R8); P2: --limit tính cả 304, wrapper blocked/error không ghi --out, seed miễn nhiễm --include/--exclude. Tất cả sửa trong v1.9.
- **Vòng 10** (clause-sweep-2 84ad7cac, FIX_FIRST, 1 finding duy nhất): P2 — matcher content-type JSON chưa pin (`includes('json')` vs `===` — phân kỳ payload/file/hash/dedup trên `application/ld+json`). Sửa v1.9.1: matcher pin một nơi ở §4 (JSON = chứa `json` kể cả `+json`; PDF = `application/pdf`; còn lại HTML).
- **Vòng 11** (closing 02009ed3, 5 P2, 0 P0/P1 — 3 vòng liên tiếp không P1): serializer normalization (WHATWG `.href`), anchor full-match glob, PDF matcher miễn nhiễm param-suffix (mirror JSON), đơn vị cắt max-bytes = ký tự, `<host>` state = allowed host. Lưu ý phương pháp: tỷ lệ finding nhảy 1→5 dù toàn one-liner → residue lớp "chưa pin một dòng" gần như vô hạn với mắt tươi; vòng 12 chốt với bar sắc lại (chỉ chặn finding phân kỳ hành vi thật).
- **Vòng 12**: đang chờ — vòng đóng.
