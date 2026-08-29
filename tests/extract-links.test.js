// tests/extract-links.test.js — pin hợp đồng extractLinks (regex dễ drift — crawl coverage phụ thuộc nó)
const test = require('node:test');
const assert = require('node:assert');
const { extractLinks } = require('../lib/fetcher');

const B = 'https://ex.com/dir/';

test('extractLinks: quoted, single-quoted, unquoted, fragment, data-href', () => {
  const html = '<a href="https://other.com/x?y=1">1</a>'
    + "<a href='/rel/page'>2</a>"
    + '<a href=/unq#frag>3</a>'
    + '<a href="#top">4</a>'
    + '<a data-href="/phantom">5</a>'
    + '<A HREF="/upper">6</A>';
  const got = extractLinks(html, B);
  assert.ok(got.includes('https://other.com/x?y=1'), 'absolute');
  assert.ok(got.includes('https://ex.com/rel/page'), 'single-quoted relative');
  assert.ok(got.includes('https://ex.com/unq#frag'), 'unquoted + fragment (normalizeUrl strip sau)');
  assert.ok(got.includes(B + '#top'), 'pure anchor → base');
  assert.ok(!got.some(u => u.includes('phantom')), 'data-href không phải link');
  assert.ok(got.includes('https://ex.com/upper'), 'HREF hoa');
});
