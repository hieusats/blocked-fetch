// tests/search-extract.test.js — Task 9: extract named selectors (jsdom, textContent cap) (spec §4)
// searchResults là mạng-đời → không unit test offline; cover bằng selftest-live.sh (brief Task 9)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process'); // execFile async, KHÔNG execFileSync — fixture server chạy trong process này (bài học T8, tests/resume.test.js:6)
const { serveFixture } = require('./serve');
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-st-t9-')); // riêng cho file test này (chạy song song, escalation có đụng pidfile)
process.env.OPENCRAB_HOP = 'off';
const run = (args) => new Promise((res, rej) =>
  execFile('node', [path.join(__dirname, '..', 'scripts', 'opencrab.js'), ...args],
    { env: { ...process.env, OPENCRAB_STATE_DIR: STATE_DIR }, encoding: 'utf8' },
    (e, out, errOut) => e ? rej(Object.assign(e, { stdout: out, stderr: errOut })) : res(out)));

test('extract: named selectors qua jsdom', { timeout: 60000 }, async t => {
  const s = await serveFixture(); t.after(() => s.close());
  const out = await run(['extract', s.url + '/a.html', '--selector', 'h1=h1', '--selector', 'p=p']);
  const j = JSON.parse(out);
  assert.deepStrictEqual(j.h1, [{ text: 'Page A' }]);
  assert.ok(j.p[0].text.includes('Alpha'));
});
test('extract cross-host external link href', { timeout: 60000 }, async t => {
  const s = await serveFixture(); t.after(() => s.close());
  const out = await run(['extract', s.url + '/c.html', '--selector', 'ext=a']);
  const j = JSON.parse(out);
  assert.strictEqual(j.ext[0].href, 'https://example.com/external');
});
