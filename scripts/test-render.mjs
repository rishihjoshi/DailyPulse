// Unit tests for the pure render helpers in app.js. Run: node --test scripts/test-render.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWeather, renderAlerts, renderWatch, rankedBlock, freshness } from '../docs/app.js';

test('renderWeather shows °F, °C, sunrise, sunset, and wind', () => {
  const html = renderWeather({
    high: 72, low: 54, highC: 22, lowC: 12, precip: 10, wind: 8,
    sunrise: '7:09 AM', sunset: '6:28 PM', label: 'Partly cloudy', emoji: '⛅',
  });
  for (const s of ['72°F', '22°C', '54°F', '12°C', '10%', '7:09 AM', '6:28 PM', '8 mph', 'Partly cloudy', '⛅']) {
    assert.ok(html.includes(s), `missing "${s}" in weather render`);
  }
});

test('renderWeather degrades missing fields to empty, never prints "undefined"', () => {
  const html = renderWeather({ high: 60, emoji: '☀️' }); // sparse object
  assert.ok(!html.includes('undefined'), 'leaked undefined into weather render');
});

test('rankedBlock shows an empty state for no items', () => {
  assert.ok(rankedBlock([]).includes('No stories yet'));
  assert.ok(rankedBlock(undefined).includes('No stories yet'));
});

test('rankedBlock makes the first item the Top Story and lists the rest', () => {
  const html = rankedBlock([
    { title: 'Lead', link: 'https://a', source: 'A', why: 'x' },
    { title: 'Second', link: 'https://b', source: 'B', why: 'y' },
  ]);
  assert.ok(html.includes('Top Story'), 'first item should be the Top Story banner');
  assert.ok(html.includes('Lead') && html.includes('Second'));
});

test('freshness flags a day-old briefing as stale', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const fresh = freshness('2026-10-13T06:00:00Z', now);   // 6h old
  assert.equal(fresh.stale, false);
  assert.ok(!fresh.label.includes('⚠'));

  const old = freshness('2026-10-11T06:00:00Z', now);     // >2 days old
  assert.equal(old.stale, true);
  assert.ok(old.label.includes('⚠') && old.label.includes('may be stale'));

  assert.deepEqual(freshness('garbage', now), { label: '', stale: false });
});

test('renderWeather shows current conditions and the configured place', () => {
  const html = renderWeather({ high: 75, low: 50, highC: 24, lowC: 10, precip: 0, wind: 6,
    sunrise: '7:20 AM', sunset: '6:10 PM', label: 'Mainly clear', emoji: '☀️',
    now: 50, nowLabel: 'Partly cloudy' }, 'St. Charles, MO');
  assert.ok(html.includes('Now 50°F'), 'current temperature should render');
  assert.ok(html.includes('Partly cloudy'));
  assert.ok(html.includes('St. Charles, MO'), 'place must come from the digest, not be hardcoded');
  assert.ok(!html.includes('St. Louis, MO'));
});

test('renderWeather omits the current line when the field is absent', () => {
  const html = renderWeather({ high: 60, emoji: '☀️' });
  assert.ok(!html.includes('Now'), 'no current temp -> no current line');
  assert.ok(!html.includes('undefined'));
});

test('renderAlerts renders nothing when there are no alerts', () => {
  assert.equal(renderAlerts([]), '');
  assert.equal(renderAlerts(undefined), '');
});

test('renderAlerts marks severity and escapes alert text', () => {
  const html = renderAlerts([
    { event: 'Tornado Warning', severity: 'Extreme', headline: 'Take shelter now <script>' },
  ]);
  assert.ok(html.includes('role="alert"'), 'must be announced to screen readers');
  assert.ok(html.includes('sev-extreme'));
  assert.ok(html.includes('Tornado Warning'));
  assert.ok(!html.includes('<script>'), 'alert text must be escaped');
});

test('renderWatch lists the three things, escaped, and is empty when absent', () => {
  assert.equal(renderWatch([]), '');
  const html = renderWatch(['Oil above $110', 'H-4 EAD litigation', '<b>x</b>']);
  assert.ok(html.includes('Oil above $110') && html.includes('H-4 EAD litigation'));
  assert.ok(!html.includes('<b>'), 'watch entries must be escaped');
  assert.equal((html.match(/<li>/g) || []).length, 3);
});
