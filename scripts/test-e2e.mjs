// End-to-end client flow without a real browser: a minimal document + fetch stub
// drives app.js's actual loadDigest() -> render -> tab-switch path on a fixture digest.
// (No Chrome DevTools MCP available in CI; this exercises the real render pipeline.)
// Run: node --test scripts/test-e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- fixture: a realistic digest with one booby-trapped link -----------------
const DIGEST = {
  generatedAt: new Date().toISOString(),  // fresh, so the staleness badge stays off
  location: 'St. Louis, MO',
  weather: {
    high: 72, low: 54, highC: 22, lowC: 12, precip: 10, wind: 8,
    sunrise: '7:09 AM', sunset: '6:28 PM', label: 'Partly cloudy', emoji: '⛅',
  },
  tabs: {
    local: {
      items: [
        { title: 'Local lead', summary: 'A readable brief of the story.', source: 'AP News', link: 'https://ex/1',
          sources: [{ source: 'AP News', link: 'https://ex/1' }, { source: 'BBC', link: 'https://ex/1b' }] },
        { title: 'Evil', summary: 'x', source: 'X', link: 'javascript:alert(document.cookie)',
          sources: [{ source: 'X', link: 'javascript:alert(document.cookie)' }] },
      ],
      stlouis: [{ title: 'STL metro item', summary: 'x', source: 'S', link: 'https://ex/5', sources: [{ source: 'S', link: 'https://ex/5' }] }],
    },
    world: { items: [{ title: 'World lead', summary: 'x', source: 'S', link: 'https://ex/2', sources: [{ source: 'S', link: 'https://ex/2' }] }] },
    india: {
      items: [{ title: 'India lead', summary: 'x', source: 'S', link: 'https://ex/3', sources: [{ source: 'S', link: 'https://ex/3' }] }],
      immigration: [{ title: 'H-1B update', summary: 'x', source: 'S', link: 'https://ex/4', sources: [{ source: 'S', link: 'https://ex/4' }] }],
    },
    finance: {
      items: [{ title: 'Markets lead', summary: 'x', source: 'S', link: 'https://ex/6', sources: [{ source: 'S', link: 'https://ex/6' }] }],
      quotes: [
        { symbol: '^GSPC', name: 'S&P 500', price: 5815.03, changePct: 0.41 },
        { symbol: '^IXIC', name: 'Nasdaq', price: 18502.69, changePct: -0.23 },
      ],
    },
  },
  micro: {
    theme: 'focus',
    cards: [{ title: 'Card one', insight: 'i', takeaway: 't' }],
    ai: [{ title: 'AI lead', summary: 'x', source: 'S', link: 'https://ex/7', sources: [{ source: 'S', link: 'https://ex/7' }] }],
  },
};

// --- minimal DOM/fetch stub (only what app.js actually touches) ---------------
function makeEl() {
  let html = '';
  const handlers = {};
  return {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    textContent: '', scrollTop: 0, hidden: false, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, removeAttribute() {}, focus() {},
    addEventListener(ev, fn) { (handlers[ev] ||= []).push(fn); },
    _fire(ev) { (handlers[ev] || []).forEach(f => f({})); },
    querySelector() { return { addEventListener() {} }; },
  };
}
const els = { main: makeEl(), 'tab-title': makeEl(), updated: makeEl() };
globalThis.document = {
  getElementById: id => (els[id] ||= makeEl()),
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.fetch = async () => ({ ok: true, json: async () => DIGEST });

const { loadDigest, show, showUpdate } = await import('../docs/app.js');

test('loadDigest renders the Local/USA tab with weather, hero, and St. Louis metro', async () => {
  await loadDigest();
  const html = els.main.innerHTML;
  for (const s of ['usa-news.jpg', 'tab-hero', '#1', '#2', '⛅', '72°F', '22°C', '7:09 AM', '6:28 PM', '8 mph',
    'Local lead', 'A readable brief of the story.', 'Read', 'AP News', 'BBC', 'St. Louis Metro', 'STL metro item']) {
    assert.ok(html.includes(s), `Local render missing "${s}"`);
  }
  assert.ok(els.updated.textContent.startsWith('Updated'), 'updated timestamp not set');
});

test('the javascript: link is neutralized end-to-end (never a live href)', () => {
  const html = els.main.innerHTML;
  assert.ok(!/href="javascript:/i.test(html), 'javascript: href leaked through the pipeline');
  assert.ok(html.includes('href="#"'), 'bad link should degrade to href="#"');
});

test('showUpdate reveals the banner once and wires skip-waiting (no duplicate handlers)', () => {
  let posts = 0;
  const reg = { waiting: { postMessage: m => { if (m.type === 'SKIP_WAITING') posts++; } } };
  showUpdate(reg);
  showUpdate(reg);  // second call must no-op via the dataset.shown guard
  const banner = els['update-banner'];
  assert.equal(banner.hidden, false, 'banner should be revealed');
  els['update-btn']._fire('click');
  assert.equal(posts, 1, 'one click → exactly one skip-waiting message (wired once, not twice)');
});

test('switching tabs re-renders the right content', () => {
  show('world');
  assert.ok(els.main.innerHTML.includes('World lead'));

  show('india');
  const india = els.main.innerHTML;
  assert.ok(india.includes('India lead'));
  assert.ok(india.includes('US–India Immigration'));
  assert.ok(india.includes('H-1B update'));

  show('finance');
  const finance = els.main.innerHTML;
  assert.ok(finance.includes('finance-banner.svg'), 'finance hero banner missing');
  assert.ok(finance.includes('Markets lead'), 'finance item missing');
  assert.ok(finance.includes('S&amp;P 500'), 'market quote name missing');   // & is escaped
  assert.ok(finance.includes('+0.41%'), 'market up change missing');
  assert.ok(finance.includes('-0.23%') && finance.includes('quote down'), 'market down change missing');

  show('micro');
  const micro = els.main.innerHTML;
  assert.ok(micro.includes('Card one'));
  assert.ok(micro.includes('Try this'));
  assert.ok(micro.includes('AI News') && micro.includes('AI lead'), 'micro AI news section missing');
});
