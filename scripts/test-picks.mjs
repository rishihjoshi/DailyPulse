// resolvePicks maps model index-picks back to trusted pool items + source links.
// Run: node --test scripts/test-picks.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePicks, splitOutlet, cleanHeadline, JUNK_TITLE, datedWithin } from './build-digest.mjs';

const pool = Array.from({ length: 6 }, (_, i) => ({
  title: `T${i}`, link: `https://x/${i}`, source: `S${i}`, snippet: '',
}));

test('resolves valid picks in order with summary + sources', () => {
  const out = resolvePicks(pool, [{ i: 2, summary: 'because', sources: [2, 0] }, { i: 1, summary: 'also' }], 2);
  assert.deepEqual(out.map(o => o.title), ['T2', 'T1']);
  assert.equal(out[0].summary, 'because');
  assert.equal(out[0].sources.length, 2);                 // two distinct outlets
  assert.ok(out[0].sources.every(s => /^https?:\/\//.test(s.link)));
  assert.equal(out[1].sources.length, 1);                 // only its own index
});

test('orders sources free-outlet first, and primary = a free source', () => {
  const p = [
    { title: 'A', link: 'https://wsj/a', source: 'Wall Street Journal', snippet: '' },
    { title: 'A', link: 'https://ap/a', source: 'AP News', snippet: '' },
  ];
  const out = resolvePicks(p, [{ i: 0, summary: 's', sources: [0, 1] }], 1);
  assert.equal(out[0].sources[0].source, 'AP News', 'free source should lead');
  assert.equal(out[0].source, 'AP News', 'primary link should be the free source');
  assert.equal(out[0].link, 'https://ap/a');
});

test('drops out-of-range/duplicate indices and pads to n', () => {
  const out = resolvePicks(pool, [{ i: 99 }, { i: -1 }, { i: 'x' }, { i: 1 }, { i: 1 }], 3);
  assert.equal(out.length, 3);
  assert.equal(out[0].title, 'T1');
  assert.equal(new Set(out.map(o => o.title)).size, 3);   // no duplicates
  assert.ok(out.every(o => o.title && o.link && o.summary && o.sources.length >= 1));
});

test('handles missing/garbage picks array', () => {
  assert.equal(resolvePicks(pool, undefined, 2).length, 2);
  assert.equal(resolvePicks(pool, null, 2).length, 2);
});

test('uses the model headline when sane, else the feed title, and keeps the original', () => {
  const out = resolvePicks(pool, [
    { i: 0, summary: 's', headline: 'DHS finalizes work-permit extension limits' },
    { i: 1, summary: 's', headline: 'tiny' },            // too short -> reject
  ], 2);
  assert.equal(out[0].title, 'DHS finalizes work-permit extension limits');
  assert.equal(out[0].feedTitle, 'T0', 'original feed title must survive for traceability');
  assert.equal(out[1].title, 'T1', 'junk headline falls back to the feed title');
});

test('splitOutlet pulls the publisher out of a Google News title', () => {
  // The real failure: srcRank never saw "Washington Post", so the paywall rule never fired.
  assert.deepEqual(
    splitOutlet('Russia, sensing victory, cheers Trump’s latest shift - The Washington Post', 'U.S. - Google News'),
    { title: 'Russia, sensing victory, cheers Trump’s latest shift', source: 'The Washington Post' });
  // en-dash separator, as Google also emits
  assert.equal(splitOutlet('Oil tops $111 a barrel – Reuters', 'f').source, 'Reuters');
  // no suffix -> unchanged, feed name retained
  assert.deepEqual(splitOutlet('A plain headline', 'BBC News'),
    { title: 'A plain headline', source: 'BBC News' });
  // must not mangle a hyphenated headline with no outlet
  assert.equal(splitOutlet('Zelenskyy seeks air-defence support', 'BBC News').title,
    'Zelenskyy seeks air-defence support');
});

test('cleanHeadline rejects empty, stubby and summary-length strings', () => {
  assert.equal(cleanHeadline(undefined), '');
  assert.equal(cleanHeadline('   '), '');
  assert.equal(cleanHeadline('too short'), '');                        // < 10 chars
  assert.equal(cleanHeadline('x'.repeat(121)), '');                    // smuggled summary
  assert.equal(cleanHeadline('  “Yemen conflict escalates” '), 'Yemen conflict escalates');
});

test('JUNK_TITLE drops live blogs and match reports but keeps real news', () => {
  const drop = [
    'Kolkata pandal stampede LIVE | Seven accused sent to 10-day police custody',
    'Iran war live: Tehran says Netanyahu seeks more war',
    'Live updates: GOP airs frustration over Russia sanctions',
    'France to deploy military forces during expected weekend protests – Europe live',
    'LIVE: India vs West Indies – fifth T20 International',
    'India vs Australia, 3rd ODI | Highlights',
    'Highlights: Liverpool hold on against Arsenal',
  ];
  const keep = [
    'Houthi missile strike on Yemen camp kills 73 security recruits',
    'US orders federal agencies to remove China’s DeepSeek AI from their systems',
    'Sudan army drones hit mourners and fuel market killing more than 300 people',
    'Removal of Automatic Extensions for Certain Employment Authorization Documents',
    // an over-broad filter (no word boundaries) wrongly ate these
    'Highlights of the budget session explained',
    'Oliver: a profile of the new finance minister',
    'Olive oil prices climb as Spain’s harvest fails',
  ];
  for (const t of drop) assert.ok(JUNK_TITLE.test(t), `should drop: ${t}`);
  for (const t of keep) assert.ok(!JUNK_TITLE.test(t), `should KEEP: ${t}`);
});

test('datedWithin: news pools get a short window, standing topics a long one', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  // default = news window (4 days)
  assert.equal(datedWithin('2026-10-21T09:00:00Z', now), true,  'today');
  assert.equal(datedWithin('2026-10-19T00:00:00Z', now), true,  'inside the news window');
  // the real pollution found in the finance pool: correctly dated, but evergreen filler
  assert.equal(datedWithin('2026-06-24T07:00:00Z', now), false, 'J.P. Morgan evergreen, 119d');
  assert.equal(datedWithin('2026-08-15T07:00:00Z', now), false, 'conference notice, 67d');
  assert.equal(datedWithin('2026-10-14T00:00:00Z', now), false, 'a week old is NOT news');

  // standing-topic window keeps the rules that still govern decisions today
  const STANDING = 90;
  assert.equal(datedWithin('2026-10-14T00:00:00Z', now, STANDING), true, 'Oct 14 EAD final rule');
  assert.equal(datedWithin('2026-09-23T00:00:00Z', now, STANDING), true, 'Sept 23 H-1B rule');
  assert.equal(datedWithin('2026-06-24T07:00:00Z', now, STANDING), false, 'still drops 119d filler');

  // undated / unparseable / future, in both windows
  for (const w of [undefined, STANDING]) {
    assert.equal(datedWithin('', now, w),            false, 'undated -> NaN sort');
    assert.equal(datedWithin(undefined, now, w),     false);
    assert.equal(datedWithin('not a date', now, w),  false);
    assert.equal(datedWithin('2026-11-30T00:00:00Z', now, w), false, 'dated in the future');
  }
  assert.equal(datedWithin('2026-10-21T18:00:00Z', now), true, 'a few hours ahead is clock skew');
});
