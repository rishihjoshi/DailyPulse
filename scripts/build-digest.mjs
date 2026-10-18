#!/usr/bin/env node
// Builds docs/data/digest.json for DailyPulse.
// Fetches free RSS feeds + Open-Meteo weather, then ONE Claude call ranks the
// news to the top 5 per tab (+ "why it matters"), picks a Top Story, and writes
// the microlearning cards. The browser never does any of this and never sees a key.
//
// Run:  ANTHROPIC_API_KEY=... node scripts/build-digest.mjs
// Check: node scripts/build-digest.mjs --selfcheck   (validates existing digest.json)

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'docs', 'data', 'digest.json');

const MODEL = 'claude-haiku-4-5-20251001'; // cheap; this is a daily ranking/summary job
const POOL_CAP = 15;                        // items per feed handed to Claude

// St. Louis, MO
const LAT = 38.627, LON = -90.199, TZ = 'America/Chicago';

const FEEDS = {
  // "Local" tab = US national news. Several feeds so one flaky source can't empty the pool.
  // Direct free-publisher RSS (NPR/PBS/The Hill) gives links to free content, not redirects.
  local: [
    'https://feeds.npr.org/1003/rss.xml',
    'https://www.pbs.org/newshour/feeds/rss/headlines',
    'https://thehill.com/news/feed/',
    'https://news.google.com/rss/headlines/section/topic/NATION?hl=en-US&gl=US&ceid=US:en',
  ],
  // St. Louis metro subsection shown under the USA tab.
  stlouis: [
    'https://news.google.com/rss/search?q=%22St.+Louis%22+Missouri&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=%22St.+Louis%22+metro&hl=en-US&gl=US&ceid=US:en',
  ],
  world: [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://www.theguardian.com/world/rss',
    'https://www.aljazeera.com/xml/rss/all.xml',
    'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en',
  ],
  india: [
    'https://www.thehindu.com/news/national/feeder/default.rss',
    'https://news.google.com/rss/search?q=India&hl=en-IN&gl=IN&ceid=IN:en',
    'https://news.google.com/rss/headlines/section/topic/NATION?hl=en-IN&gl=IN&ceid=IN:en',
  ],
  immigration: [
    'https://news.google.com/rss/search?q=H-1B+OR+%22green+card%22+OR+USCIS+OR+%22India+immigration%22&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=USCIS+OR+%22H-1B+visa%22+OR+%22employment+green+card%22+OR+%22visa+bulletin%22&hl=en-US&gl=US&ceid=US:en',
  ],
  // Finance tab: US stocks, world + India markets, major market-moving news.
  finance: [
    'https://www.theguardian.com/business/rss',
    'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=stock+market+OR+S%26P+500+OR+Nasdaq+OR+Dow&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=Sensex+OR+Nifty+OR+%22Indian+stock+market%22&hl=en-IN&gl=IN&ceid=IN:en',
    'https://news.google.com/rss/search?q=global+markets+OR+FTSE+OR+Nikkei+OR+%22Hang+Seng%22&hl=en-US&gl=US&ceid=US:en',
  ],
  // AI news subsection shown under the Microlearning tab.
  ai: [
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    'https://news.google.com/rss/search?q=%22artificial+intelligence%22+OR+OpenAI+OR+Anthropic+OR+%22Google+DeepMind%22&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=AI+model+OR+LLM+OR+%22AI+chips%22+OR+%22AI+regulation%22&hl=en-US&gl=US&ceid=US:en',
  ],
};

// Freely-readable outlets (prefer these for source links) vs. paywalled (deprioritize).
const FREE_SRC = ['ap','associated press','reuters','bbc','npr','pbs','guardian','al jazeera','the hill',
  'axios','cbs','abc news','cnbc','deutsche welle','france 24','the hindu','ndtv','pti','times of india',
  'economic times','al-monitor','marketwatch','the conversation','propublica','.gov'];
const PAID_SRC = ['new york times','nytimes','wall street journal','wsj','financial times',' ft ','bloomberg',
  'washington post','the economist','the atlantic','foreign policy','barron','business insider','the information','seeking alpha'];
function srcRank(name) {
  const s = ` ${String(name || '').toLowerCase()} `;
  if (PAID_SRC.some(p => s.includes(p))) return 2;  // paywalled last
  if (FREE_SRC.some(f => s.includes(f))) return 0;  // free first
  return 1;
}

// Microlearning theme rotates by day-of-year so it's deterministic and varied.
const THEMES = [
  'productivity & focus', 'stoic philosophy', 'personal finance', 'physical & mental health',
  'decision-making', 'communication & persuasion', 'habits & behavior change', 'creativity',
];

// WMO weather codes -> {label, emoji}. Covers the common buckets.
const WMO = {
  0: ['Clear', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm + hail', '⛈️'], 99: ['Thunderstorm + hail', '⛈️'],
};

const parser = new Parser({ timeout: 15000 });

async function parseFeed(url, tries = 2) {
  for (let attempt = 1; ; attempt++) {
    try { return await parser.parseURL(url); }
    catch (err) {
      if (attempt >= tries) throw err;
      await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
}

async function fetchPool(urls) {
  const items = [];
  for (const url of urls) {
    try {
      const feed = await parseFeed(url);
      for (const it of (feed.items || [])) {
        items.push({
          title: (it.title || '').trim(),
          link: (it.link || '').trim(),
          source: feed.title || new URL(url).hostname,
          isoDate: it.isoDate || it.pubDate || '',
          snippet: (it.contentSnippet || it.content || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        });
      }
    } catch (err) {
      console.warn(`feed failed: ${url} -> ${err.message}`);
    }
  }
  // newest first, drop empties, cap
  return items
    .filter(i => i.title && i.link)
    .sort((a, b) => new Date(b.isoDate) - new Date(a.isoDate))
    .slice(0, POOL_CAP);
}

const fToC = f => Math.round((f - 32) * 5 / 9);

// Open-Meteo returns sunrise/sunset as a local-time ISO string (no offset, e.g.
// "2026-10-13T07:12") — format the HH:MM directly so it's correct for any viewer.
export const fmtClock = iso => {
  const m = /T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return '';
  let h = +m[1];
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
};

// Unattended scheduled job: a single flaky connect shouldn't fail the whole build.
// Retry transient fetch errors with a longer per-attempt timeout and backoff.
async function fetchJson(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= tries) throw err;
      console.warn(`fetch ${url} failed (attempt ${attempt}/${tries}): ${err.message} — retrying`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunrise,sunset,wind_speed_10m_max`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${encodeURIComponent(TZ)}&forecast_days=1`;
  const d = (await fetchJson(url)).daily;
  const code = d.weather_code[0];
  const [label, emoji] = WMO[code] || ['—', '🌡️'];
  const highF = d.temperature_2m_max[0], lowF = d.temperature_2m_min[0];
  return {
    high: Math.round(highF),  low: Math.round(lowF),   // °F
    highC: fToC(highF),       lowC: fToC(lowF),         // °C
    precip: d.precipitation_probability_max[0] ?? 0,
    wind: Math.round(d.wind_speed_10m_max[0]),          // mph
    sunrise: fmtClock(d.sunrise[0]),
    sunset: fmtClock(d.sunset[0]),
    label, emoji,
  };
}

// Major indices for the Finance tab. Fetched server-side with FMP_API_KEY so the key
// never reaches the client (same model as ANTHROPIC_API_KEY).
// US-listed ETF proxies for the Finance tab. Price is the ETF's; % change tracks each
// market's direction. Quoted from keyless sources (Yahoo chart first, Stooq CSV fallback).
const MARKET_SYMBOLS = [
  ['SPY', 'S&P 500 · SPY'], ['QQQ', 'Nasdaq · QQQ'], ['DIA', 'Dow · DIA'],
  ['INDA', 'India · INDA'], ['EWJ', 'Japan · EWJ'], ['EWU', 'UK · EWU'],
  ['EWH', 'Hong Kong · EWH'], ['VT', 'World · VT'],
];
const NAME_BY = Object.fromEntries(MARKET_SYMBOLS);
const UA = 'Mozilla/5.0 (compatible; DailyPulse/1.0)';

async function fetchYahooQuote(symbol) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
      { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = (await res.json())?.chart?.result?.[0]?.meta;
    if (!m || typeof m.regularMarketPrice !== 'number') return null;
    const prev = m.chartPreviousClose ?? m.previousClose;
    const changePct = (typeof prev === 'number' && prev > 0)
      ? Math.round(((m.regularMarketPrice - prev) / prev) * 10000) / 100 : 0;
    return { symbol, name: NAME_BY[symbol] || symbol, price: Math.round(m.regularMarketPrice * 100) / 100, changePct };
  } catch { return null; }
}

// Fallback: Stooq light-quote CSV (f=sd2t2ohlcv). Skips N/D rows; session open→close change.
export function parseStooqQuotes(csv) {
  const out = [];
  for (const row of String(csv).trim().split('\n').slice(1)) {
    const c = row.split(',');
    const base = (c[0] || '').replace(/\.US$/i, '').toUpperCase();
    const open = parseFloat(c[3]), close = parseFloat(c[6]);
    if (!base || !Number.isFinite(close) || close <= 0) continue;
    const changePct = Number.isFinite(open) && open > 0 ? Math.round(((close - open) / open) * 10000) / 100 : 0;
    out.push({ symbol: base, name: NAME_BY[base] || base, price: close, changePct });
  }
  return out;
}

async function fetchStooq() {
  const syms = MARKET_SYMBOLS.map(([s]) => `${s.toLowerCase()}.us`).join(',');
  const res = await fetch(`https://stooq.com/q/l/?s=${syms}&f=sd2t2ohlcv&h&e=csv`,
    { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
  return parseStooqQuotes(await res.text());
}

async function fetchMarkets() {
  try {
    const yahoo = (await Promise.all(MARKET_SYMBOLS.map(([s]) => fetchYahooQuote(s)))).filter(Boolean);
    if (yahoo.length) { console.log(`Markets via Yahoo: ${yahoo.length}/${MARKET_SYMBOLS.length}`); return yahoo; }
    console.warn('Yahoo returned 0 quotes; trying Stooq');
  } catch (err) { console.warn(`Yahoo error (${err.message}); trying Stooq`); }
  try {
    const stooq = await fetchStooq();
    if (stooq.length) { console.log(`Markets via Stooq: ${stooq.length}/${MARKET_SYMBOLS.length}`); return stooq; }
    console.warn('Stooq returned 0 quotes');
  } catch (err) { console.warn(`Stooq error (${err.message})`); }
  console.warn('No market source returned quotes (news-only finance this run)');
  return [];
}

function buildPrompt(pools, theme) {
  const show = arr => arr.map((it, i) =>
    `  [${i}] ${it.title} — ${it.source}${it.snippet ? ` :: ${it.snippet}` : ''}`
  ).join('\n');
  return `You are the editor of a personal daily briefing. From each pool of raw headlines,
pick the N MOST IMPORTANT, distinct stories (dedupe near-identical coverage; prefer
substantive, recent, high-impact news over fluff). Refer to each pick by its [index]
number only — do NOT copy titles or URLs back.

Return ONLY valid JSON, no prose, no code fences, matching this shape exactly:
{
  "local":       [ {"i": <index>, "summary": "<3-5 sentences>", "sources": [<index>, ...]} x5 ],
  "stlouis":     [ {"i": <index>, "summary": "<3-5 sentences>", "sources": [<index>, ...]} x3 ],
  "world":       [ {"i": <index>, "summary": "<3-5 sentences>", "sources": [<index>, ...]} x5 ],
  "india":       [ {"i": <index>, "summary": "<3-5 sentences>", "sources": [<index>, ...]} x5 ],
  "immigration": [ {"i": <index>, "summary": "<3-5 sentences>", "sources": [<index>, ...]} x3 ],
  "finance":     [ {"i": <index>, "summary": "<3-5 sentences>", "sources": [<index>, ...]} x5 ],
  "ai":          [ {"i": <index>, "summary": "<3-5 sentences>", "sources": [<index>, ...]} x5 ],
  "micro":       { "theme": "${theme}", "cards": [ {"title","insight","takeaway"} x4 ] }
}
Rules:
- "i" = the [index] of the chosen story in that pool. Order each array by importance (first = Top Story).
- "summary" = a 3-5 sentence brief a reader can skim in under two minutes: what happened and why it
  matters. Base it ONLY on the headline and snippet shown; if a detail is a proposal, allegation, or
  uncertain, say so. Do NOT invent specifics (numbers, names, dates) that aren't in the provided text.
- "sources" = 2-3 [index] values for items covering THIS SAME story from DIFFERENT outlets (include "i").
  Prefer freely-readable outlets (AP, Reuters, BBC, NPR, PBS, The Guardian, Al Jazeera) over paywalled
  ones (NYT, WSJ, FT, Bloomberg, Washington Post). If only one item covers it, return just [i].
- "stlouis" = the 3 most important St. Louis / Missouri metro stories.
- "immigration" = the 3 most important US–India immigration items (H-1B, green card, USCIS, visas).
- "finance" = the 5 most important markets/finance stories (US stocks, India & world markets, major market-moving news).
- "ai" = the 5 most important AI stories (models, products, research, chips, policy/regulation, business).
- "micro" cards are ORIGINAL insights you write on the theme "${theme}" (do NOT quote or
  summarize any specific copyrighted book). "insight" = 2–3 sentences; "takeaway" = one action.

POOL local — US national news (country-wide, not city-specific):
${show(pools.local)}

POOL stlouis — St. Louis, MO metro:
${show(pools.stlouis)}

POOL world:
${show(pools.world)}

POOL india:
${show(pools.india)}

POOL immigration (US–India):
${show(pools.immigration)}

POOL finance — markets & money (US, India, world):
${show(pools.finance)}

POOL ai — artificial intelligence:
${show(pools.ai)}`;
}

// Resolve the model's chosen indices back to real pool items (trusted title/link/source).
// Each item carries a summary and 2-3 distinct-outlet source links (free outlets first).
// Drops out-of-range/duplicate picks and pads from the top of the pool so we always
// return exactly n items even if the model under-picks or returns junk.
export function resolvePicks(pool, picks, n) {
  const out = [], used = new Set();
  // Build up to 3 source links for a story: primary index first, then the model's extra
  // indices, deduped by outlet name, sorted free-first. Always valid http(s) links.
  const makeSources = (primaryI, extra) => {
    const srcs = [], seenNames = new Set();
    for (const j of [primaryI, ...(Array.isArray(extra) ? extra : [])]) {
      const k = Number(j);
      if (!Number.isInteger(k) || k < 0 || k >= pool.length) continue;
      const name = pool[k].source || 'Source';
      if (seenNames.has(name) || !/^https?:\/\//.test(pool[k].link || '')) continue;
      seenNames.add(name);
      srcs.push({ source: name, link: pool[k].link });
      if (srcs.length === 3) break;
    }
    srcs.sort((a, b) => srcRank(a.source) - srcRank(b.source));
    return srcs;
  };
  const add = (i, summary, extra) => {
    used.add(i);
    const sources = makeSources(i, extra);
    const primary = sources[0] || { source: pool[i].source, link: pool[i].link };
    out.push({ title: pool[i].title, summary, source: primary.source, link: primary.link, sources });
  };
  for (const p of Array.isArray(picks) ? picks : []) {
    const i = Number(p?.i);
    if (Number.isInteger(i) && i >= 0 && i < pool.length && !used.has(i)) {
      add(i, String(p?.summary ?? '').trim() || 'Summary unavailable for this update.', p?.sources);
      if (out.length === n) break;
    }
  }
  for (let i = 0; i < pool.length && out.length < n; i++) if (!used.has(i)) add(i, 'Summary unavailable for this update.', [i]);
  return out;
}

function extractJson(text) {
  const t = text.trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');  // first..last brace ignores any ``` fences
  if (s === -1 || e === -1) throw new Error('no JSON object in model output');
  return JSON.parse(t.slice(s, e + 1));
}

function validateDigest(d) {
  assert.ok(d.generatedAt, 'missing generatedAt');
  const w = d.weather;
  for (const k of ['high', 'low', 'highC', 'lowC', 'precip', 'wind']) assert.equal(typeof w[k], 'number', `weather.${k} not a number`);
  for (const k of ['sunrise', 'sunset']) assert.ok(w[k], `weather.${k} missing`);
  // At most n items (a sparse feed may yield fewer this run); every present item well-formed.
  const check = (items, n, name) => {
    assert.ok(Array.isArray(items) && items.length <= n, `${name} expected <= ${n} items, got ${items?.length}`);
    for (const it of items) {
      assert.ok(it.title, `${name} item missing title`);
      assert.ok(/^https?:\/\//.test(it.link || ''), `${name} item missing valid link`);
      assert.ok(it.summary, `${name} item missing summary`);
      assert.ok(Array.isArray(it.sources) && it.sources.length >= 1, `${name} item missing sources`);
      for (const s of it.sources) assert.ok(/^https?:\/\//.test(s.link || ''), `${name} source missing valid link`);
    }
  };
  check(d.tabs.local.items, 5, 'local');
  check(d.tabs.local.stlouis, 3, 'stlouis');
  check(d.tabs.world.items, 5, 'world');
  check(d.tabs.india.items, 5, 'india');
  check(d.tabs.india.immigration, 3, 'immigration');
  check(d.tabs.finance.items, 5, 'finance');
  const quotes = d.tabs.finance.quotes;  // optional — FMP may be unset/down
  if (quotes !== undefined) {
    assert.ok(Array.isArray(quotes), 'finance.quotes not an array');
    for (const q of quotes) {
      assert.ok(q.symbol && q.name, 'quote missing symbol/name');
      assert.equal(typeof q.price, 'number', 'quote price not a number');
      assert.equal(typeof q.changePct, 'number', 'quote changePct not a number');
    }
  }
  check(d.micro.ai || [], 5, 'micro ai');
  assert.ok(d.micro.theme, 'micro.theme missing');
  assert.ok(d.micro.cards.length >= 3, 'micro needs >=3 cards');
  for (const c of d.micro.cards) assert.ok(c.title && c.insight && c.takeaway, 'micro card incomplete');
}

async function main() {
  if (process.argv.includes('--selfcheck')) {
    validateDigest(JSON.parse(readFileSync(OUT, 'utf8')));
    console.log('selfcheck OK:', OUT);
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  assert.ok(apiKey, 'ANTHROPIC_API_KEY not set');

  const dayOfYear = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 864e5);
  const theme = THEMES[dayOfYear % THEMES.length];

  const [local, stlouis, world, india, immigration, finance, ai, weather, markets] = await Promise.all([
    fetchPool(FEEDS.local), fetchPool(FEEDS.stlouis), fetchPool(FEEDS.world), fetchPool(FEEDS.india),
    fetchPool(FEEDS.immigration), fetchPool(FEEDS.finance), fetchPool(FEEDS.ai), fetchWeather(), fetchMarkets(),
  ]);
  const pools = { local, stlouis, world, india, immigration, finance, ai };
  // A transient empty secondary feed shouldn't nuke the whole briefing — that section
  // just renders short/empty this run. Only abort if the primary (local) pool is empty.
  for (const [k, v] of Object.entries(pools)) if (!v.length) console.warn(`empty pool: ${k} (all feeds failed this run)`);
  assert.ok(local.length, 'primary pool (local) empty — aborting rather than publishing an empty briefing');

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 10000,  // 31 multi-sentence summaries + micro cards; headroom so JSON never truncates
    messages: [{ role: 'user', content: buildPrompt(pools, theme) }],
  });
  const r = extractJson(msg.content[0].text);

  const digest = {
    generatedAt: new Date().toISOString(),
    location: 'St. Louis, MO',
    weather,
    tabs: {
      local: { items: resolvePicks(local, r.local, 5), stlouis: resolvePicks(stlouis, r.stlouis, 3) },
      world: { items: resolvePicks(world, r.world, 5) },
      india: { items: resolvePicks(india, r.india, 5), immigration: resolvePicks(immigration, r.immigration, 3) },
      finance: { items: resolvePicks(finance, r.finance, 5), quotes: markets },
    },
    micro: { ...r.micro, ai: resolvePicks(ai, r.ai, 5) },
  };

  validateDigest(digest);
  writeFileSync(OUT, JSON.stringify(digest, null, 2));
  console.log(`wrote ${OUT} @ ${digest.generatedAt} (theme: ${theme})`);
}

// Only run the network build when executed directly, not when imported by a test.
// (Portable across Node 20 — import.meta.main predates it by years.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
