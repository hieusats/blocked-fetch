#!/usr/bin/env node
// fetch.js — fetch a URL through a real browser session, bypassing bot blocks.
// Auto-performs a DuckDuckGo-hop unlock when the target blocks direct access.
// Usage: node scripts/fetch.js <url> [--text] [--stealth]
//   --text    print page text without trying JSON.parse
//   --stealth use CloakBrowser stealth Chromium (npm i cloakbrowser) — for sites
//             that detect even a real browser (Cloudflare Turnstile, FingerprintJS)
// Exit codes: 0 ok, 1 blocked/unreachable, 2 usage/setup error.

const fs = require('fs');
const path = require('path');
const os = require('os');

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

const BLOCK_PAT = /you'?ve been blocked|network security|access denied|are you a robot|robot check|unusual traffic|verify you are human|challenge-platform|captcha/i;

(async () => {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  const wantText = args.includes('--text');
  const wantStealth = args.includes('--stealth');
  if (!url || !/^https?:\/\//.test(url)) die('Usage: node scripts/fetch.js <url> [--text]', 2);

  const { chromium } = loadPlaywright();
  const browserPath = findBrowser();
  const profileDir = path.join(os.homedir(), '.cache', 'blocked-fetch-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  let ctx;
  if (wantStealth) {
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
    ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath: browserPath,
      headless: true,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      args: ['--disable-blink-features=AutomationControlled'],
    }).catch(async e => {
      // A crashed previous run can leave an orphan browser holding the profile's
      // singleton lock. Recover once: kill orphans using OUR profile dir, retry.
      if (/ProcessSingleton|Singleton/i.test(e.message)) {
        await killProfileOrphans(profileDir);
        return chromium.launchPersistentContext(profileDir, {
          executablePath: browserPath,
          headless: true,
          viewport: { width: 1280, height: 800 },
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          args: ['--disable-blink-features=AutomationControlled'],
        });
      }
      throw e;
    }).catch(e => die('Failed to launch browser: ' + e.message, 2));
  }
  const page = ctx.pages()[0] || await ctx.newPage();

  const readBody = () => page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const isBlocked = (resp, body) => (resp && [403, 429, 503].includes(resp.status())) || BLOCK_PAT.test(body.slice(0, 500));

  async function goto(u) {
    const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await page.waitForTimeout(1500); // ponytail: fixed settle delay; make configurable if slow sites need more
    const body = await readBody();
    return { resp, body };
  }

  // 1) direct attempt
  let { resp, body } = await goto(url);
  if (!isBlocked(resp, body)) {
    output(body);
    await ctx.close();
    return;
  }

  // 2) search-hop unlock: land on the target site via a search-result redirect to set session cookies.
  //    Multiple engines because any single one (notably DDG) can rate-limit/challenge the hop itself.
  const host = new URL(url).hostname;
  console.error(`[#] direct access blocked (${resp ? resp.status() : 'no response'}), trying search hop for ${host}...`);
  const HOP_ENGINES = [
    ['ddg-html', `https://html.duckduckgo.com/html/?q=${encodeURIComponent('site:' + host)}`, () => document.querySelector('.result__a')?.href || ''],
    ['ddg-lite', `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent('site:' + host)}`, () => document.querySelector('a.result-link')?.href || ''],
    ['bing', `https://www.bing.com/search?q=${encodeURIComponent('site:' + host)}`, () => document.querySelector('li.b_algo h2 a')?.href || ''],
  ];
  let hopHref = '';
  for (const [name, engineUrl, getHref] of HOP_ENGINES) {
    await goto(engineUrl);
    const engBody = await readBody();
    if (/challenge|captcha|squares containing/i.test(engBody.slice(0, 400))) {
      console.error(`[#] ${name} challenged us too, next engine...`);
      continue;
    }
    hopHref = await page.evaluate(getHref).catch(() => '');
    if (hopHref) { console.error(`[#] hopping via ${name}`); break; }
  }
  if (!hopHref) { await ctx.close(); die('[!] no search result to hop through; site may be fully hard-blocked'); }

  await goto(hopHref); // redirect lands on target domain, sets the session cookie
  await page.waitForTimeout(2000);

  // 3) retry target
  ({ resp, body } = await goto(url));
  if (isBlocked(resp, body)) {
    await ctx.close();
    die('[!] still blocked after hop: ' + JSON.stringify(body.slice(0, 200)) + ' — retry with --stealth (CloakBrowser) or add a residential proxy');
  }
  output(body);
  await ctx.close();

  function output(text) {
    if (wantText) { console.log(text); return; }
    try { console.log(JSON.stringify(JSON.parse(text))); } // compact: pipe through jq for readability
    catch { console.log(text); }
  }
})();

function loadOptional(name) {
  const local = path.join(__dirname, '..', 'node_modules', name);
  try { return require(local); } catch {}
  return require(name);
}

// Kill chromium processes using exactly this profile dir (scoped: never touches
// the user's real browser). Linux-only; other platforms surface the launch error instead.
function killProfileOrphans(profileDir) {
  if (process.platform !== 'linux') return Promise.resolve();
  return new Promise(resolve => {
    require('child_process').execFile('ps', ['-eo', 'pid,args'], (e, out) => {
      if (!e) {
        const marker = '--user-data-dir=' + profileDir;
        for (const line of out.split('\n')) {
          const m = line.match(/^\s*(\d+)\s+(.*)$/);
          if (!m) continue;
          const args = m[2];
          if (args.includes(marker + ' ') || args.endsWith(marker)) {
            try { process.kill(parseInt(m[1], 10), 'SIGKILL'); } catch {}
          }
        }
      }
      setTimeout(resolve, 500); // give the OS a beat to release the lock
    });
  });
}
