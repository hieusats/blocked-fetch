#!/usr/bin/env node
// opencrab.js — CLI (spec §5). Exit: 0 ok · 1 blocked/partial · 2 usage/setup.
const crypto = require('crypto'); // hash payload — dùng từ Task 7 (crawl)
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

async function cmdScrape(argv) {
  const flags = parseScrapeFlags(argv); // --raw --text --html --out --max-bytes --wait-for --screenshot --stealth
  let r;
  try { r = await fetcher.fetch(flags.url, { stealth: flags.stealth, waitFor: flags.waitFor, screenshot: flags.screenshot, forceBrowser: !!(flags.waitFor || flags.screenshot) }); }
  catch (e) { if (e instanceof fetcher.SetupError) return die2(e.message); throw e; }
  const title = /html/i.test(r.contentType) ? titleOf(r.html ?? r.bytes.toString('utf8')) : null;
  const payload = r.ok ? await derivePayload(r, flags) : { key: null, val: null };
  const envelope = { url: flags.url, finalUrl: r.finalUrl, title, status: r.status, via: r.via, hopped: r.hopped, ms: r.ms };
  envelope[payload.key ?? 'payload'] = payload.val; // không-ok → "payload": null (spec §4: không omit)
  const out = flags.raw ? (payload.raw ?? (payload.val == null ? '' : typeof payload.val === 'string' ? payload.val : JSON.stringify(payload.val))) : JSON.stringify(envelope);
  emit(out, flags);
  await fetcher.close();
  process.exitCode = r.ok ? 0 : 1;
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
// Stub — Task 7 thay bằng hiện thực thật:
async function cmdCrawl() { die2('crawl: chưa có — đợi Task 7'); }
async function cmdMap() { die2('map: chưa có — đợi Task 7'); }
// Stub — Task 9 thay bằng hiện thực thật:
async function cmdSearch() { die2('search: chưa có — đợi Task 9'); }
async function cmdExtract() { die2('extract: chưa có — đợi Task 9'); }

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
