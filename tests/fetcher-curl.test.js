// tests/fetcher-curl.test.js — Task 2: curl rung contract (spec §4)
const test = require('node:test');
const assert = require('node:assert');
const { serveFixture } = require('./serve');
const { fetch } = require('../lib/fetcher');

process.env.OPENCRAB_HOP = 'off';
process.env.OPENCRAB_STATE_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'oc-st-t2-')); // pidfile/profile riêng — tránh đua với test file khác (node --test chạy song song)

test('curl rung: ok html page, contract fields', async () => {
  const s = await serveFixture();
  const r = await fetch(s.url + '/a.html');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.via, 'curl');
  assert.strictEqual(r.hopped, false);
  assert.match(r.contentType, /text\/html/);
  assert.ok(Buffer.isBuffer(r.bytes) && r.bytes.length > 0);
  assert.strictEqual(r.html, null); // curl rung: html/text = null — suy ra chuỗi là việc của md.js (Task 4)
  assert.strictEqual(r.text, null);
  assert.ok(typeof r.finalUrl === 'string' && r.finalUrl.includes('/a.html'));
  assert.ok(r.ms > 0);
  await s.close();
});

test('curl rung: 404 → status http:404, not ok', async () => {
  const s = await serveFixture();
  const r = await fetch(s.url + '/nope.html');
  assert.strictEqual(r.status, 'http:404');
  assert.strictEqual(r.ok, false);
  await s.close();
});

test('curl rung: conditional 304 → http:304', async () => {
  // Inline mini-server trả 304 cho MỌI If-Modified-Since (serve.js cố ý KHÔNG hỗ trợ IMS — Task 8 phụ thuộc điều đó)
  const http = require('http');
  const srv = http.createServer((req, res) => {
    if (req.headers['if-modified-since']) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Last-Modified': 'Thu, 01 Jan 2026 00:00:00 GMT' });
    res.end('<h1>x</h1>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const first = await fetch(base + '/');
  assert.strictEqual(first.lastModified, 'Thu, 01 Jan 2026 00:00:00 GMT');
  const again = await fetch(base + '/', { conditional: { lastModified: first.lastModified } });
  assert.strictEqual(again.status, 'http:304');
  await new Promise(r => srv.close(r));
});

// Test "blocked body → leo browser" nằm ở Task 3 — fetch() ESCALATE khi bị chặn, không trả 'blocked' từ rung curl.
