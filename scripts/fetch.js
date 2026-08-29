#!/usr/bin/env node
// fetch.js — backcompat wrapper (spec §3): stdout GIỮ ĐÚNG FORMAT CŨ.
// Ladder/extract logic lives in lib/ (fetcher, md, crawl); this file only preserves the v1 CLI.
if (process.env.BLOCKED_FETCH_BROWSER && !process.env.OPENCRAB_BROWSER) process.env.OPENCRAB_BROWSER = process.env.BLOCKED_FETCH_BROWSER; // env alias (spec §8)
const fs = require('fs');
const ctPdf = ct => /application\/pdf/i.test(ct);
const fetcher = require('../lib/fetcher');
const { htmlToText, pdfToText } = require('../lib/md');

(async () => {
  const argv = process.argv.slice(2);
  const f = { text: false, stealth: false, selector: '', out: '', maxBytes: 200000, wait: 1500 };
  const urls = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i];
    if (a === '--text') f.text = true; else if (a === '--stealth') f.stealth = true;
    else if (a === '--selector') f.selector = argv[++i]; else if (a === '--out') f.out = argv[++i];
    else if (a === '--max-bytes') f.maxBytes = parseInt(argv[++i], 10); else if (a === '--wait') f.wait = parseInt(argv[++i], 10);
    else urls.push(a); }
  if (!urls.length || urls.some(u => !/^https?:\/\//.test(u))) { console.error('Usage: node scripts/fetch.js <url> [url2 ...] [--text] [--stealth] [--selector CSS] [--out FILE] [--max-bytes N] [--wait MS]'); process.exitCode = 2; return; }
  if (f.out && urls.length > 1) { console.error('--out works with a single URL only'); process.exitCode = 2; return; } // guard v1

  const emit = t => { const s = String(t);
    if (f.out) { fs.writeFileSync(f.out, s); console.error('[ok] written to ' + f.out); return; }
    if (s.length > f.maxBytes) { console.log(s.slice(0, f.maxBytes)); console.error(`[!] truncated at ${f.maxBytes} of ${s.length} bytes — use --max-bytes N or --out FILE`); }
    else console.log(s); };
  const compactJson = s => { try { return JSON.stringify(JSON.parse(s)); } catch { return s; } }; // bước compact cũ (pipe qua jq để đọc)

  let failures = 0;
  for (let i = 0; i < urls.length; i++) {
    if (urls.length > 1) console.error('### ' + urls[i]);
    let ok = true;
    if (f.selector) {
      // ép browser (spec §4); extract name "elements" → mảng bare như v1. lib/crawl: Task 7.
      try { ok = await require('../lib/crawl').runExtract(urls[i], [{ name: 'elements', css: f.selector }], { forceBrowser: true, waitMs: f.wait, stealth: f.stealth }, items => emit(JSON.stringify(items))); }
      catch (e) { if (e instanceof fetcher.SetupError) { console.error(e.message); process.exitCode = 2; return; } throw e; }
    } else {
      let r; try { r = await fetcher.fetch(urls[i], { stealth: f.stealth, waitMs: f.wait }); }
      catch (e) { if (e instanceof fetcher.SetupError) { console.error(e.message); process.exitCode = 2; return; } throw e; }
      if (r.status === 'blocked') { console.error('[!] blocked — retry with --stealth or a residential proxy'); ok = false; }
      else if (r.status.startsWith('error:')) { console.error('[!] ' + r.status.slice(6)); ok = false; } // v1 exit-0-silent là bug đã sửa (documented, spec §3)
      else if (r.status !== 'ok') { emit(r.bytes.length ? r.bytes.toString('utf8') : '(http ' + r.status.slice(5) + ')'); ok = false; } // non-200: body nếu có, ngược lại "(http N)" như v1
      else emit(f.text ? htmlToText(r.html ?? r.bytes.toString('utf8')) : compactJson(ctPdf(r.contentType) ? await pdfToText(r.bytes) : r.bytes.toString('utf8'))); // PDF → payload text (spec §3)
    }
    if (!ok) failures++;
    if (i < urls.length - 1) await new Promise(r2 => setTimeout(r2, 2000)); // no parallel fetches — rate limits
  }
  await fetcher.close();
  if (!process.exitCode) process.exitCode = failures ? 1 : 0;
})();
