const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { toMarkdown, htmlToText, pdfToText } = require('../lib/md');

const vi = fs.readFileSync(path.join(__dirname, '..', 'testdata', 'd.html'), 'utf8');
test('toMarkdown: article tiếng Việt giữ dấu, có heading', () => {
  const md = toMarkdown(vi);
  assert.ok(md.includes('Bài viết'));
  assert.ok(md.includes('Tiếng Việt'));
  assert.ok(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/.test(md));
});
test('toMarkdown: trang stub <200 textContent → fallback full-body', () => {
  const md = toMarkdown('<html><body><h1>Stub</h1></body></html>');
  assert.ok(md.includes('Stub'));
});
test('htmlToText: strip tags', () => {
  assert.strictEqual(htmlToText('<p>a<b>b</b></p>').replace(/\s+/g, ' ').trim(), 'a b');
});
test('pdfToText: fixture có text-layer', async () => {
  const bytes = fs.readFileSync(path.join(__dirname, '..', 'testdata', 'doc.pdf'));
  const text = await pdfToText(bytes);
  assert.ok(text.toLowerCase().includes('opencrab'));
});
