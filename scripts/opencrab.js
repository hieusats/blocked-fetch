#!/usr/bin/env node
// opencrab.js — CLI (spec §5). Exit: 0 ok · 1 blocked/partial · 2 usage/setup.
const fs = require('fs');
const fetcher = require('../lib/fetcher');
const { toMarkdown, htmlToText, pdfToText } = require('../lib/md');

function die2(msg) { console.error(msg); process.exitCode = 2; }
const ctJson = ct => /json/i.test(ct), ctPdf = ct => /application\/pdf/i.test(ct);

async function derivePayload(r, flags) {
  if (ctPdf(r.contentType)) {
    if (flags.text || !flags.html) { const t = await pdfToText(r.bytes).catch(() => ''); if (!t) console.error('[#] PDF has no text layer'); return { key: 'text', val: t }; }
    return { key: 'html', val: null };
  }
  if (flags.text) return { key: 'text', val: ctJson(r.contentType) ? htmlToText(r.bytes.toString('utf8')) : htmlToText(r.html ?? r.bytes.toString('utf8')) };
  if (flags.html) return { key: 'html', val: ctJson(r.contentType) || ctPdf(r.contentType) ? null : (r.html ?? r.bytes.toString('utf8')) };
  if (ctJson(r.contentType)) { const raw = r.bytes.toString('utf8'), j = safeJson(raw); if (j !== null) return { key: 'json', val: j, raw }; } // raw body = chuỗi chuẩn cho --raw/.json file (spec §4)
  return { key: 'markdown', val: toMarkdown(r.html ?? r.bytes.toString('utf8')) };
}
function safeJson(raw) { try { return JSON.parse(raw); } catch { console.error('[#] JSON parse failed → HTML path'); return null; } }
// derivePayload: `if (ctJson(...)) { const j = safeJson(...); if (j !== null) return { key: 'json', val: j }; }` → rơi xuống dòng markdown (spec §4: parse-fail → HTML path)

async function scrapeOne(url, flags) { // lõi cmdScrape tách hàm (Task 9): fetch + payload + envelope; TRẢ VỀ, KHÔNG in — cmdScrape/cmdSearch tự in (spec §6.4)
  const r = await fetcher.fetch(url, { stealth: flags.stealth, waitFor: flags.waitFor, screenshot: flags.screenshot, forceBrowser: !!(flags.waitFor || flags.screenshot) });
  const title = /html/i.test(r.contentType) ? titleOf(r.html ?? r.bytes.toString('utf8')) : null;
  const payload = r.ok ? await derivePayload(r, flags) : { key: null, val: null };
  const envelope = { url, finalUrl: r.finalUrl, title, status: r.status, via: r.via, hopped: r.hopped, ms: r.ms };
  envelope[payload.key ?? 'payload'] = payload.val; // không-ok → "payload": null (spec §4: không omit)
  return { envelope, raw: payload.raw, val: payload.val }; // raw = body gốc cho --raw/.json, val = payload (spec §4)
}
async function cmdScrape(argv) {
  const flags = parseScrapeFlags(argv); // --raw --text --html --out --max-bytes --wait-for --screenshot --stealth
  let envelope, raw, val;
  try { ({ envelope, raw, val } = await scrapeOne(flags.url, flags)); }
  catch (e) { if (e instanceof fetcher.SetupError) return die2(e.message); throw e; }
  const out = flags.raw ? (raw ?? (val == null ? '' : typeof val === 'string' ? val : JSON.stringify(val))) : JSON.stringify(envelope);
  emit(out, flags);
  await fetcher.close();
  process.exitCode = envelope.status === 'ok' ? 0 : 1;
}
function titleOf(html) { const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? m[1].trim() : null; }
function emit(text, flags) {
  const cap = flags.maxBytes ?? 200000;
  if (flags.out) { fs.writeFileSync(flags.out, text); return console.error('[ok] written to ' + flags.out); }
  if (text.length > cap) {
    const cut = flags.raw ? text.slice(0, cap) : truncEnvelope(text, cap);
    console.log(cut);
    console.error(`[!] truncated at ${cap} of ${text.length} — use --max-bytes N or --out FILE`);
  } else console.log(text);
}
function truncEnvelope(json, cap) { // cắt trường payload — envelope vẫn JSON hợp lệ (spec §4)
  const e = JSON.parse(json);
  for (const k of ['markdown', 'text', 'html', 'json']) if (typeof e[k] === 'string' && e[k].length > cap - 500) e[k] = e[k].slice(0, cap - 500) + '…[truncated]';
  else if (e[k] && typeof e[k] === 'object') e[k] = JSON.stringify(e[k]).slice(0, cap - 500);
  return JSON.stringify(e);
}

function parseScrapeFlags(argv) {
  const f = { url: '', raw: false, text: false, html: false, out: '', maxBytes: null, waitFor: '', screenshot: '', stealth: false };
  for (let i = 0; i < argv.length; i++) { const a = argv[i];
    if (a === '--raw') f.raw = true; else if (a === '--text') f.text = true; else if (a === '--html') f.html = true;
    else if (a === '--out') f.out = argv[++i]; else if (a === '--max-bytes') f.maxBytes = parseInt(argv[++i], 10);
    else if (a === '--wait-for') f.waitFor = argv[++i]; else if (a === '--screenshot') f.screenshot = argv[++i];
    else if (a === '--stealth') f.stealth = true; else f.url = a; }
  if (!/^https?:\/\//.test(f.url)) throw new fetcher.SetupError('scrape: cần URL http(s)');
  return f;
}
// crawl/map engine lives in lib/crawl.js (crawlBFS); CLI wrappers here — bins own argv + exit codes (spec §5)
async function cmdCrawl(argv) {
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
  require('../lib/crawl').crawlBFS(url, o).then(sum => {
    console.log(`ok=${sum.ok} failed=${sum.failed} http=${sum.http} unchanged=${sum.unchanged} robots=${sum.skippedRobots} dup=${sum.dup} resumed=${sum.resumed} index=${require('path').join(out, 'index.jsonl')}`);
    if (!process.exitCode) process.exitCode = sum.failed ? 1 : 0;
  }).catch(e => { if (e instanceof fetcher.SetupError) { console.error(e.message); process.exitCode = 2; } else { console.error('[!] ' + e.message); process.exitCode = 1; } });
}
async function cmdMap(argv) { // map = crawlBFS({linksOnly:true}) — thuần stdout (spec §3/§4)
  const o = { limit: 500, depth: 3, delayMs: null, aggressive: false, linksOnly: true, outDir: null, include: [], exclude: [] };
  let url = '';
  for (let i = 0; i < argv.length; i++) { const a = argv[i];
    if (a === '--limit') o.limit = parseInt(argv[++i], 10); else if (a === '--depth') o.depth = parseInt(argv[++i], 10);
    else if (a === '--delay') o.delayMs = parseInt(argv[++i], 10); else if (a === '--aggressive') o.aggressive = true; else url = a; }
  if (!url) { console.error('Usage: map URL [--limit N] [--depth N] [--delay MS] [--aggressive]'); process.exitCode = 2; return; }
  require('../lib/crawl').crawlBFS(url, o).then(({ pages, sum }) => {
    console.log(JSON.stringify(pages));
    if (!process.exitCode) process.exitCode = sum.failed ? 1 : 0;
  }).catch(e => { if (e instanceof fetcher.SetupError) { console.error(e.message); process.exitCode = 2; } else { console.error('[!] ' + e.message); process.exitCode = 1; } });
}
// Task 9: search (3-engine + --scrape JSONL) + extract (named selectors, jsdom) — spec §4/§5
async function cmdExtract(argv) { // element {text, href?} — textContent (jsdom không có innerText), cap 300/500 (spec §4)
  const pairs = []; let url = '';
  for (let i = 0; i < argv.length; i++) { const a = argv[i];
    if (a === '--selector') { const s = argv[++i], eq = s.indexOf('='); pairs.push({ name: s.slice(0, eq), css: s.slice(eq + 1) }); } else url = a; }
  if (!url || !pairs.length) { die2('Usage: extract URL --selector name=CSS [--selector name2=CSS2]'); return; }
  const ok = await require('../lib/crawl').runExtract(url, pairs, {}, out => console.log(JSON.stringify(out)));
  await fetcher.close();
  process.exitCode = ok ? 0 : 1;
}
async function cmdSearch(argv) { // bare array; --scrape → JSONL envelope + delay 1500ms (spec §5)
  let q = '', scrape = false, limit = 10;
  for (let i = 0; i < argv.length; i++) { const a = argv[i];
    if (a === '--scrape') scrape = true; else if (a === '--limit') limit = parseInt(argv[++i], 10); else q = q ? q + ' ' + a : a; }
  if (!q) { die2('Usage: search "query" [--limit N] [--scrape]'); return; }
  let sr;
  try { sr = await fetcher.searchResults(q, { limit }); }
  catch (e) { if (e instanceof fetcher.SetupError) return die2(e.message); console.error('[!] ' + e.message); process.exitCode = 1; await fetcher.close(); return; }
  if (!scrape) { console.log(JSON.stringify(sr.results)); await fetcher.close(); return; }
  let anyBad = false;
  for (let i = 0; i < sr.results.length; i++) {
    const u = sr.results[i].url; // robots gate cho search --scrape (spec §6.4)
    const rb = await require('../lib/crawl').loadRobots(new URL(u).origin).catch(() => null);
    if (rb && !rb.allowed(new URL(u).pathname)) { console.error('[#] robots: skip ' + u); continue; }
    let env; // scrapeOne TRẢ VỀ envelope, KHÔNG in — cmdSearch tự in (hợp đồng pin)
    try { ({ envelope: env } = await scrapeOne(u, {})); }
    catch (e) { if (e instanceof fetcher.SetupError) { await fetcher.close(); return die2(e.message); } throw e; }
    console.log(JSON.stringify(env));
    if (!env || env.status !== 'ok') anyBad = true;
    if (i < sr.results.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
  await fetcher.close();
  process.exitCode = anyBad ? 1 : 0;
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const sigint = async () => { await fetcher.close().catch(() => {}); process.exit(130); };
  process.on('SIGINT', sigint); process.on('SIGTERM', sigint);
  try {
    if (cmd === 'scrape') await cmdScrape(rest);
    else if (cmd === 'crawl') await cmdCrawl(rest);
    else if (cmd === 'map') await cmdMap(rest);
    else if (cmd === 'search') await cmdSearch(rest);
    else if (cmd === 'extract') await cmdExtract(rest);
    else die2('Usage: opencrab.js <scrape|crawl|map|search|extract> ...');
  } catch (e) {
    if (e instanceof fetcher.SetupError) die2(e.message);
    else { console.error('[!] ' + (e.stack || e.message)); process.exitCode = 1; }
  }
})();
