// tests/resume.test.js — Task 8: --resume + --changed-only e2e (spec §6.6/§9) qua CLI
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process');
const { serveFixture } = require('./serve');
// execFile (async) KHÔNG PHẢI execFileSync: fixture server chạy trong process này — spawnSync block event loop
// → server không bao giờ trả lời → crawl con timeout từng curl 20s rồi leo browser (chết đứng, đã bắt tại hiện trường)
const run = (args, env = {}) => new Promise((res, rej) =>
  execFile('node', [path.join(__dirname, '..', 'scripts', 'opencrab.js'), ...args],
    { env: { ...process.env, OPENCRAB_HOP: 'off', ...env }, encoding: 'utf8' },
    (e, out, errOut) => e ? rej(Object.assign(e, { stdout: out, stderr: errOut })) : res(out)));

test('resume: n resumed=5 + robots memo, no new rows', { timeout: 240000 }, async t => {
  const s = await serveFixture(); t.after(() => s.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-t8-'));
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-st-'));
  // run 1 POLITE (không aggressive): robots được tôn trọng → blocked.html = dòng robots → run resume memo đúng
  await run(['crawl', s.url + '/', '--out', dir], { OPENCRAB_STATE_DIR: st });
  const idxBefore = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8');
  const out = await run(['crawl', s.url + '/', '--out', dir, '--resume'], { OPENCRAB_STATE_DIR: st });
  assert.match(out, /resumed=5/);
  assert.match(out, /robots=1/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8'), idxBefore); // không dòng mới
});
test('changed-only 2 lần: lần 2 toàn unchanged', { timeout: 240000 }, async t => {
  const s = await serveFixture(); t.after(() => s.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-t8b-'));
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stb-'));
  await run(['crawl', s.url + '/', '--out', dir], { OPENCRAB_STATE_DIR: st });
  const out2 = await run(['crawl', s.url + '/', '--out', dir, '--changed-only'], { OPENCRAB_STATE_DIR: st });
  assert.match(out2, /unchanged=5/);
});
test('resume seed khác index → exit 2', { timeout: 240000 }, async t => {
  const s = await serveFixture(); t.after(() => s.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-t8c-'));
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stc-'));
  await run(['crawl', s.url + '/', '--out', dir], { OPENCRAB_STATE_DIR: st });
  const idx = path.join(dir, 'index.jsonl');
  const lines = fs.readFileSync(idx, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(idx, [JSON.stringify({ seed: 'http://example.org/other', ts: 0 }), ...lines.slice(1)].join('\n') + '\n'); // header = dòng 1
  const err = await run(['crawl', s.url + '/', '--out', dir, '--resume'], { OPENCRAB_STATE_DIR: st }).catch(e => e);
  assert.strictEqual(err.code, 2);
  assert.match(String(err.stderr), /different seed/);
});
// Lưu ý: fixture Crawl-delay 5s → mỗi lần crawl polite ~25-30s; timeout 240s dư dả. node:http không hỗ trợ IMS
// → changed-only đi đường fetch-đầy-đủ + so hash (không 304) — đúng như engine xử lý hai nhánh.

test('NaN numeric flags → exit 2 (usage)', { timeout: 60000 }, async t => {
  const http = require('http');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<a href="/x">x</a>'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const s = { url: `http://127.0.0.1:${srv.address().port}` };
  t.after(() => new Promise(r => srv.close(r)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-t8d-'));
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-std-'));
  for (const bad of [['--limit', 'abc'], ['--depth', 'abc'], ['--delay', 'abc']]) {
    const err = await run(['crawl', s.url + '/', '--out', dir, ...bad], { OPENCRAB_STATE_DIR: st }).catch(e => e);
    assert.strictEqual(err.code, 2, bad.join('=') + ' → ' + err.code);
  }
});
