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
  // resume: đọc index cũ (last-row-wins) — frontier + terminal verdicts
  const lastRow = new Map(); let oldSeed = null; let headerBad = false;
  if (!linksOnly && o.resume && fs.existsSync(indexPath)) {
    const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean);
    try { const h = JSON.parse(lines[0]); oldSeed = h.seed; } catch { headerBad = true; }
    for (const l of lines.slice(headerBad ? 0 : 1)) {
      try { const row = JSON.parse(l); lastRow.set(row.url, row); } catch { console.error('[#] corrupt index line skipped'); } }
    if (headerBad) { lastRow.clear(); o.resume = false; console.error('[#] corrupt header — fresh crawl'); }
    else if (oldSeed !== null && oldSeed !== seed) { const e = new Error('index belongs to a different seed'); e.exit2 = true; throw e; }
  } else if (!linksOnly && !o.resume) {
    fs.writeFileSync(indexPath, JSON.stringify({ seed, ts: Date.now() }) + '\n');
  }
  const sum = { ok: 0, failed: 0, http: 0, unchanged: 0, skippedRobots: 0, dup: 0, resumed: 0 };
  const appendRow = linksOnly ? () => {} : row => fs.appendFileSync(indexPath, JSON.stringify(row) + '\n');
  const statePath = host => path.join(process.env.OPENCRAB_STATE_DIR || path.join(require('os').homedir(), '.local/state/opencrab'), 'state', host + '.json');
  const readState = host => { try { return JSON.parse(fs.readFileSync(statePath(host), 'utf8')); } catch { console.error('[#] corrupt/missing state — treating as empty'); return {}; } }; // stderr note (Global Constraints)
  const writeState = (host, st) => { const f = statePath(host); fs.mkdirSync(path.dirname(f), { recursive: true });
    const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, f); };
  const hashSeen = new Set();

  const robotsCache = new Map();
  const robotsFor = async (origin) => { if (!robotsCache.has(origin)) robotsCache.set(origin, await loadRobots(origin)); return robotsCache.get(origin); };

  // BFS
  const queue = [{ url: seed, depth: 0 }];
  const seen = new Set([seed]);
  const includes = (o.include || []).map(globRe), excludes = (o.exclude || []).map(globRe);
  const passFilter = u => (!includes.length || includes.some(re => re.test(u))) && !excludes.some(re => re.test(u));
  let allowedHost = null, fetched = 0;
  const linksFromIndex = new Set(lastRow.keys());

  while (queue.length && fetched < o.limit) {
    const { url, depth } = queue.shift();
    if (o.resume) {
      const row = lastRow.get(url);
      if (row && ['ok', 'http:304', 'unchanged', 'robots', 'dup'].includes(row.status)) {
        if (row.status === 'robots') sum.skippedRobots++;
        else if (row.status === 'dup') sum.dup++;
        else sum.resumed++;
        for (const child of linksFromIndex) if (!seen.has(child)) { seen.add(child); queue.push({ url: child, depth: depth + 1 }); } // ponytail: enqueue toàn bộ từ index (spec §6.6)
        continue;
      }
    }
    const origin = new URL(url).origin;
    const rb = o.aggressive ? { allowed: () => true, crawlDelayMs: 0, sitemaps: [] } : await robotsFor(origin);
    if (!rb.allowed(new URL(url).pathname)) { sum.skippedRobots++; appendRow({ url, finalUrl: null, file: null, title: null, hash: null, status: 'robots', via: null, ms: null, ts: Date.now() }); continue; }
    // conditional (changed-only) từ state
    const st = o.changedOnly ? readState(new URL(url).hostname) : {};
    const cond = o.changedOnly && st[url] ? { conditional: { etag: st[url].etag, lastModified: st[url].lastModified } } : {};
    const r = await fetch(url, cond);
    fetched++;
    const enqueueIndexChildren = () => { // 304/skip không có body → link từ index cũ (spec §6.6)
      for (const child of linksFromIndex) if (!seen.has(child)) { seen.add(child); queue.push({ url: child, depth: depth + 1 }); } };
    if (r.status === 'http:304') { // 304 = bucket unchanged, KHÔNG failure; state giữ hash cũ, chỉ cập nhật etag/lastModified/lastSeen (spec §6.6)
      sum.unchanged++; appendRow({ url, finalUrl: r.finalUrl, file: null, title: null, hash: null, status: 'http:304', via: r.via, ms: r.ms, ts: Date.now() });
      const host0 = allowedHost ?? new URL(url).hostname, st0 = readState(host0);
      if (st0[url]) { st0[url] = { ...st0[url], etag: r.etag, lastModified: r.lastModified, lastSeen: Date.now() }; writeState(host0, st0); }
      enqueueIndexChildren(); continue;
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
      const host = allowedHost ?? new URL(url).hostname, stt = readState(host);
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
    { const host = allowedHost ?? new URL(url).hostname, stt = readState(host);
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
    // delay giữa request
    const crawlDelay = o.aggressive ? (o.delayMs ?? 0) : Math.max(o.delayMs ?? 1500, Math.min(rb.crawlDelayMs, 30000));
    if (crawlDelay === 30000 && rb.crawlDelayMs > 30000) console.error('[#] Crawl-delay capped at 30s');
    if (queue.length) await new Promise(rr => setTimeout(rr, crawlDelay));
  }
  await close();
  return linksOnly ? { pages, sum } : sum;
}

function cmdCrawl(argv) {
  const o = { limit: 50, depth: 2, delayMs: null, include: [], exclude: [], resume: false, changedOnly: false, aggressive: false };
  let url = '', out = '';
  for (let i = 0; i < argv.length; i++) { const a = argv[i];
    if (a === '--out') out = argv[++i]; else if (a === '--limit') o.limit = parseInt(argv[++i], 10);
    else if (a === '--depth') o.depth = parseInt(argv[++i], 10); else if (a === '--delay') o.delayMs = parseInt(argv[++i], 10);
    else if (a === '--include') o.include.push(argv[++i]); else if (a === '--exclude') o.exclude.push(argv[++i]);
    else if (a === '--resume') o.resume = true; else if (a === '--changed-only') o.changedOnly = true;
    else if (a === '--aggressive') o.aggressive = true; else url = a; }
  if (!url || !out) { console.error('Usage: crawl URL --out DIR [--limit N] [--depth N] [--delay MS] [--include G] [--exclude G] [--resume] [--changed-only] [--aggressive]'); process.exitCode = 2; return; }
  o.outDir = out;
  crawlBFS(url, o).then(sum => {
    console.log(`ok=${sum.ok} failed=${sum.failed} http=${sum.http} unchanged=${sum.unchanged} robots=${sum.skippedRobots} dup=${sum.dup} resumed=${sum.resumed} index=${require('path').join(out, 'index.jsonl')}`);
    if (!process.exitCode) process.exitCode = sum.failed ? 1 : 0;
  }).catch(e => { if (e.exit2 || e instanceof SetupError) { console.error(e.message); process.exitCode = 2; } else { console.error('[!] ' + e.message); process.exitCode = 1; } });
}
function cmdMap(argv) { // map = crawlBFS({linksOnly:true}) — thuần stdout (spec §3/§4)
  const o = { limit: 500, depth: 3, delayMs: null, aggressive: false, linksOnly: true, outDir: null, include: [], exclude: [] };
  let url = '';
  for (let i = 0; i < argv.length; i++) { const a = argv[i];
    if (a === '--limit') o.limit = parseInt(argv[++i], 10); else if (a === '--depth') o.depth = parseInt(argv[++i], 10);
    else if (a === '--delay') o.delayMs = parseInt(argv[++i], 10); else if (a === '--aggressive') o.aggressive = true; else url = a; }
  if (!url) { console.error('Usage: map URL [--limit N] [--depth N] [--delay MS] [--aggressive]'); process.exitCode = 2; return; }
  crawlBFS(url, o).then(({ pages, sum }) => {
    console.log(JSON.stringify(pages));
    if (!process.exitCode) process.exitCode = sum.failed ? 1 : 0;
  }).catch(e => { if (e instanceof SetupError) { console.error(e.message); process.exitCode = 2; } else { console.error('[!] ' + e.message); process.exitCode = 1; } });
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
module.exports = { normalizeUrl, loadRobots, crawlBFS, cmdCrawl, cmdMap, runExtract };
