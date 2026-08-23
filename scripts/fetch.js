#!/usr/bin/env node
// fetch.js — fetch a URL through a real browser session, bypassing bot blocks.
// Auto-performs a DuckDuckGo-hop unlock when the target blocks direct access.
// Usage: node scripts/fetch.js <url> [--text]
//   --text  print page text without trying JSON.parse
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
  if (!url || !/^https?:\/\//.test(url)) die('Usage: node scripts/fetch.js <url> [--text]', 2);

  const { chromium } = loadPlaywright();
  const browserPath = findBrowser();
  const profileDir = path.join(os.homedir(), '.cache', 'blocked-fetch-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: browserPath,
    headless: true,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled'],
  }).catch(e => die('Failed to launch browser: ' + e.message, 2));
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

  // 2) DuckDuckGo-hop: land on the target site via a DDG result redirect to set session cookies
  const host = new URL(url).hostname;
  console.error(`[#] direct access blocked (${resp ? resp.status() : 'no response'}), trying DuckDuckGo hop for ${host}...`);
  const ddg = await goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent('site:' + host)}`);
  const hopHref = await page.evaluate(() => document.querySelector('.result__a')?.href || '').catch(() => '');
  if (!hopHref) { await ctx.close(); die('[!] no DDG result to hop through; site may be fully hard-blocked'); }

  await goto(hopHref); // sets the session cookie on target domain
  await page.waitForTimeout(2000);

  // 3) retry target
  ({ resp, body } = await goto(url));
  if (isBlocked(resp, body)) {
    await ctx.close();
    die('[!] still blocked after hop: ' + JSON.stringify(body.slice(0, 200)));
  }
  output(body);
  await ctx.close();

  function output(text) {
    if (wantText) { console.log(text); return; }
    try { console.log(JSON.stringify(JSON.parse(text))); } // compact: pipe through jq for readability
    catch { console.log(text); }
  }
})();
