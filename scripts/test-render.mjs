// Unit tests for the pure render helpers in app.js. Run: node --test scripts/test-render.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWeather, renderAlerts, renderWatch, rankedBlock, freshness,
         newsItem, topStory, parseHash, diffNew, nextTheme, fmtRun, TABS, isSha,
         shouldRefresh } from '../docs/app.js';

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

test('a story with a body collapses; one without stays a plain article', () => {
  const withBody = newsItem({ title: 'Oil tops $111', summary: 'Brent rose above $111.',
    link: 'https://x/1', sources: [{ source: 'Reuters', link: 'https://x/1' }] }, 2, 1);
  assert.match(withBody, /^<details class="item"/, 'collapsible when there is something to reveal');
  assert.ok(withBody.includes('<summary>'), 'needs a summary element to be operable');
  assert.ok(withBody.includes('class="chev"') && withBody.includes('aria-hidden="true"'),
    'the chevron is decorative and must be hidden from screen readers');
  assert.ok(withBody.includes('class="reveal"'));
  assert.ok(withBody.includes('Brent rose above $111.'));

  // No body -> no disclosure arrow that reveals nothing.
  const noBody = newsItem({ title: 'Headline only', link: 'https://x/2', sources: [] });
  assert.match(noBody, /^<article class="item"/);
  assert.ok(!noBody.includes('<summary>') && !noBody.includes('chev'));
});

test('the lead story is never collapsed', () => {
  const lead = topStory({ title: 'Lead', summary: 'The lead body.', link: 'https://a', sources: [] });
  assert.ok(lead.includes('Top Story') && lead.includes('The lead body.'));
  assert.ok(!lead.includes('<details'), 'the lead is open prose, not a disclosure');

  const html = rankedBlock([
    { title: 'Lead', summary: 'The lead body.', link: 'https://a', sources: [] },
    { title: 'Second', summary: 'The second body.', link: 'https://b', sources: [] },
  ]);
  assert.equal((html.match(/<details/g) || []).length, 1,
    'exactly the non-lead items collapse');
  assert.ok(html.indexOf('Top Story') < html.indexOf('<details'), 'lead comes first, uncollapsed');
});

test('entrance stagger index is emitted and escapes nothing dangerous', () => {
  assert.ok(newsItem({ title: 'T', summary: 'S', link: 'https://a', sources: [] }, 3, 4)
    .includes('style="--i:4"'), 'stagger index drives animation-delay in CSS');
  // the index is numeric from the renderer, never user data — confirm no interpolation of title
  const evil = newsItem({ title: '"><script>alert(1)</script>', summary: 'S',
    link: 'https://a', sources: [] }, 2, 0);
  assert.ok(!evil.includes('<script>'), 'title still escaped inside summary/h3');
});

test('parseHash routes tabs and archived runs, rejects junk', () => {
  assert.deepEqual(parseHash('#world'), { tab: 'world', sha: null });
  assert.deepEqual(parseHash('world'), { tab: 'world', sha: null }, 'leading # optional');
  assert.deepEqual(parseHash('#history'), { tab: 'history', sha: null });
  assert.deepEqual(parseHash('#local@7eddbe9'), { tab: 'local', sha: '7eddbe9' });
  assert.deepEqual(parseHash('#local@7eddbe91ab31bc9ae9582d1577262c8e13794d9a'),
    { tab: 'local', sha: '7eddbe91ab31bc9ae9582d1577262c8e13794d9a' });
  // unknown tab, bad sha, and injection attempts must not route
  assert.equal(parseHash('#nope'), null);
  assert.equal(parseHash('#local@zzz'), null, 'sha must be hex');
  assert.equal(parseHash('#local@12'), null, 'sha too short');
  assert.equal(parseHash('#<script>'), null);
  assert.equal(parseHash(''), null);
  assert.equal(parseHash(undefined), null);
  assert.ok(TABS.includes('history'), 'History is a real tab');
});

test('diffNew marks only links absent from the previous visit', () => {
  const now = ['https://a/1', 'https://a/2', 'https://a/3'];
  const seen = ['https://a/1', 'https://a/3'];
  const n = diffNew(now, seen);
  assert.equal(n.size, 1);
  assert.ok(n.has('https://a/2'));
  // nothing new when the set is unchanged
  assert.equal(diffNew(now, now).size, 0);
  // no stored set -> caller suppresses, but the diff itself is total
  assert.equal(diffNew(now, []).size, 3);
  assert.equal(diffNew(undefined, undefined).size, 0);
});

test('newsItem flags a story as new only when it is in the new set', () => {
  // newLinks is module state, so drive it through the real render path: a link that
  // was never seen shows the badge once diffNew has populated it.
  const html = newsItem({ title: 'T', summary: 'S', link: 'https://x/1', sources: [] }, 2, 0);
  // default module state has an empty new set -> no badge
  assert.ok(!html.includes('new-dot'), 'nothing is new before a diff has run');
});

test('nextTheme flips away from whatever is currently showing', () => {
  assert.equal(nextTheme(null, false), 'dark',  'system light -> dark');
  assert.equal(nextTheme(null, true), 'light',  'system dark -> light');
  assert.equal(nextTheme('dark', false), 'light');
  assert.equal(nextTheme('light', true), 'dark');
});

test('fmtRun renders an archive timestamp and survives junk', () => {
  const out = fmtRun('2026-10-21T19:22:35Z');
  assert.match(out, /Oct/, 'month should appear');
  assert.equal(fmtRun(''), '', 'empty -> empty, never the words "Invalid Date"');
  assert.equal(fmtRun('not a date'), '', 'unparseable -> empty');
  assert.equal(fmtRun(undefined), '');
  assert.equal(fmtRun(null), '');
});

test('isSha accepts real commit refs and rejects path-traversal attempts', () => {
  assert.ok(isSha('7eddbe9'));
  assert.ok(isSha('7eddbe91ab31bc9ae9582d1577262c8e13794d9a'));
  assert.ok(!isSha('../../main/secrets'), 'must not allow a path segment');
  assert.ok(!isSha('7eddbe9/../x'));
  assert.ok(!isSha('abc'), 'too short');
  assert.ok(!isSha('zzzzzzz'), 'not hex');
  assert.ok(!isSha(''));
  assert.ok(!isSha(undefined));
  assert.ok(!isSha('7eddbe9?x=1'));
});

test('shouldRefresh re-fetches a stale briefing but never disturbs an archived run', () => {
  const MIN = 10 * 60 * 1000;
  const now = 1700000000000;
  // The bug: the digest was fetched once per page load and never again, so a PWA left
  // open overnight still showed yesterday's briefing.
  assert.equal(shouldRefresh(now - 11 * 60 * 1000, now, false), true, 'stale -> refresh');
  assert.equal(shouldRefresh(now - 2 * 60 * 1000, now, false), false, 'fresh -> leave it');
  assert.equal(shouldRefresh(now - MIN, now, false), true, 'exactly at the threshold');
  assert.equal(shouldRefresh(now - 11 * 60 * 1000, now, true), false, 'archive stays pinned');
  assert.equal(shouldRefresh(0, now, false), false, 'nothing loaded yet');
  assert.equal(shouldRefresh(undefined, now, false), false);
});

test('renderWeather hides decorative glyphs from the accessibility tree', () => {
  const html = renderWeather({ high: 77, low: 47, highC: 25, lowC: 8, precip: 0, wind: 4,
    sunrise: '7:17 AM', sunset: '6:12 PM', label: 'Clear', emoji: 'SUNGLYPH' }, 'St. Charles, MO');
  // the condition is already written out as text, so the glyph is redundant announcement
  assert.match(html, /class="emoji" aria-hidden="true"/, 'weather glyph must be hidden');
  assert.ok(html.includes('Clear'), 'the condition stays available as text');
  // sunrise/sunset/wind glyphs each sit in their own aria-hidden span
  const spans = html.match(/<span aria-hidden="true">/g) || [];
  assert.equal(spans.length, 3, 'three decorative glyphs, three aria-hidden spans');
  // the data beside them stays announceable
  for (const v of ['7:17 AM', '6:12 PM', '4 mph', 'St. Charles, MO']) {
    assert.ok(html.includes(v), `${v} must remain readable`);
  }
});
