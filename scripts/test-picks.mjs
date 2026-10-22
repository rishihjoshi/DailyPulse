// resolvePicks maps model index-picks back to trusted pool items + source links.
// Run: node --test scripts/test-picks.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePicks, splitOutlet, cleanHeadline, JUNK_TITLE, datedWithin,
         coherent, contentTokens, withDeadline } from './build-digest.mjs';

// Realistic enough to satisfy the coherence guard: these tests are about index mapping,
// source ordering and headline fallback, not about prose/item agreement.
const pool = Array.from({ length: 6 }, (_, i) => ({
  title: `Topic${i} ministry announces budget review`, link: `https://x/${i}`, source: `S${i}`,
  snippet: `The Topic${i} ministry announced a budget review affecting regional funding.`,
}));

test('resolves valid picks in order with summary + sources', () => {
  const out = resolvePicks(pool, [
    { i: 2, summary: 'The Topic2 ministry announced a budget review.', sources: [2, 0] },
    { i: 1, summary: 'The Topic1 ministry announced a budget review.' }], 2);
  assert.deepEqual(out.map(o => o.title),
    ['Topic2 ministry announces budget review', 'Topic1 ministry announces budget review']);
  assert.equal(out[0].summary, 'The Topic2 ministry announced a budget review.');
  assert.equal(out[0].sources.length, 2);                 // two distinct outlets
  assert.ok(out[0].sources.every(s => /^https?:\/\//.test(s.link)));
  assert.equal(out[1].sources.length, 1);                 // only its own index
});

test('orders sources free-outlet first, and primary = a free source', () => {
  const p = [
    { title: 'Senate passes budget bill', link: 'https://wsj/a', source: 'Wall Street Journal',
      snippet: 'The Senate passed the budget bill on Thursday.' },
    { title: 'Senate passes budget bill', link: 'https://ap/a', source: 'AP News',
      snippet: 'The Senate passed the budget bill on Thursday.' },
  ];
  const out = resolvePicks(p, [{ i: 0, summary: 'The Senate passed the budget bill.', sources: [0, 1] }], 1);
  assert.equal(out[0].sources[0].source, 'AP News', 'free source should lead');
  assert.equal(out[0].source, 'AP News', 'primary link should be the free source');
  assert.equal(out[0].link, 'https://ap/a');
});

test('drops out-of-range/duplicate indices and pads to n', () => {
  const out = resolvePicks(pool, [{ i: 99 }, { i: -1 }, { i: 'x' }, { i: 1 }, { i: 1 }], 3);
  assert.equal(out.length, 3);
  assert.equal(out[0].title, 'Topic1 ministry announces budget review');
  assert.equal(new Set(out.map(o => o.title)).size, 3);   // no duplicates
  assert.ok(out.every(o => o.title && o.link && o.summary && o.sources.length >= 1));
});

test('handles missing/garbage picks array', () => {
  assert.equal(resolvePicks(pool, undefined, 2).length, 2);
  assert.equal(resolvePicks(pool, null, 2).length, 2);
});

test('uses the model headline when sane, else the feed title, and keeps the original', () => {
  const out = resolvePicks(pool, [
    { i: 0, headline: 'Topic0 ministry orders budget review',
      summary: 'The Topic0 ministry announced a budget review of regional funding.' },
    { i: 1, headline: 'tiny',                            // too short -> reject the headline
      summary: 'The Topic1 ministry announced a budget review of regional funding.' },
  ], 2);
  assert.equal(out[0].title, 'Topic0 ministry orders budget review');
  assert.equal(out[0].feedTitle, 'Topic0 ministry announces budget review',
    'original feed title must survive for traceability');
  assert.equal(out[1].title, 'Topic1 ministry announces budget review',
    'junk headline falls back to the feed title');
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

// Regression: a real build filed the headline AND summary "SpaceX AI business achieves
// profitability with $4.4B net income" against a TechCrunch article about OpenAI buying
// Orchestra Bio. Both agreed with each other, so only the link revealed the mismatch.
const DESYNC = {
  title: 'OpenAI acquires startup Orchestra Bio to beef up its biotech business',
  snippet: 'OpenAI said it has acquired Orchestra Bio, a biotech startup, to expand its work '
         + 'applying machine learning to drug discovery and protein design.',
};

test('coherent rejects the real desynced pick observed in production', () => {
  const headline = 'SpaceX AI business achieves profitability with $4.4B net income';
  const summary = 'SpaceX has reached profitability in the third quarter with net income of '
                + '$4.4 billion, with AI computing emerging as a major revenue driver.';
  assert.equal(coherent(`${headline} ${summary}`, DESYNC), false,
    'a headline about a different company must not pass');
});

test('coherent accepts legitimate rewrites, including loose ones', () => {
  // verbatim-ish
  assert.equal(coherent('Russia releases American Stephen Hubbard from prison',
    { title: 'Russia Releases American Stephen Hubbard From Prison, State Media Reports', snippet: '' }), true);
  // Scores only 10% on the headline alone; the summary is what carries the source's subject.
  // This is why the guard is fed headline + summary, exactly as resolvePicks does.
  assert.equal(coherent(
    'Indian markets slide as crude oil surges above $110 per barrel. '
    + 'The Sensex and Nifty fell for a second straight session, with small-cap stocks sliding '
    + 'over 2% as crude oil surged above $110 a barrel.',
    { title: 'Sensex, Nifty Fall for Second Straight Session as Small-Cap Stocks Slide Over 2%' }),
    true, 'a rewrite whose summary tracks the source must survive');
  // heavy paraphrase that still tracks the source
  assert.equal(coherent(
    'Modi government intensifies crackdown on Gen Z street protests. Modi seeks to calm allies '
    + 'by shackling the Gen Z protest movement, arresting organisers.',
    { title: 'Modi Seeks to Calm Allies by Shackling Gen Z Protests' }), true);
});

test('coherent handles empty and garbage input without throwing', () => {
  assert.equal(coherent('', DESYNC), false);
  assert.equal(coherent(undefined, DESYNC), false);
  assert.equal(coherent('anything at all here', undefined), false);
  assert.equal(coherent('anything at all here', {}), false);
  assert.equal(contentTokens(undefined).size, 0);
  assert.equal(contentTokens('the of and is').size, 0, 'stopwords only -> no content');
});

test('resolvePicks drops a desynced pick and pads instead of publishing it', () => {
  const p = [
    { title: 'OpenAI acquires Orchestra Bio biotech startup', link: 'https://tc/1', source: 'TechCrunch',
      snippet: 'OpenAI acquired the biotech startup Orchestra Bio for drug discovery work.' },
    { title: 'Anthropic pitches AI safety bill', link: 'https://r/2', source: 'Reuters',
      snippet: 'Anthropic proposed a bill that could block a model posing mass-casualty risk.' },
  ];
  const out = resolvePicks(p, [
    { i: 0, headline: 'SpaceX achieves profitability with $4.4B net income',
      summary: 'SpaceX reached profitability with net income of $4.4 billion from AI computing.' },
    { i: 1, headline: 'Anthropic proposes AI safety bill with killswitch',
      summary: 'Anthropic pitched a safety bill that could block a model if many could be killed.' },
  ], 2);
  assert.equal(out.length, 2, 'still returns n items');
  const titles = out.map(o => o.title);
  assert.ok(!titles.some(t => t.includes('SpaceX')), 'the desynced headline must not be published');
  assert.ok(!out.some(o => /\$4\.4/.test(o.summary)), 'the desynced summary must not be published');
  assert.ok(titles.some(t => t.includes('Anthropic')), 'the coherent pick survives');
  // the story is kept at its rank, but with the feed's title and an honest placeholder
  const kept = out.find(o => o.link === 'https://tc/1');
  assert.ok(kept, 'the story is kept, not silently dropped');
  assert.equal(kept.title, 'OpenAI acquires Orchestra Bio biotech startup');
  assert.match(kept.summary, /unavailable/i);
});

test('coherent keeps the legitimate rewrites a live build wrongly rejected', () => {
  // All four were flagged by the first (forward-ratio) version of this guard and lost
  // their summaries. They are plainly the same story as their source.
  // Fed headline + summary, as resolvePicks does in production.
  const pairs = [
    ['Trump administration ends H-1B extension deference protections (proposed, not final) '
     + 'The Trump administration moved to end H-1B extension protections and finalize '
     + 'restrictions on work permit renewals.',
     'Trump Administration Moves to End H-1B Extension Protections, Finalizes Restrictions on Work Permit Renewals'],
    ['SpaceX and Super Micro earnings boost AI stocks. Wall Street gained ground after SpaceX '
     + 'helped lift AI stocks on strong earnings.',
     'Wall Street gains ground after SpaceX helps lift AI stocks'],
    ['OpenAI finds critical PHP security vulnerabilities. OpenAI and Google’s Wiz found '
     + 'ancient holes in PHP, panicking much of the internet.',
     'PHP armageddon: OpenAI, Google’s Wiz find ancient holes, panicking the internet'],
    ['Anthropic proposes AI safety bill with shutdown clause. Anthropic’s bill would pause '
     + 'AI models if more than 50 people could be killed.',
     'Anthropic’s AI safety bill would pause AI models if 50+ people could be killed'],
  ];
  for (const [prose, title] of pairs)
    assert.equal(coherent(prose, { title }), true, `wrongly rejected: ${prose.slice(0, 50)}`);
});

test('coherent still rejects prose written against a different story', () => {
  assert.equal(coherent(
    'SpaceX AI business achieves profitability with $4.4B net income. SpaceX reached '
    + 'profitability in the third quarter with net income of $4.4 billion.',
    { title: 'OpenAI acquires startup Orchestra Bio to beef up its biotech business' }),
    false, 'the production desync must stay caught');
  // a short title still works: 3 of 5 source tokens survive the paraphrase
  assert.equal(coherent('Jaishankar holds talks with Swift chief in Delhi',
    { title: 'Jaishankar meets Swift CEO in Delhi' }), true);
  assert.equal(coherent('anything plausible here', { title: '' }), false);
  assert.equal(coherent('', { title: 'Senate passes the budget bill today' }), false);
});

test('withDeadline returns real work when it finishes in time', async () => {
  const got = await withDeadline(Promise.resolve(['a', 'b']), 500, [], 'fast');
  assert.deepEqual(got, ['a', 'b']);
});

test('withDeadline falls back instead of hanging the build', async () => {
  // A triggered build sat 16 minutes on one step with no output. A scheduled job must
  // degrade to partial data rather than hang.
  const never = new Promise(() => {});
  const t0 = Date.now();
  const got = await withDeadline(never, 60, [], 'stuck pool');
  assert.deepEqual(got, [], 'falls back to the supplied default');
  assert.ok(Date.now() - t0 < 2000, 'returns promptly at the deadline');
});

test('withDeadline clears its timer so the process can exit', async () => {
  // A dangling setTimeout keeps Node alive and would hang the CI step at the end.
  const before = process.getActiveResourcesInfo
    ? process.getActiveResourcesInfo().filter(r => r === 'Timeout').length : 0;
  await withDeadline(Promise.resolve('x'), 10000, null, 'timer');
  const after = process.getActiveResourcesInfo
    ? process.getActiveResourcesInfo().filter(r => r === 'Timeout').length : 0;
  assert.equal(after, before, 'no timer left pending after the work resolves');
});
