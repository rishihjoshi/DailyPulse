// Render-boundary XSS guards for app.js. Run: node --test scripts/test-sanitize.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, newsItem } from '../docs/app.js';   // esc is covered via newsItem

test('safeUrl strips javascript: and other non-http(s) schemes', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('JavaScript:alert(1)'), '#');       // scheme is case-insensitive
  assert.equal(safeUrl(' javascript:alert(1)'), '#');       // leading space before scheme
  assert.equal(safeUrl('data:text/html,<script>'), '#');
  assert.equal(safeUrl('vbscript:msgbox'), '#');
  assert.equal(safeUrl(undefined), '#');
});

test('safeUrl preserves real article links', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('http://news.local/x'), 'http://news.local/x');
});

test('newsItem never emits a javascript: href', () => {
  const html = newsItem({ link: 'javascript:alert(document.cookie)', title: 'Breaking' });
  assert.ok(!/href="javascript:/i.test(html), 'javascript: URL leaked into href');
  assert.ok(html.includes('href="#"'), 'bad URL should degrade to href="#"');
});

test('esc still neutralizes HTML in text fields', () => {
  const html = newsItem({ link: 'https://x.com', title: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>'), 'unescaped <script> in title');
  assert.ok(html.includes('&lt;script&gt;'));
});
