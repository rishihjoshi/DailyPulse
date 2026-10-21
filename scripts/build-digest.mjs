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
const PER_FEED_CAP = 25;                    // newest N per FEED (NOT per pool)

// Why per-feed: merging every feed then taking the newest 15 let the one chattiest feed
// take the whole pool. Measured on live feeds: The Hindu held 14 of 15 India slots (an
// 18-minute window), the Guardian 9 of 15 in world — so 1,318 fetched items became 90
// candidates, and stories like the DeepSeek federal ban never reached the model at all.
// 25/feed is the smallest cap that reached every target story we tested for.

// St. Charles, MO — where the briefing is actually read. (The St. Louis *metro news*
// feed is separate and unchanged; this is the weather point only.)
const LAT = 38.7881, LON = -90.4974, TZ = 'America/Chicago';
const PLACE = 'St. Charles, MO';

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
    // Middle East led every briefing in Oct 2026 but had no feed of its own, so its
    // placement in the generic world pool was luck.
    'https://news.google.com/rss/search?q=Yemen+OR+Houthi+OR+%22Strait+of+Hormuz%22+OR+Iran+strike&hl=en-US&gl=US&ceid=US:en',
  ],
  india: [
    'https://www.thehindu.com/news/national/feeder/default.rss',
    'https://news.google.com/rss/search?q=India&hl=en-IN&gl=IN&ceid=IN:en',
    'https://news.google.com/rss/headlines/section/topic/NATION?hl=en-IN&gl=IN&ceid=IN:en',
  ],
  // Immigration is a STANDING interest, not just breaking news: the rules that matter
  // (H-4 EAD auto-extension, deference to prior approvals) were finalized days ago and
  // still govern decisions today. The broad queries below only ever surfaced the newest
  // churn, so the narrow + primary-source feeds carry the status items that persist.
  immigration: [
    'https://news.google.com/rss/search?q=H-1B+OR+%22green+card%22+OR+USCIS+OR+%22India+immigration%22&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=USCIS+OR+%22H-1B+visa%22+OR+%22employment+green+card%22+OR+%22visa+bulletin%22&hl=en-US&gl=US&ceid=US:en',
    // Narrow, so standing-topic items stay inside the newest-N window instead of being
    // buried by daily churn. (Bare "PERM" is unusable — it matches Perm, Russia.)
    'https://news.google.com/rss/search?q=%22H-4+EAD%22+OR+%22EAD+automatic+extension%22+OR+%22labor+certification%22+OR+%22deference+to+prior+approvals%22+OR+%22visa+bulletin%22+OR+%22H-1B+extension%22&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=%22visa+revocation%22+OR+%22revoked+visas%22+OR+%22State+Department%22+visa&hl=en-US&gl=US&ceid=US:en',
    // Primary sources. Low volume, all on-topic — the actual rule text behind the news.
    'https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bterm%5D=H-1B',
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

// Google News items title themselves "Real Headline - The Washington Post" and expose
// only the feed name ("U.S. - Latest - Google News") as the source, so srcRank's paywall
// check never fired and the UI credited Google instead of the publisher. Split the suffix.
export function splitOutlet(title, fallback) {
  const m = /^(.*\S)\s+[-–—]\s+([^-–—]{2,40})$/.exec(String(title || '').trim());
  return m ? { title: m[1].trim(), source: m[2].trim() } : { title: String(title || '').trim(), source: fallback };
}

// Live blogs retitle themselves hourly and their links rot within a day; match reports
// and highlights aren't briefing material. Both were reaching the front page.
export const JUNK_TITLE = /\blive\s*[:|]|\blive updates?\b|[–-]\s*(?:europe|us politics|business)\s+live\b|\bvs\b.*\b(?:t20|odi|test match)\b|\bhighlights\s*[:|]|[:|]\s*highlights\b/i;

const UA = 'Mozilla/5.0 (compatible; DailyPulse/1.0; +https://github.com/rishihjoshi/DailyPulse)';

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

const byNewest = (a, b) => new Date(b.isoDate) - new Date(a.isoDate);

// Age window, per pool. A dry run showed finance spanning 12 years and stlouis 390 days;
// inspecting the items showed the dates were CORRECT and the content was simply old —
// broad Google News keyword queries return evergreen vendor content (J.P. Morgan
// commentary, MSCI research, conference notices, law-firm partner hires) 60-130 days old.
// So this is an age problem, not a malformed-date problem, and one global window is wrong:
//   news pools want "the last few days"; `immigration` wants ~7 weeks, because the rule
//   that governs a decision today (the Oct 14 EAD rule) was finalized weeks ago.
// Undated items are dropped regardless: new Date('') is NaN, which makes byNewest return
// NaN and leaves the sort order implementation-defined.
const NEWS_MAX_AGE_DAYS = 4;
const STANDING_MAX_AGE_DAYS = 90;   // immigration: primary sources + currently-governing rules
export function datedWithin(isoDate, now = Date.now(), maxAgeDays = NEWS_MAX_AGE_DAYS) {
  const t = new Date(isoDate || '').getTime();
  if (!Number.isFinite(t)) return false;
  const days = (now - t) / 864e5;
  return days <= maxAgeDays && days >= -1;      // -1 tolerates clock skew, not "news" dated next month
}

async function fetchPool(urls, maxAgeDays = NEWS_MAX_AGE_DAYS) {
  const out = [];
  for (const url of urls) {
    try {
      const feed = await parseFeed(url);
      const isGoogle = url.includes('news.google.com');
      const feedName = feed.title || new URL(url).hostname;
      const raw = (feed.items || []).filter(it => it.title && it.link && !JUNK_TITLE.test(it.title));
      const dated = raw.filter(it => datedWithin(it.isoDate || it.pubDate, Date.now(), maxAgeDays));
      const items = dated
        .map(it => {
          const { title, source } = isGoogle
            ? splitOutlet(it.title, feedName)
            : { title: String(it.title).trim(), source: feedName };
          return {
            title, source,
            link: String(it.link).trim(),
            isoDate: it.isoDate || it.pubDate || '',
            snippet: (it.contentSnippet || it.content || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          };
        })
        .sort(byNewest)
        .slice(0, PER_FEED_CAP);     // cap each feed BEFORE merging
      out.push(...items);
      const skipped = raw.length - dated.length;
      console.log(`  ${feedName.slice(0, 34)}: ${items.length}`
        + (skipped ? ` (${skipped} undated/stale)` : ''));
    } catch (err) {
      console.warn(`feed failed: ${url} -> ${err.message}`);
    }
  }
  return out.sort(byNewest);
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
async function fetchJson(url, tries = 3, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= tries) throw err;
      console.warn(`fetch ${url} failed (attempt ${attempt}/${tries}): ${err.message} — retrying`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// Active NWS watches/warnings for the point. Keyless, but api.weather.gov 403s without
// a User-Agent. A severe-weather warning is the only thing in this briefing that's
// actionable within the hour, so it renders above the news — and must never fail the
// build, since the forecast itself is still useful without it.
async function fetchAlerts() {
  try {
    const j = await fetchJson(`https://api.weather.gov/alerts/active?point=${LAT},${LON}`, 2,
      { 'User-Agent': UA, Accept: 'application/geo+json' });
    return (j.features || [])
      .map(f => f.properties || {})
      .filter(a => ['Extreme', 'Severe', 'Moderate'].includes(a.severity))
      .slice(0, 3)
      .map(a => ({ event: String(a.event || '').trim(), severity: a.severity,
                   headline: String(a.headline || '').trim().slice(0, 200) }))
      .filter(a => a.event);
  } catch (err) {
    console.warn(`NWS alerts unavailable (forecast still published): ${err.message}`);
    return [];
  }
}

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunrise,sunset,wind_speed_10m_max`
    + `&current=temperature_2m,weather_code`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${encodeURIComponent(TZ)}&forecast_days=1`;
  const [j, alerts] = await Promise.all([fetchJson(url), fetchAlerts()]);
  const d = j.daily, c = j.current || {};
  const [label, emoji] = WMO[d.weather_code[0]] || ['—', '🌡️'];
  const highF = d.temperature_2m_max[0], lowF = d.temperature_2m_min[0];
  const nowF = c.temperature_2m;
  return {
    high: Math.round(highF),  low: Math.round(lowF),   // °F
    highC: fToC(highF),       lowC: fToC(lowF),         // °C
    precip: d.precipitation_probability_max[0] ?? 0,
    wind: Math.round(d.wind_speed_10m_max[0]),          // mph
    sunrise: fmtClock(d.sunrise[0]),
    sunset: fmtClock(d.sunset[0]),
    // "Around 50°F; partly cloudy" — every briefing led the weather with current
    // conditions, not the daily max.
    now: Number.isFinite(nowF) ? Math.round(nowF) : null,
    nowLabel: (WMO[c.weather_code] || [label])[0],
    alerts,
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
  ['BZ=F', 'Brent crude · BZ=F'],   // oil drove the markets line in all 10 briefings
];
const NAME_BY = Object.fromEntries(MARKET_SYMBOLS);

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
  // Stooq light-quote serves US equities only — futures ('BZ=F') have no .us row.
  const syms = MARKET_SYMBOLS.filter(([s]) => !s.includes('=')).map(([s]) => `${s.toLowerCase()}.us`).join(',');
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
  "local":       [ {"i": <index>, "headline": "<4-12 words>", "summary": "<3-5 sentences>", "sources": [<index>, ...]} x5 ],
  "stlouis":     [ {"i": <index>, "headline": "...", "summary": "...", "sources": [...]} x3 ],
  "world":       [ {"i": <index>, "headline": "...", "summary": "...", "sources": [...]} x5 ],
  "india":       [ {"i": <index>, "headline": "...", "summary": "...", "sources": [...]} x5 ],
  "immigration": [ {"i": <index>, "headline": "...", "summary": "...", "sources": [...]} x3 ],
  "finance":     [ {"i": <index>, "headline": "...", "summary": "...", "sources": [...]} x5 ],
  "ai":          [ {"i": <index>, "headline": "...", "summary": "...", "sources": [...]} x5 ],
  "marketsNote": "<2-3 sentences: direction of oil, stocks, and one other pressure, then what to watch>",
  "watch":       [ "<forward-looking thing to watch today>" x3 ],
  "micro":       { "theme": "${theme}", "cards": [ {"title","insight","takeaway"} x4 ] }
}
Rules:
- "i" = the [index] of the chosen story in that pool. Order each array by importance (first = Top Story).
- "headline" = YOUR OWN 4-12 word headline for the story, in the style "Middle East: Yemen conflict
  escalates" or "DHS finalizes work-permit extension limits". Derive it ONLY from the provided title
  and snippet — introduce NO fact, name, number or date that isn't already there. Feed titles are
  often procedural ("... LIVE | Seven accused sent to custody") or carry an outlet suffix; write the
  headline the story deserves, naming the actual event.
- "summary" = a 3-5 sentence brief a reader can skim in under two minutes: what happened and why it
  matters. Base it ONLY on the headline and snippet shown. Do NOT invent specifics (numbers, names,
  dates) that aren't in the provided text.
- EPISTEMIC DISCIPLINE (applies to every summary). Distinguish, in the wording:
  a proposed rule from a final one; an allegation or official claim from an established fact; an
  intraday or early-session market figure from a close. Attribute claims to whoever made them
  ("local authorities say", "the company says"). If responsibility for an incident is unestablished,
  say so. If the pool shows no real development on a standing topic, say that plainly rather than
  inflating a minor item.
- NO STORY TWICE. A story belongs in exactly one pool. If it fits two (e.g. a foreign protest in both
  "world" and "local"), keep it in the better-fitting pool and pick something else for the other.
- "watch" = 3 short forward-looking items: what could move tomorrow, not a recap of the above.
- "sources" = 2-3 [index] values for items covering THIS SAME story from DIFFERENT outlets (include "i").
  Prefer freely-readable outlets (AP, Reuters, BBC, NPR, PBS, The Guardian, Al Jazeera) over paywalled
  ones (NYT, WSJ, FT, Bloomberg, Washington Post). If only one item covers it, return just [i].
- "stlouis" = the 3 most important St. Louis / Missouri metro stories.
- "immigration" = the 3 most consequential US–India immigration items (H-1B, H-4 EAD, green card,
  PERM, USCIS, visas). Treat this as STATUS TRACKING, not just breaking news: the rule that governs a
  decision today may have been finalized days ago, so prefer a currently-governing rule or a pending
  proposal with real consequence over fresher but trivial churn. Always label which it is — "finalized
  and in effect" vs "proposed, not final". Federal Register items are primary sources; prefer them.
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

// A model headline is only used if it looks like a headline: long enough to say
// something, short enough not to be a smuggled summary. Otherwise the feed title stands.
export const cleanHeadline = h => {
  const t = String(h ?? '').trim().replace(/^[“"']+|[”"']+$/g, '').trim();
  return t.length >= 10 && t.length <= 120 ? t : '';
};

// Resolve the model's chosen indices back to real pool items. link and source always come
// from the pool and are never model-authored; the headline MAY be (see cleanHeadline), with
// the feed's own title retained as feedTitle.
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
  const add = (i, summary, extra, headline) => {
    used.add(i);
    const sources = makeSources(i, extra);
    const primary = sources[0] || { source: pool[i].source, link: pool[i].link };
    // Prefer the model's headline; fall back to the feed title. feedTitle is kept so a
    // bad rewrite is traceable back to what the feed actually said.
    out.push({ title: headline || pool[i].title, feedTitle: pool[i].title,
               summary, source: primary.source, link: primary.link, sources });
  };
  for (const p of Array.isArray(picks) ? picks : []) {
    const i = Number(p?.i);
    if (Number.isInteger(i) && i >= 0 && i < pool.length && !used.has(i)) {
      add(i, String(p?.summary ?? '').trim() || 'Summary unavailable for this update.',
          p?.sources, cleanHeadline(p?.headline));
      if (out.length === n) break;
    }
  }
  for (let i = 0; i < pool.length && out.length < n; i++) if (!used.has(i)) add(i, 'Summary unavailable for this update.', [i]);
  return out;
}

// Backstop for the prompt's "no story twice" rule: if the same link still lands in two
// sections, keep the first. Order below is editorial priority — the desk that owns a
// story keeps it. (Only catches exact republication; near-duplicates are the model's job.)
function dedupeAcross(tabs, micro) {
  const seen = new Set();
  const sweep = list => (Array.isArray(list) ? list : []).filter(it => {
    if (!it.link || seen.has(it.link)) return false;
    seen.add(it.link);
    return true;
  });
  tabs.world.items      = sweep(tabs.world.items);
  tabs.india.immigration = sweep(tabs.india.immigration);
  tabs.india.items      = sweep(tabs.india.items);
  tabs.finance.items    = sweep(tabs.finance.items);
  micro.ai              = sweep(micro.ai);
  tabs.local.items      = sweep(tabs.local.items);
  tabs.local.stlouis    = sweep(tabs.local.stlouis);
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
  // Optional (added later; an older digest predates them).
  if (w.now !== undefined && w.now !== null) assert.equal(typeof w.now, 'number', 'weather.now not a number');
  if (w.alerts !== undefined) {
    assert.ok(Array.isArray(w.alerts), 'weather.alerts not an array');
    for (const a of w.alerts) assert.ok(a.event, 'alert missing event');
  }
  if (d.watch !== undefined) {
    assert.ok(Array.isArray(d.watch) && d.watch.length <= 3, 'watch must be an array of <=3');
    for (const x of d.watch) assert.ok(typeof x === 'string' && x.trim(), 'watch entry empty');
  }
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

  // --dryrun does every fetch but skips the Claude call, and reports what the model
  // WOULD have seen per feed. This is the check for the selection layer: pool diversity
  // is the thing that silently regresses, and it costs nothing to look.
  const dry = process.argv.includes('--dryrun');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  assert.ok(apiKey || dry, 'ANTHROPIC_API_KEY not set');

  const dayOfYear = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 864e5);
  const theme = THEMES[dayOfYear % THEMES.length];

  const [local, stlouis, world, india, immigration, finance, ai, weather, markets] = await Promise.all([
    fetchPool(FEEDS.local), fetchPool(FEEDS.stlouis), fetchPool(FEEDS.world), fetchPool(FEEDS.india),
    fetchPool(FEEDS.immigration, STANDING_MAX_AGE_DAYS), fetchPool(FEEDS.finance), fetchPool(FEEDS.ai),
    fetchWeather(), fetchMarkets(),
  ]);
  const pools = { local, stlouis, world, india, immigration, finance, ai };
  // A transient empty secondary feed shouldn't nuke the whole briefing — that section
  // just renders short/empty this run. Only abort if the primary (local) pool is empty.
  for (const [k, v] of Object.entries(pools)) if (!v.length) console.warn(`empty pool: ${k} (all feeds failed this run)`);
  assert.ok(local.length, 'primary pool (local) empty — aborting rather than publishing an empty briefing');

  if (dry) {
    let total = 0;
    for (const [name, pool] of Object.entries(pools)) {
      const bySrc = {};
      for (const it of pool) bySrc[it.source] = (bySrc[it.source] || 0) + 1;
      const share = Math.max(0, ...Object.values(bySrc)) / (pool.length || 1);
      const ages = pool.map(i => new Date(i.isoDate).getTime()).filter(Number.isFinite);
      const hours = ages.length ? (Math.max(...ages) - Math.min(...ages)) / 3.6e6 : 0;
      total += pool.length;
      console.log(`
${name}: ${pool.length} candidates, ${Object.keys(bySrc).length} outlets, `
        + `top outlet ${(share * 100).toFixed(0)}%, span ${hours.toFixed(1)}h`);
      if (share > 0.6) console.warn(`  WARN ${name}: one outlet holds ${(share * 100).toFixed(0)}% — pool is crowded`);
    }
    console.log(`
TOTAL candidates the model would see: ${total}`);
    console.log(`weather: ${weather.now ?? '?'}°F now, high ${weather.high}, `
      + `${weather.alerts.length} active alert(s) @ ${PLACE}`);
    for (const a of weather.alerts) console.log(`  ALERT ${a.severity}: ${a.event}`);
    console.log(`markets: ${markets.map(m => `${m.symbol} ${m.changePct >= 0 ? '+' : ''}${m.changePct}%`).join(', ') || 'none'}`);
    return;
  }

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 10000,  // 31 multi-sentence summaries + micro cards; headroom so JSON never truncates
    messages: [{ role: 'user', content: buildPrompt(pools, theme) }],
  });
  const r = extractJson(msg.content[0].text);

  const digest = {
    generatedAt: new Date().toISOString(),
    location: PLACE,
    weather,
    // 3 forward-looking lines; every briefing in the reference set closed with these.
    watch: (Array.isArray(r.watch) ? r.watch : []).map(w => String(w).trim()).filter(Boolean).slice(0, 3),
    tabs: {
      local: { items: resolvePicks(local, r.local, 5), stlouis: resolvePicks(stlouis, r.stlouis, 3) },
      world: { items: resolvePicks(world, r.world, 5) },
      india: { items: resolvePicks(india, r.india, 5), immigration: resolvePicks(immigration, r.immigration, 3) },
      finance: { items: resolvePicks(finance, r.finance, 5), quotes: markets,
                 note: String(r.marketsNote ?? '').trim() },
    },
    micro: { ...r.micro, ai: resolvePicks(ai, r.ai, 5) },
  };

  dedupeAcross(digest.tabs, digest.micro);
  validateDigest(digest);
  writeFileSync(OUT, JSON.stringify(digest, null, 2));
  console.log(`wrote ${OUT} @ ${digest.generatedAt} (theme: ${theme})`);
}

// Only run the network build when executed directly, not when imported by a test.
// (Portable across Node 20 — import.meta.main predates it by years.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
