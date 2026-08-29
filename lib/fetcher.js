// lib/fetcher.js — anti-block ladder (spec §3-§4). THROW ONLY — never process.exit.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BLOCK_PAT = /you'?ve been blocked|network security|access denied|are you a robot|robot check|unusual traffic|verify you are human|challenge-platform|captcha/i;
class SetupError extends Error {}

const stateDir = () => process.env.OPENCRAB_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'opencrab');

function headerValue(dump, name) { // LAST match — -D dump nối header của mọi hop redirect
  const re = new RegExp('^' + name + ':\\s*(.+)$', 'gim');
  let m, last = null; while ((m = re.exec(dump))) last = m[1].trim();
  return last;
}

function curlFetch(url, opts) {
  return new Promise(res => {
    const tmp = path.join(os.tmpdir(), 'oc-hdr-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    const args = ['-s', '-L', '--compressed', '--max-time', '20',
      '-D', tmp, '-H', 'User-Agent: ' + UA, '-w', '\n%{http_code} %{url_effective}'];
    if (opts.conditional && opts.conditional.etag) args.push('-H', 'If-None-Match: ' + opts.conditional.etag);
    if (opts.conditional && opts.conditional.lastModified) args.push('-H', 'If-Modified-Since: ' + opts.conditional.lastModified);
    args.push(url);
    execFile('curl', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }, (e, out) => {
      const dump = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
      try { fs.unlinkSync(tmp); } catch {}
      if (e) return res(null); // body >32MB cũng vào đây (maxBuffer) → caller leo browser
      const s = out.toString('latin1');
      const i = out.lastIndexOf(Buffer.from('\n', 'latin1'));
      const tail = s.slice(i + 1).trim();               // "<code> <url_effective>"
      const sp = tail.indexOf(' ');
      const code = parseInt(tail.slice(0, sp < 0 ? undefined : sp), 10);
      const effUrl = sp < 0 ? url : tail.slice(sp + 1);
      const bytes = out.subarray(0, i);
      res({ code: Number.isFinite(code) ? code : 0, bytes, dump, effUrl });
    });
  });
}

// predicate bị chặn/leo thang — MỘT NGUỒN (spec §4)
const blockedStatus = (code, body) => [403, 429, 503].includes(code) || BLOCK_PAT.test(body.toString('utf8').slice(0, 4096));

// catch-all chung cho rung browser (cả force lẫn leo thang): SetupError rethrow (bin map exit 2, spec §5), còn lại → error:msg sanitize (spec §4)
async function fetchViaBrowser(url, opts, t0) {
  try { return await browserFetch(url, opts, t0); }
  catch (err) {
    if (err instanceof SetupError) throw err; // setup (pidfile/cloak/chromium) → bin map exit 2 (spec §5)
    return { ok: false, status: 'error:' + String(err.message || err).slice(0, 200), via: opts.stealth ? 'stealth' : 'browser', hopped: false, finalUrl: url, contentType: '', etag: null, lastModified: null, bytes: Buffer.alloc(0), html: null, text: null, ms: Date.now() - t0 }; // spec §4: exception sanitize
  }
}

async function fetch(url, opts = {}) {
  const t0 = Date.now();
  if (opts.forceBrowser) return fetchViaBrowser(url, opts, t0); // ép rung browser (spec §4 — wrapper --selector, --wait-for, --screenshot); catch-all như đường leo thang
  const r1 = await curlFetch(url, opts);
  if (r1) {
    const body = r1.bytes;
    const contentType = headerValue(r1.dump, 'Content-Type') || '';
    if (r1.code === 304) return { ok: false, status: 'http:304', via: 'curl', hopped: false, finalUrl: r1.effUrl, contentType, etag: headerValue(r1.dump, 'ETag') || null, lastModified: headerValue(r1.dump, 'Last-Modified') || null, bytes: Buffer.alloc(0), html: null, text: null, ms: Date.now() - t0 };
    if (r1.code === 200 && !blockedStatus(r1.code, body)) return { ok: true, status: 'ok', via: 'curl', hopped: false, finalUrl: r1.effUrl, contentType, etag: headerValue(r1.dump, 'ETag') || null, lastModified: headerValue(r1.dump, 'Last-Modified') || null, bytes: body, html: null, text: null, ms: Date.now() - t0 };
    if (!blockedStatus(r1.code, body)) return { ok: false, status: 'http:' + r1.code, via: 'curl', hopped: false, finalUrl: r1.effUrl, contentType, etag: headerValue(r1.dump, 'ETag') || null, lastModified: headerValue(r1.dump, 'Last-Modified') || null, bytes: body, html: null, text: null, ms: Date.now() - t0 };
    // predicate bị chặn → rơi xuống leo rung browser (spec §4 ladder)
  }
  console.error('[#] curl rung failed (error/oversize) or hit block predicate — escalating to browser'); // spec §4 stderr note
  return fetchViaBrowser(url, opts, t0);
}

// --- browser rung (spec §3-§4) ---
function loadPlaywright() {
  for (const p of [path.join(__dirname, '..', 'node_modules', 'playwright-core'), 'playwright-core']) {
    try { return require(p); } catch {}
  }
  throw new SetupError('playwright-core not found. Run `npm install` in the skill directory.');
}
function findBrowser() {
  const c = [process.env.OPENCRAB_BROWSER, '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/brave-browser'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  const pw = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(pw)) for (const d of fs.readdirSync(pw).sort().reverse()) {
    const p = path.join(pw, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new SetupError('No chromium found. Set OPENCRAB_BROWSER=/path/to/browser.');
}
// pidfile lazy (spec §3): acquire khi sắp launch browser; fail-fast nếu pid sống
function acquirePid() {
  const f = path.join(stateDir(), 'browser.pid');
  fs.mkdirSync(stateDir(), { recursive: true });
  let pid = NaN;
  try { pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10); } catch {}
  if (Number.isFinite(pid) && pid !== process.pid) { // pid CHÍNH MÌNH → re-acquire (test cùng process)
    let dead = false;
    try { process.kill(pid, 0); } catch (e) { dead = e.code === 'ESRCH'; } // chỉ ESRCH = chết → ghi đè; EPERM = sống (không phải của mình)
    if (!dead) throw new SetupError(`another opencrab holds the browser (pid ${pid})`);
  }
  fs.writeFileSync(f, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(f); } catch {} });
}
// migrate-on-first-run (spec §8): ~/.cache/blocked-fetch-profile* → stateDir()/profile*
function migrateProfiles() {
  const pairs = [['blocked-fetch-profile', 'profile'], ['blocked-fetch-profile-stealth', 'profile-stealth']];
  for (const [oldName, newName] of pairs) {
    const oldP = path.join(os.homedir(), '.cache', oldName);
    const newP = path.join(stateDir(), newName);
    if (fs.existsSync(oldP) && !fs.existsSync(newP)) {
      const tmp = newP + '.migrating';
      fs.cpSync(oldP, tmp, { recursive: true });
      fs.renameSync(tmp, newP);
    }
  }
}
// Kill chromium mồ côi giữ đúng profile opencrab (scoped — không đụng browser thật), giữ từ v1 (spec §3)
function killProfileOrphans(profileDir) {
  if (process.platform !== 'linux') return Promise.resolve();
  return new Promise(resolve => {
    execFile('ps', ['-eo', 'pid,args'], (e, out) => {
      if (!e) { const marker = '--user-data-dir=' + profileDir;
        for (const line of out.split('\n')) { const m = line.match(/^\s*(\d+)\s+(.*)$/); if (!m) continue;
          if (m[2].includes(marker + ' ') || m[2].endsWith(marker)) { try { process.kill(parseInt(m[1], 10), 'SIGKILL'); } catch {} } } }
      setTimeout(resolve, 500);
    });
  });
}
let ctx = null, page = null;
async function ensureBrowser(stealth) {
  if (page) return page;
  migrateProfiles();
  acquirePid();
  const profileDir = path.join(stateDir(), stealth ? 'profile-stealth' : 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  if (stealth) {
    // cloakbrowser là ESM-only (exports "import" thôi) → require() ném; dynamic import là cách tải đúng
    let cloak; try { cloak = await import('cloakbrowser'); }
    catch { throw new SetupError('stealth mode needs `npm install cloakbrowser`'); }
    ctx = await cloak.launchPersistentContext({ userDataDir: profileDir, headless: true,
      ...(process.env.CLOAKBROWSER_PROXY ? { licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY, proxy: process.env.CLOAKBROWSER_PROXY, geoip: true } : {}) });
  } else {
    const { chromium } = loadPlaywright();
    const launchOpts = { executablePath: findBrowser(), headless: true,
      viewport: { width: 1280, height: 800 }, userAgent: UA, args: ['--disable-blink-features=AutomationControlled'] };
    try { ctx = await chromium.launchPersistentContext(profileDir, launchOpts); }
    catch (e) {
      if (!/ProcessSingleton|Singleton/i.test(e.message)) throw e;
      console.error('[#] orphan browser holds the profile lock — killing it and retrying');
      await killProfileOrphans(profileDir);
      ctx = await chromium.launchPersistentContext(profileDir, launchOpts);
    }
  }
  page = ctx.pages()[0] || await ctx.newPage();
  return page;
}
async function close() { if (ctx) { await ctx.close().catch(() => {}); ctx = null; page = null; } }

async function browserFetch(url, opts, t0) {
  const p = await ensureBrowser(!!opts.stealth);
  const settle = opts.waitMs ?? 1500;
  const doGoto = async () => {
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await p.waitForTimeout(settle);
    return resp;
  };
  let resp = await doGoto();
  if (resp && resp.status() === 429) { await new Promise(r => setTimeout(r, 10000)); resp = await doGoto(); } // retry 1 lần (spec §4)
  // waitFor/screenshot: SAU settle, TRƯỚC verdict — screenshot ghi BẤT KỂ status cuối (spec §4)
  if (opts.waitFor) { await p.waitForSelector(opts.waitFor, { timeout: 30000 }).catch(() => console.error('[#] --wait-for timeout, proceeding')); }
  if (opts.screenshot) { await p.screenshot({ path: opts.screenshot, fullPage: true }).catch(e => console.error('[#] screenshot: ' + e.message)); }
  const headers = resp ? resp.headers() : {};
  const code = resp ? resp.status() : 0;
  const html = await p.content().catch(() => '');
  const text = await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  let hopped = false;
  if (code === 200 && !blockedStatus(code, text)) {
    const bytes = (resp && resp.body ? Buffer.from(await resp.body()) : Buffer.from(html));
    return { ok: true, status: 'ok', via: opts.stealth ? 'stealth' : 'browser', hopped,
      finalUrl: p.url(), contentType: headers['content-type'] || '',
      etag: headers['etag'] || null, lastModified: headers['last-modified'] || null,
      bytes, html, text, ms: Date.now() - t0 };
  }
  if (blockedStatus(code, text)) {
    // rung 3: search-hop (spec §3) — OPENCRAB_HOP=off → coi như không có hop
    if (process.env.OPENCRAB_HOP !== 'off') {
      const hop = await findHop(p, new URL(p.url()).hostname, settle);
      if (hop) { hopped = true; await doGotoTo(p, hop, settle); resp = await doGoto(); }
    }
    const code2 = resp ? resp.status() : 0;
    const text2 = await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (code2 === 200 && !blockedStatus(code2, text2)) {
      const html2 = await p.content().catch(() => '');
      return { ok: true, status: 'ok', via: opts.stealth ? 'stealth' : 'browser', hopped: true,
        finalUrl: p.url(), contentType: (resp.headers() || {})['content-type'] || '',
        etag: (resp.headers() || {}).etag || null, lastModified: (resp.headers() || {})['last-modified'] || null,
        bytes: (resp && resp.body ? Buffer.from(await resp.body()) : Buffer.from(html2)), html: html2, text: text2, ms: Date.now() - t0 };
    }
    return { ok: false, status: 'blocked', via: opts.stealth ? 'stealth' : 'browser', hopped,
      finalUrl: p.url(), contentType: headers['content-type'] || '', etag: headers['etag'] || null,
      lastModified: headers['last-modified'] || null, bytes: Buffer.from(html), html, text, ms: Date.now() - t0 };
  }
  return { ok: false, status: 'http:' + code, via: opts.stealth ? 'stealth' : 'browser', hopped,
    finalUrl: p.url(), contentType: headers['content-type'] || '', etag: headers['etag'] || null,
    lastModified: headers['last-modified'] || null, bytes: Buffer.from(html), html, text, ms: Date.now() - t0 };
}
async function doGotoTo(p, href, settle) { await p.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await p.waitForTimeout(settle + 500); }
async function findHop(p, host, settle) {
  const engines = [
    ['ddg-html', `https://html.duckduckgo.com/html/?q=${encodeURIComponent('site:' + host)}`, () => document.querySelector('.result__a')?.href || ''],
    ['ddg-lite', `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent('site:' + host)}`, () => document.querySelector('a.result-link')?.href || ''],
    ['bing', `https://www.bing.com/search?q=${encodeURIComponent('site:' + host)}`, () => document.querySelector('li.b_algo h2 a')?.href || ''],
  ];
  for (const [name, u, getHref] of engines) {
    await doGotoTo(p, u, settle);
    const body = await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (/challenge|captcha|squares containing/i.test(body.slice(0, 400))) continue;
    const href = await p.evaluate(getHref).catch(() => '');
    if (href) { console.error(`[#] hopping via ${name}`); return href; }
  }
  return '';
}
// search 3-engine (spec §3 rung search): DDG HTML/lite + Bing; fallback theo thứ tự khi bị challenge
const ENGINE_SELECTORS = {
  'ddg-html': ['https://html.duckduckgo.com/html/?q=', '.result__a', '.result__snippet'],
  'ddg-lite': ['https://lite.duckduckgo.com/lite/?q=', 'a.result-link', 'td:last-child'],
  'bing': ['https://www.bing.com/search?q=', 'li.b_algo h2 a', '.b_caption p'],
};
async function searchResults(q, { limit = 10 } = {}) {
  const p = await ensureBrowser(false);
  for (const [name, [base, linkSel, snipSel]] of Object.entries(ENGINE_SELECTORS)) {
    await doGotoTo(p, base + encodeURIComponent(q), 1500);
    const body = await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (/challenge|captcha|squares containing/i.test(body.slice(0, 400))) continue;
    const items = await p.evaluate(([ls, ss, lim]) => [...document.querySelectorAll(ls)].slice(0, lim).map(a => ({
      title: (a.textContent || '').trim().slice(0, 300),
      url: a.href || '',
      snippet: ((a.closest('tr,div,li')?.querySelector(ss) || {}).textContent || '').trim().slice(0, 300), // ddg-lite: snippet là SIBLING td trong cùng tr (review Minor #1) — tr đứng trước để div/li engine khác giữ nguyên
    })), [linkSel, snipSel, limit]).catch(() => []);
    const results = items.filter(i => i.url); // review Minor #2: engine chỉ "có kết quả" khi ≥1 item có url — rỗng thì rơi qua engine kế
    if (results.length) return { engine: name, results };
  }
  throw new Error('all search engines challenged');
}
function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m; const base = new URL(baseUrl);
  while ((m = re.exec(html))) { try { out.push(new URL(m[1], base).href); } catch {} }
  return out;
}
module.exports = { fetch, close, extractLinks, searchResults, SetupError, UA, BLOCK_PAT, stateDir };
