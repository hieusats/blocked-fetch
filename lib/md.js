// lib/md.js — markdown pipeline (spec §7)
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const TurndownService = require('turndown');
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

// ponytail: naive tag strip (giữ nguyên từ fetch.js v1 — chỉ dùng cho --text rung curl)
const htmlToText = h => String(h)
  .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

function toMarkdown(html) {
  let content = null;
  try {
    const doc = new JSDOM(html).window.document;
    const article = new Readability(doc).parse();
    if (article && (article.textContent || '').length >= 200) content = article.content;
  } catch {}
  return td.turndown(content || html);
}
async function pdfToText(bytes) {
  const { extractText, getDocumentProxy } = require('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return (text || '').trim();
}
module.exports = { htmlToText, toMarkdown, pdfToText };
