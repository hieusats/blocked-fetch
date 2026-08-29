// tests/crawl.test.js — Task 7: normalize/robots/BFS (spec §6)
const test = require('node:test');
const assert = require('node:assert');
const { serveFixture } = require('./serve');
const { normalizeUrl, loadRobots, crawlBFS } = require('../lib/crawl');
process.env.OPENCRAB_HOP = 'off';
process.env.OPENCRAB_STATE_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'oc-st-t7-')); // riêng cho file test này (chạy song song)

test('normalizeUrl', () => {
  assert.strictEqual(normalizeUrl('https://Example.com/page/?utm_source=x&fbclid=1#frag'), 'https://example.com/page');
  assert.strictEqual(normalizeUrl('https://example.com/'), 'https://example.com/');
});
test('robots: blocked.html disallowed, crawl-delay 5s', async () => {
  const s = await serveFixture();
  const rb = await loadRobots(s.url);
  assert.strictEqual(rb.allowed('/a.html'), true);
  assert.strictEqual(rb.allowed('/blocked.html'), false);
  assert.strictEqual(rb.crawlDelayMs, 5000);
  await s.close();
});
test('crawlBFS aggressive: robots bị bỏ → blocked.html ĐƯỢC fetch → failed=1; 5 trang ok', { timeout: 90000 }, async () => {
  const s = await serveFixture();
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-t7-'));
  const sum = await crawlBFS(s.url + '/', { outDir: dir, limit: 50, depth: 2, delayMs: 0, aggressive: true });
  assert.deepStrictEqual(sum, { ok: 5, failed: 1, http: 0, unchanged: 0, skippedRobots: 0, dup: 0, resumed: 0 });
  await s.close();
});
// Lưu ý: aggressive fetch blocked.html → leo browser (hop off) → blocked → failed=1 (không phải robots-skip)
// Bản polite (5 file + 1 robots-skip, exit 0) là selftest e2e Task 7 Step 4

test('politeness: delay trước MỌI request thật, kể cả 404 (trước đây 0ms)', { timeout: 60000 }, async () => {
  const times = [];
  const http = require('http');
  const srv = http.createServer((req, res) => {
    times.push([req.url, Date.now()]);
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<a href="/a">a</a><a href="/b">b</a>'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'oc-t7d-'));
  const base = `http://127.0.0.1:${srv.address().port}`;
  await crawlBFS(base + '/', { outDir: dir, limit: 10, depth: 1, delayMs: 300 });
  await new Promise(r => srv.close(r));
  const pageTimes = times.filter(([u]) => u !== '/robots.txt' && u !== '/sitemap.xml').map(e => e[1]); // sitemap-probe là metadata (sitemap-delay đã ledgered, cố ý)
  assert.ok(pageTimes.length >= 3, 'phải fetch /, /a, /b: ' + pageTimes.length);
  for (let i = 1; i < pageTimes.length; i++) assert.ok(pageTimes[i] - pageTimes[i - 1] >= 250, `gap ${i} = ${pageTimes[i] - pageTimes[i - 1]}ms < 250`);
});
