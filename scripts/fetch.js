#!/usr/bin/env node
// fetch.js — fetch URLs through the full anti-block ladder:
//   rung 1: curl with a browser UA (no browser launch — fastest)
//   rung 2: real browser session (lazy-launched, persistent profile)
//   rung 3: search-hop unlock (DDG html/lite -> Bing) when browsers are blocked too
//   rung 4: --stealth — CloakBrowser stealth Chromium (C++ fingerprint patches)
// Usage: node scripts/fetch.js <url> [url2 ...] [--text] [--stealth] [--selector CSS]
//                                 [--out FILE] [--max-bytes N] [--wait MS]
//   --selector   extract matching elements (forces browser rung), JSON out
//   --out        write the full body to FILE (single URL only)
//   --max-bytes  stdout cap, default 200000 (protects agent context)
// Exit codes: 0 all ok · 1 some/all blocked · 2 usage/setup error.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BLOCK_PAT = /you'?ve been blocked|network security|access denied|are you a robot|robot check|unusual traffic|verify you are human|challenge-platform|captcha/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function die(msg, code = 1) { console.error(msg); process.exit(code); }

// --- resolve playwright-core: skill-local install first, then npx cache ---
function loadPlaywright() {
  const local = path.join(__dirname, '..', 'node_modules', 'playwright-core');
  try { return require(local); } catch {}
  try { return require('playwright-core'); } catch {}
  const cacheDir = path.join(os.homedir(), '.npm', '_npx');
  if (fs.existsSync(cacheDir)) {
    for (const d of fs.readdirSync(cacheDir)) {
      const p = path.join(cacheDir, d, 'node_modules', 'playwright-core');
      try { return require(p); } catch {}
    }
  }
  die('playwright-core not found. Run `npm install` in the skill directory.', 2);
}

// --- find a chromium executable ---
function findBrowser() {
  const candidates = [
    process.env.BLOCKED_FETCH_BROWSER,
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/brave-browser',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  const pwDir = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(pwDir)) {
    for (const d of fs.readdirSync(pwDir).sort().reverse()) {
      const p = path.join(pwDir, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  die('No chromium/chrome found. Set BLOCKED_FETCH_BROWSER=/path/to/browser.', 2);
}

function loadOptional(name) {
  const local = path.join(__dirname, '..', 'node_modules', name);
  try { return require(local); } catch {}
  return require(name);
}

// Kill chromium processes using exactly this profile dir (scoped: never touches
// the user's real browser). Linux-only; other platforms surface the launch error.
function killProfileOrphans(profileDir) {
  if (process.platform !== 'linux') return Promise.resolve();
  return new Promise(resolve => {
    execFile('ps', ['-eo', 'pid,args'], (e, out) => {
      if (!e) {
        const marker = '--user-data-dir=' + profileDir;
        for (const line of out.split('\n')) {
          const m = line.match(/^\s*(\d+)\s+(.*)$/);
          if (!m) continue;
          if (m[2].includes(marker + ' ') || m[2].endsWith(marker)) {
            try { process.kill(parseInt(m[1], 10), 'SIGKILL'); } catch {}
          }
        }
      }
      setTimeout(resolve, 500); // give the OS a beat to release the lock
    });
  });
}

function curlFetch(url) {
  return new Promise(res => {
    execFile('curl', ['-s', '-L', '--compressed', '--max-time', '20', '-w', '\n%{http_code}', '-H', 'User-Agent: ' + UA, url],
      { maxBuffer: 32 * 1024 * 1024 }, (e, out) => {
        if (e) return res(null);
        const i = out.lastIndexOf('\n');
        const code = parseInt(out.slice(i + 1).trim(), 10);
        res({ code: Number.isFinite(code) ? code : 0, body: out.slice(0, i) });
      });
  });
}

// ponytail: naive tag strip for --text on the curl rung (no DOM there); browser rung uses real innerText
const htmlToText = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n\s*\n+/g, '\n')
  .trim();

(async () => {
  const argv = process.argv.slice(2);
  const flags = { text: false, stealth: false, selector: '', out: '', maxBytes: 200000, wait: 1500 };
  const urls = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') flags.text = true;
    else if (a === '--stealth') flags.stealth = true;
    else if (a === '--selector') flags.selector = argv[++i];
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--max-bytes') flags.maxBytes = parseInt(argv[++i], 10);
    else if (a === '--wait') flags.wait = parseInt(argv[++i], 10);
    else urls.push(a);
  }
  if (!urls.length || urls.some(u => !/^https?:\/\//.test(u))) die('Usage: node scripts/fetch.js <url> [url2 ...] [--text] [--stealth] [--selector CSS] [--out FILE] [--max-bytes N] [--wait MS]', 2);
  if (flags.out && urls.length > 1) die('--out works with a single URL only', 2);

  let ctx = null, page = null;

  async function ensureBrowser() {
    if (page) return page;
    const profileDir = path.join(os.homedir(), '.cache', 'blocked-fetch-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    if (flags.stealth) {
      // Rung 4: CloakBrowser stealth Chromium (C++-level fingerprint patches)
      try {
        const { launchPersistentContext } = loadOptional('cloakbrowser');
        ctx = await launchPersistentContext({
          userDataDir: profileDir + '-stealth',
          headless: true,
          ...(process.env.CLOAKBROWSER_PROXY ? {
            licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY,
            proxy: process.env.CLOAKBROWSER_PROXY,
            geoip: true,
          } : {}),
        });
      } catch (e) {
        die('[!] stealth mode failed: ' + e.message + ' — npm install cloakbrowser, or retry without --stealth', 2);
      }
    } else {
      const { chromium } = loadPlaywright();
      const opts = {
        executablePath: findBrowser(),
        headless: true,
        viewport: { width: 1280, height: 800 },
        userAgent: UA,
        args: ['--disable-blink-features=AutomationControlled'],
      };
      try { ctx = await chromium.launchPersistentContext(profileDir, opts); }
      catch (e) {
        if (!/ProcessSingleton|Singleton/i.test(e.message)) die('Failed to launch browser: ' + e.message, 2);
        console.error('[#] orphan browser holds the profile lock — killing it and retrying');
        await killProfileOrphans(profileDir);
        try { ctx = await chromium.launchPersistentContext(profileDir, opts); }
        catch (e2) { die('Failed to launch browser: ' + e2.message, 2); }
      }
    }
    page = ctx.pages()[0] || await ctx.newPage();
    return page;
  }

  async function goto(p, url) {
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await p.waitForTimeout(flags.wait); // ponytail: fixed settle delay; raise with --wait for slow sites
    const body = await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    return { resp, body };
  }

  const isBlocked = (resp, body) => (resp && [403, 429, 503].includes(resp.status())) || BLOCK_PAT.test(body.slice(0, 500));

  // Any real page on the target domain (reached via a search-result redirect) sets the session cookie.
  async function findHop(p, host) {
    const engines = [
      ['ddg-html', `https://html.duckduckgo.com/html/?q=${encodeURIComponent('site:' + host)}`, () => document.querySelector('.result__a')?.href || ''],
      ['ddg-lite', `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent('site:' + host)}`, () => document.querySelector('a.result-link')?.href || ''],
      ['bing', `https://www.bing.com/search?q=${encodeURIComponent('site:' + host)}`, () => document.querySelector('li.b_algo h2 a')?.href || ''],
    ];
    for (const [name, engineUrl, getHref] of engines) {
      const { body } = await goto(p, engineUrl);
      if (/challenge|captcha|squares containing/i.test(body.slice(0, 400))) {
        console.error(`[#] ${name} challenged us too, next engine...`);
        continue;
      }
      const href = await p.evaluate(getHref).catch(() => '');
      if (href) { console.error(`[#] hopping via ${name}`); return href; }
    }
    return '';
  }

  function emit(body) {
    let text = String(body);
    if (!flags.text && !flags.selector) {
      try { text = JSON.stringify(JSON.parse(text)); } catch {} // compact: pipe through jq for readability
    }
    if (flags.out) { fs.writeFileSync(flags.out, text); console.error('[ok] written to ' + flags.out); return; }
    if (text.length > flags.maxBytes) {
      console.log(text.slice(0, flags.maxBytes));
      console.error(`[!] truncated at ${flags.maxBytes} of ${text.length} bytes — use --max-bytes N or --out FILE`);
    } else console.log(text);
  }

  async function finish(p, body) {
    if (flags.selector) {
      const items = await p.evaluate(sel => [...document.querySelectorAll(sel)].slice(0, 500).map(el => {
        const o = { text: (el.innerText || '').trim().slice(0, 300) };
        if (el.tagName === 'A' && el.href) o.href = el.href;
        return o;
      }), flags.selector).catch(e => { console.error('[!] selector failed: ' + e.message); return null; });
      if (items === null) return false;
      emit(JSON.stringify(items));
      return true;
    }
    emit(body);
    return true;
  }

  async function fetchOne(url) {
    // Rung 1: curl with browser UA (skipped when a DOM selector is requested)
    if (!flags.selector) {
      const r1 = await curlFetch(url);
      const blocked = !r1 || [403, 429, 503].includes(r1.code) || BLOCK_PAT.test(r1.body.slice(0, 800));
      if (r1 && r1.code === 200 && !blocked) return (emit(flags.text ? htmlToText(r1.body) : r1.body), true);
      if (r1 && r1.code !== 200 && !blocked) { emit(r1.body || ('(http ' + r1.code + ')')); return false; } // real status, not a block
    }
    const p = await ensureBrowser();
    // Rung 2: direct browser
    let { resp, body } = await goto(p, url);
    if (resp && resp.status() === 429) { console.error('[#] 429, backing off 10s'); await sleep(10000); ({ resp, body } = await goto(p, url)); }
    if (!isBlocked(resp, body)) return finish(p, body);
    // Rung 3: search hop
    console.error(`[#] direct access blocked (${resp ? resp.status() : 'no response'}), trying search hop for ${new URL(url).hostname}...`);
    const hop = await findHop(p, new URL(url).hostname);
    if (!hop) { console.error('[!] no hop available — retry with --stealth (CloakBrowser) or a residential proxy'); return false; }
    await goto(p, hop); await sleep(2000);
    ({ resp, body } = await goto(p, url));
    if (isBlocked(resp, body)) { console.error('[!] still blocked after hop — retry with --stealth (CloakBrowser) or a residential proxy'); return false; }
    return finish(p, body);
  }

  let failures = 0;
  for (let i = 0; i < urls.length; i++) {
    if (urls.length > 1) console.error('### ' + urls[i]);
    if (!(await fetchOne(urls[i]))) failures++;
    if (i < urls.length - 1) await sleep(2000); // no parallel fetches — Reddit & co. rate-limit hard
  }
  if (ctx) await ctx.close().catch(() => {});
  process.exit(failures ? 1 : 0);
})();
