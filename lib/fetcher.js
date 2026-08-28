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

async function fetch(url, opts = {}) {
  const t0 = Date.now();
  if (opts.forceBrowser) return browserFetch(url, opts, t0); // ép rung browser (spec §4 — wrapper --selector, --wait-for, --screenshot); lỗi ở đây sẽ được try/catch bên dưới bắt nếu không force
  const r1 = await curlFetch(url, opts);
  if (r1) {
    const body = r1.bytes;
    const contentType = headerValue(r1.dump, 'Content-Type') || '';
    if (r1.code === 304) return { ok: false, status: 'http:304', via: 'curl', hopped: false, finalUrl: r1.effUrl, contentType, etag: headerValue(r1.dump, 'ETag') || null, lastModified: headerValue(r1.dump, 'Last-Modified') || null, bytes: Buffer.alloc(0), html: null, text: null, ms: Date.now() - t0 };
    if (r1.code === 200 && !blockedStatus(r1.code, body)) return { ok: true, status: 'ok', via: 'curl', hopped: false, finalUrl: r1.effUrl, contentType, etag: headerValue(r1.dump, 'ETag') || null, lastModified: headerValue(r1.dump, 'Last-Modified') || null, bytes: body, html: null, text: null, ms: Date.now() - t0 };
    if (!blockedStatus(r1.code, body)) return { ok: false, status: 'http:' + r1.code, via: 'curl', hopped: false, finalUrl: r1.effUrl, contentType, etag: headerValue(r1.dump, 'ETag') || null, lastModified: headerValue(r1.dump, 'Last-Modified') || null, bytes: body, html: null, text: null, ms: Date.now() - t0 };
    // predicate bị chặn → rơi xuống leo rung browser (spec §4 ladder)
  }
  console.error('[#] curl rung failed (error/oversize) — escalating to browser'); // spec §4 stderr note
  try { return await browserFetch(url, opts, t0); }
  catch (err) {
    if (err instanceof SetupError) throw err; // setup (pidfile/cloak/chromium) → bin map exit 2 (spec §5)
    return { ok: false, status: 'error:' + String(err.message || err).slice(0, 200), via: opts.stealth ? 'stealth' : 'browser', hopped: false, finalUrl: url, contentType: '', etag: null, lastModified: null, bytes: Buffer.alloc(0), html: null, text: null, ms: Date.now() - t0 }; // spec §4: exception sanitize
  }
}
module.exports = { fetch, SetupError, UA, BLOCK_PAT, stateDir };
