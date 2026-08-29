// lib/crawl.js — BFS engine + robots + index + state (spec §6)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fetch, extractLinks, close, SetupError } = require('./fetcher');
const { toMarkdown, pdfToText } = require('./md');

const ctJson = ct => /json/i.test(ct), ctPdf = ct => /application\/pdf/i.test(ct);

function normalizeUrl(u) {
  const url = new URL(u);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const k of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid)$/i.test(k)) url.searchParams.delete(k);
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// robots: chỉ group 'User-agent: *' (ponytail: naive — không Allow/Disallow precedence đầy đủ)
async function loadRobots(origin) {
  const r = await fetch(origin + '/robots.txt');
  if (!r.ok) return { allowed: () => true, crawlDelayMs: 0, sitemaps: [] };
  const txt = r.bytes.toString('utf8');
  const lines = txt.split(/\r?\n/).map(l => l.trim());
  const group = []; let inStar = false; const sitemaps = []; let delay = 0;
  for (const l of lines) {
    const m = l.match(/^(user-agent|disallow|allow|crawl-delay|sitemap):(.*)$/i);
    if (!m) continue;
    const [, k, v] = m; const val = v.trim();
    if (/^user-agent$/i.test(k)) inStar = val === '*';
    else if (/^sitemap$/i.test(k) && val) sitemaps.push(val);
    else if (inStar && /^crawl-delay$/i.test(k)) delay = parseFloat(val) || 0;
    else if (inStar && /^(disallow|allow)$/i.test(k)) group.push([/^disallow$/i.test(k) ? 'd' : 'a', val]);
  }
  return { allowed: p => { // ponytail: longest-match, không full Allow/Disallow precedence
    let bestLen = 0, bestAllow = true;
    for (const [t, v] of group) if (v && p.startsWith(v) && v.length >= bestLen) { bestLen = v.length; bestAllow = t === 'a'; }
    return bestLen === 0 || bestAllow; }, crawlDelayMs: delay * 1000, sitemaps };
}

function globRe(g) { return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); }

async function derivePayloadAndHash(r) { // → {ext, str}
  const html = r.html ?? r.bytes.toString('utf8');
  if (ctPdf(r.contentType)) return { ext: '.txt', str: await pdfToText(r.bytes).catch(() => '') };
  if (ctJson(r.contentType)) return { ext: '.json', str: r.bytes.toString('utf8') }; // raw body (spec §4)
  return { ext: '.md', str: toMarkdown(html) };
}

async function crawlBFS(seedRaw, o) {
  const linksOnly = !!o.linksOnly;
  const pages = []; // linksOnly: [{url,title}]
  const outDir = linksOnly ? null : o.outDir;
  const indexPath = linksOnly ? null : path.join(outDir, 'index.jsonl');
  if (!linksOnly && o.resume && !fs.existsSync(indexPath)) { console.error('[#] no index — fresh crawl'); o.resume = false; }
  if (!linksOnly) fs.mkdirSync(outDir, { recursive: true });
  const seed = normalizeUrl(seedRaw);
  // index cũ: last-row-wins — resume dùng full (frontier + verdicts); --changed-only KHÔNG --resume vẫn cần links khi 304 (304 không có body)
  const lastRow = new Map(); let oldSeed = null; let headerBad = false;
  if (!linksOnly && fs.existsSync(indexPath)) {
    const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean);
    try { const h = JSON.parse(lines[0]); oldSeed = h.seed; } catch { headerBad = true; }
    for (const l of lines.slice(headerBad ? 0 : 1)) {
      try { const row = JSON.parse(l); lastRow.set(row.url, row); } catch { console.error('[#] corrupt index line skipped'); } }
    if (headerBad) { lastRow.clear(); if (o.resume) { o.resume = false; console.error('[#] corrupt header — fresh crawl'); } }
    else if (o.resume && oldSeed !== seed) { throw new SetupError('index belongs to a different seed'); }
  }
  if (!linksOnly && (!o.resume || headerBad)) fs.writeFileSync(indexPath, JSON.stringify({ seed, ts: Date.now() }) + '\n');
  const sum = { ok: 0, failed: 0, http: 0, unchanged: 0, skippedRobots: 0, dup: 0, resumed: 0 };
  const appendRow = linksOnly ? () => {} : row => fs.appendFileSync(indexPath, JSON.stringify(row) + '\n');
  const statePath = host => path.join(process.env.OPENCRAB_STATE_DIR || path.join(require('os').homedir(), '.local/state/opencrab'), 'state', host + '.json');
  // state giữ trong RAM, flush định kỳ + cuối run — read/write per-URL là O(N²) byte ở crawl lớn; crash mất tối đa ~50 URL etag-freshness (index vẫn còn hash)
  const stateCache = new Map(), stateDirty = new Set();
  const readState = host => {
    if (!stateCache.has(host)) {
      try { stateCache.set(host, JSON.parse(fs.readFileSync(statePath(host), 'utf8'))); }
      catch { console.error('[#] corrupt/missing state — treating as empty'); stateCache.set(host, {}); }
    }
    return stateCache.get(host);
  };
  const writeState = (host, st) => { stateCache.set(host, st); stateDirty.add(host); };
  const flushStates = () => { // TTL-prune entry cũ hơn 30 ngày lúc flush — state dùng chung giữa các seed nên prune theo lastSeen, không theo run
    for (const host of stateDirty) {
      const st = stateCache.get(host), now = Date.now();
      for (const u of Object.keys(st)) if (now - (st[u].lastSeen || 0) > 30 * 24 * 3600 * 1000) delete st[u];
      const f = statePath(host); fs.mkdirSync(path.dirname(f), { recursive: true });
      const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, f);
    }
    stateDirty.clear();
  };
  const hashSeen = new Set();

  const robotsCache = new Map();
  const robotsFor = async (origin) => { if (!robotsCache.has(origin)) robotsCache.set(origin, await loadRobots(origin)); return robotsCache.get(origin); };

  // BFS
  const queue = [{ url: seed, depth: 0 }];
  const seen = new Set([seed]);
  const includes = (o.include || []).map(globRe), excludes = (o.exclude || []).map(globRe);
  const passFilter = u => (!includes.length || includes.some(re => re.test(u))) && !excludes.some(re => re.test(u));
  let allowedHost = null, fetched = 0;
  const linksFromIndex = oldSeed === seed ? new Set(lastRow.keys()) : new Set(); // seed khác (không resume) → không tái sử dụng link cũ
  let idxEnqueued = false;
  const enqueueIndexChildren = d => { // one-shot: lần quét đầu cho seen đủ mọi link index — các lần sau là no-op có chứng minh
    if (idxEnqueued) return; idxEnqueued = true;
    for (const child of linksFromIndex) if (!seen.has(child)) { seen.add(child); queue.push({ url: child, depth: d }); } };

  while (queue.length && fetched < o.limit) {
    const { url, depth } = queue.shift();
    if (o.resume) {
      const row = lastRow.get(url);
      if (row && ['ok', 'http:304', 'unchanged', 'robots', 'dup'].includes(row.status)) {
        if (row.status === 'robots') sum.skippedRobots++;
        else if (row.status === 'dup') sum.dup++;
        else sum.resumed++;
        enqueueIndexChildren(depth + 1); // ponytail: enqueue toàn bộ từ index (spec §6.6)
        continue;
      }
    }
    const origin = new URL(url).origin;
    const rb = o.aggressive ? { allowed: () => true, crawlDelayMs: 0, sitemaps: [] } : await robotsFor(origin);
    if (!rb.allowed(new URL(url).pathname)) { sum.skippedRobots++; appendRow({ url, finalUrl: null, file: null, title: null, hash: null, status: 'robots', via: null, ms: null, ts: Date.now() }); continue; }
    // conditional (changed-only) từ state
    const st = o.changedOnly ? readState(new URL(url).hostname) : {};
    const cond = o.changedOnly && st[url] ? { conditional: { etag: st[url].etag, lastModified: st[url].lastModified } } : {};
    // delay giữa request — đặt TRƯỚC fetch: 304/404/dup cũng là request thật với origin
    const crawlDelay = o.aggressive ? (o.delayMs ?? 0) : Math.max(o.delayMs ?? 1500, Math.min(rb.crawlDelayMs, 30000));
    if (crawlDelay === 30000 && rb.crawlDelayMs > 30000) console.error('[#] Crawl-delay capped at 30s');
    if (fetched > 0) await new Promise(rr => setTimeout(rr, crawlDelay));
    const r = await fetch(url, cond);
    fetched++;
    if (fetched % 50 === 0) flushStates();
    if (r.status === 'http:304') { // 304 = bucket unchanged, KHÔNG failure; state giữ hash cũ, chỉ cập nhật etag/lastModified/lastSeen (spec §6.6)
      sum.unchanged++; appendRow({ url, finalUrl: r.finalUrl, file: null, title: null, hash: null, status: 'http:304', via: r.via, ms: r.ms, ts: Date.now() });
      const host0 = new URL(url).hostname, st0 = readState(host0); // key theo hostname của URL xếp hàng — read/write nhất quán cả khi seed redirect
      if (st0[url]) { st0[url] = { ...st0[url], etag: r.etag, lastModified: r.lastModified, lastSeen: Date.now() }; writeState(host0, st0); }
      enqueueIndexChildren(depth + 1); continue;
    }
    if (!r.ok) {
      const fail = r.status === 'blocked' || r.status.startsWith('error:');
      if (fail) sum.failed++; else sum.http++;
      appendRow({ url, finalUrl: r.finalUrl, file: null, title: null, hash: null, status: r.status, via: r.via, ms: r.ms, ts: Date.now() });
      if (linksOnly) console.error('[#] map: dropping non-ok row ' + url); // spec §5 stderr note
      if (url === seed) break; // seed không ok → dừng (spec §6.2)
      continue;
    }
    if (allowedHost === null) allowedHost = new URL(r.finalUrl).hostname; // chốt sau khi fetch seed
    const { ext, str } = linksOnly ? {} : await derivePayloadAndHash(r);
    const hash = !linksOnly && str !== '' ? sha256(str) : null;
    // changed-only: so hash state — KHÔNG continue: body đã fetch, vẫn trích link từ body (spec §6.6)
    let unchangedHit = false;
    if (o.changedOnly) {
      const host = new URL(url).hostname, stt = readState(host); // key theo URL xếp hàng (như nhánh 304)
      if (hash && stt[url] && stt[url].hash === hash) {
        unchangedHit = true; sum.unchanged++;
        appendRow({ url, finalUrl: r.finalUrl, file: null, title: null, hash, status: 'unchanged', via: r.via, ms: r.ms, ts: Date.now() });
        stt[url] = { ...stt[url], etag: r.etag, lastModified: r.lastModified, lastSeen: Date.now() }; writeState(host, stt);
      }
    }
    const title = /html/i.test(r.contentType) ? ((r.html ?? r.bytes.toString('utf8')).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() ?? null : null;
    if (linksOnly) { sum.ok++; pages.push({ url, title }); }
    else if (unchangedHit) { /* đã appendRow ở trên — không ghi file, không dedup; link vẫn trích bên dưới */ }
    else {
    // exact dedup
    if (hash && hashSeen.has(hash)) { sum.dup++; appendRow({ url, finalUrl: r.finalUrl, file: null, title: null, hash, status: 'dup', via: r.via, ms: r.ms, ts: Date.now() }); continue; }
    if (hash) hashSeen.add(hash);
    const file = hash === null ? null : sha1(url) + ext; // payload rỗng (PDF-scan) → file:null, không ghi file trống (spec §6.5)
    if (file) fs.writeFileSync(path.join(outDir, file), str); // bytes ≡ payload đã hash, không newline cuối
    else console.error('[#] empty payload (scanned PDF?) — hash/file null');
    sum.ok++;
    appendRow({ url, finalUrl: r.finalUrl, file, title, hash, status: 'ok', via: r.via, ms: r.ms, ts: Date.now() });
    // state — ghi cho mọi lần crawl, bất kể cờ (spec §6.6)
    { const host = new URL(url).hostname, stt = readState(host); // key theo URL xếp hàng (như nhánh 304)
      stt[url] = { hash, etag: r.etag, lastModified: r.lastModified, lastSeen: Date.now() }; writeState(host, stt); }
    } // hết nhánh ghi !linksOnly
    // links — chỉ từ trang ok, same-host, depth
    if (depth < o.depth && new URL(r.finalUrl).hostname === allowedHost) {
      const html = r.html ?? r.bytes.toString('utf8');
      for (const href of extractLinks(html, r.finalUrl)) {
        const n = normalizeUrl(href);
        if (new URL(n).hostname === allowedHost && !seen.has(n) && passFilter(n)) { seen.add(n); queue.push({ url: n, depth: depth + 1 }); }
      }
      // sitemap (một lần cho allowed host)
      if (depth === 0 && !robotsCache.get(origin)?.__sm) {
        const rb2 = await robotsFor(origin); rb2.__sm = true;
        for (const sm of [origin + '/sitemap.xml', ...rb2.sitemaps]) {
          const smr = await fetch(sm);
          if (!smr.ok) continue;
          const xml = smr.bytes.toString('utf8');
          const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
          let urls = locs;
          if (/<sitemapindex/i.test(xml)) { // theo đệ quy 1 cấp (spec §6.2 — vòng spec R12)
            urls = [];
            for (const childSm of locs) {
              const cr = await fetch(childSm);
              if (!cr.ok) continue;
              if (/<sitemapindex/i.test(cr.bytes.toString('utf8'))) continue; // ponytail: lồng sâu hơn 1 cấp bỏ qua
              urls.push(...[...cr.bytes.toString('utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]));
            }
          }
          for (const loc of urls) { const n = normalizeUrl(loc);
            if (new URL(n).hostname === allowedHost && !seen.has(n) && passFilter(n)) { seen.add(n); queue.push({ url: n, depth: 1 }); } }
        }
      }
    }
  }
  flushStates();
  await close();
  return linksOnly ? { pages, sum } : sum;
}

async function runExtract(url, pairs, opts, emit) { // fetch + jsdom selectors; return ok (Task 6 wrapper dùng)
  const { fetch: f, close } = require('./fetcher');
  const { JSDOM } = require('jsdom');
  const r = await f(url, opts);
  if (!r.ok) { console.error('[!] ' + r.status + ' — retry with --stealth'); return false; }
  const doc = new JSDOM(r.html ?? r.bytes.toString('utf8'), { url: r.finalUrl }).window.document; // url base — href tương đối resolve đúng (regression v1)
  const out = {};
  for (const { name, css } of pairs) {
    out[name] = [...doc.querySelectorAll(css)].slice(0, 500).map(el => {
      const o = { text: (el.textContent || '').trim().slice(0, 300) };
      if (el.tagName === 'A' && el.href) o.href = el.href;
      return o;
    });
  }
  emit(out);
  await close();
  return true;
}
module.exports = { normalizeUrl, loadRobots, crawlBFS, runExtract };
