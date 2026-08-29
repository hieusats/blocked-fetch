// tests/fetcher-browser.test.js — Task 3: browser rung (spec §3-§4)
const test = require('node:test');
const assert = require('node:assert');
const { serveFixture } = require('./serve');
const { fetch, close } = require('../lib/fetcher');
process.env.OPENCRAB_HOP = 'off';
process.env.OPENCRAB_STATE_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'oc-st-t3-')); // pidfile/profile riêng — tránh đua với test file khác (node --test chạy song song)

test('blocked page escalates curl→browser, hop off → blocked', { timeout: 90000 }, async () => {
  const s = await serveFixture(); // OPENCRAB_HOP=off đã set bởi selftest; node --test chạy trực tiếp cần set
  process.env.OPENCRAB_HOP = 'off';
  const r = await fetch(s.url + '/blocked.html');
  assert.strictEqual(r.status, 'blocked');
  assert.strictEqual(r.via, 'browser');   // rung cuối được thử
  assert.ok(r.html.includes('blocked'));  // page.content() được bắt (spec §4)
  await s.close(); await close();
});

test('browser rung captures html + innerText', { timeout: 90000 }, async () => {
  const s = await serveFixture();
  const r = await fetch(s.url + '/a.html', { forceBrowser: true });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.via, 'browser');
  assert.ok(r.html.includes('Page A'));
  assert.ok(r.text.includes('Page A'));
  await s.close(); await close();
});

// fix-round-1: forceBrowser path must go through the same catch-all — non-SetupError → error:msg envelope, không throw raw
test('forced browser failure sanitizes to error:msg (no raw throw)', { timeout: 90000 }, async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const prevDir = process.env.OPENCRAB_STATE_DIR;
  await close(); // drop cached page để ensureBrowser chạy lại
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-st-t3-fix1-'));
  fs.writeFileSync(path.join(dir, 'profile'), 'not-a-dir'); // profile path là FILE → mkdirSync ném EEXIST (không phải SetupError)
  process.env.OPENCRAB_STATE_DIR = dir;
  try {
    const r = await fetch('http://127.0.0.1:1/x.html', { forceBrowser: true });
    assert.strictEqual(r.ok, false);
    assert.ok(r.status.startsWith('error:'), 'status=' + r.status);
    assert.strictEqual(r.via, 'browser');
  } finally { process.env.OPENCRAB_STATE_DIR = prevDir; }
});
