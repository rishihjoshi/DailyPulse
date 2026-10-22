// DailyPulse — reads the pre-built digest.json and renders 5 tabs.
// No API key, no AI, no network beyond fetching its own digest (built by the Action).

const APP_VERSION = '23'; // keep in sync with CACHE_NAME in sw.js (dailypulse-v23)

const TITLES = {
  local: 'USA',
  world: 'World',
  india: 'India',
  finance: 'Finance',
  micro: 'Learn',   // match the nav button label in index.html
  history: 'History',
};
const TABS = Object.keys(TITLES);

const REPO = 'rishihjoshi/DailyPulse';
const LS = { seen: 'dp:seenLinks', theme: 'dp:theme' };

// Every tab leads with an image hero (photo, animated GIF, or animated SVG); same
// double-rule divider underneath. `mod` adds a crop variant (e.g. 'anchor-top').
function tabHero(src, alt, mod = '') {
  // `fetchpriority=high` on the hero of the tab being shown; the others are never
  // requested at all because only the active tab is rendered.
  return `<div class="tab-hero ${mod}"><img src="${src}" alt="${esc(alt)}" width="640" height="360"
    loading="eager" decoding="async" fetchpriority="high"></div>`;
}

let digest = null;         // the digest currently on screen (live, or a historical one)
let live = null;           // the latest digest, kept so "Back to latest" is instant
let current = 'local';
let viewingSha = null;     // non-null while reading an archived run
let historyRuns = null;    // cached commit list for the History tab
let newLinks = new Set();  // story links not present on the reader's previous visit
const scrollMem = new Map();   // tab -> scrollTop, so returning keeps your place

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// esc() keeps a value inside the quoted attribute but does NOT block the javascript:/data:
// scheme, so href needs its own allowlist: only http(s) links render, anything else → '#'.
const safeUrl = u => /^https?:\/\//i.test(String(u ?? '').trim()) ? String(u).trim() : '#';

// "Read: AP · BBC · Reuters" — 2-3 external source links. Falls back to the single
// {source, link} for an older digest that predates the sources array.
function sourceChips(it) {
  const sources = (it.sources && it.sources.length)
    ? it.sources
    : (it.link ? [{ source: it.source, link: it.link }] : []);
  if (!sources.length) return '';
  return `<div class="sources"><span class="read">Read</span>` + sources.map(s =>
    `<a href="${esc(safeUrl(s.link))}" target="_blank" rel="noopener">${esc(s.source || 'Source')}</a>`
  ).join('') + `</div>`;
}

// `n` (optional) renders an editorial rank number (#2, #3…) for the ranked list.
// `i` (optional) is the position in the list, used only to stagger the entrance animation.
//
// Collapsed by default via native <details>/<summary>: keyboard operation, the
// expanded/collapsed state announced to screen readers, and find-in-page all come free —
// no JS, no state to keep in sync. A story with no body stays a plain <article> so there
// is never a disclosure arrow that reveals nothing.
function newsItem(it, n, i = 0) {
  const num = n ? `<span class="num">#${n}</span> ` : '';
  const isNew = it.link && newLinks.has(it.link)
    ? '<span class="new-dot" title="New since your last visit">New</span> ' : '';
  const summary = it.summary || it.why || '';
  const head = `<h3>${num}${isNew}${esc(it.title)}</h3>`;
  if (!summary) return `<article class="item" style="--i:${i}">${head}${sourceChips(it)}</article>`;
  return `<details class="item" style="--i:${i}">
    <summary>${head}<span class="chev" aria-hidden="true"></span></summary>
    <div class="reveal">
      <div class="summary">${esc(summary)}</div>
      ${sourceChips(it)}
    </div>
  </details>`;
}

function topStory(it, n = 1) {
  const summary = it.summary || it.why || '';
  return `<article class="top-story">
    <div class="flag">Top Story</div>
    <h2><span class="num">#${n}</span> ${esc(it.title)}</h2>
    ${summary ? `<div class="summary">${esc(summary)}</div>` : ''}
    ${sourceChips(it)}
  </article>`;
}

// A ranked list: first item is the Top Story (#1), the rest are numbered #2, #3…
function rankedBlock(items) {
  if (!items || !items.length) return '<div class="empty">No stories yet — check back after the next update.</div>';
  const [top, ...rest] = items;
  return topStory(top, 1) + rest.map((it, i) => newsItem(it, i + 2, i + 1)).join('');
}

// Severe-weather alerts are the only thing in this briefing that's actionable within the
// hour, so they render above the news rather than inside the weather card.
function renderAlerts(alerts) {
  if (!alerts || !alerts.length) return '';
  return `<div class="alerts" role="alert">` + alerts.map(a =>
    `<div class="alert sev-${esc(String(a.severity || '').toLowerCase())}">
      <div class="alert-event">⚠ ${esc(a.event)}</div>
      ${a.headline ? `<div class="alert-text">${esc(a.headline)}</div>` : ''}
    </div>`).join('') + `</div>`;
}

function renderWeather(w, place) {
  const now = (w.now ?? null) !== null
    ? `<div class="meta now">Now ${esc(w.now)}°F · ${esc(w.nowLabel || w.label)}</div>` : '';
  return `<div class="weather">
    <div class="emoji">${esc(w.emoji)}</div>
    <div>
      <div class="temps">${esc(w.high)}°F / ${esc(w.highC)}°C</div>
      ${now}
      <div class="meta">${esc(w.label)} · Low ${esc(w.low)}°F (${esc(w.lowC)}°C) · ${esc(w.precip)}% precipitation</div>
      <div class="meta">🌅 ${esc(w.sunrise)} · 🌇 ${esc(w.sunset)} · 💨 ${esc(w.wind)} mph · ${esc(place || 'St. Charles, MO')}</div>
    </div>
  </div>`;
}

// Closes the briefing with what could move tomorrow, the way the reference briefings did.
function renderWatch(watch) {
  if (!watch || !watch.length) return '';
  return `<div class="section-label">🎯 Three things to watch</div>`
    + `<ol class="watch">` + watch.map(w => `<li>${esc(w)}</li>`).join('') + `</ol>`;
}

const fmtNum = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Compact index grid at the top of Finance. Up/down shown by sign + colour (not colour alone).
function renderMarkets(quotes) {
  if (!quotes || !quotes.length) return '';
  return `<div class="markets">` + quotes.map(q => {
    const up = Number(q.changePct) >= 0;
    const pct = `${up ? '+' : ''}${Number(q.changePct).toFixed(2)}%`;
    return `<div class="quote ${up ? 'up' : 'down'}">
      <div class="q-name">${esc(q.name)}</div>
      <div class="q-price">${esc(fmtNum(q.price))}</div>
      <div class="q-chg">${esc(pct)}</div>
    </div>`;
  }).join('') + `</div>`;
}

function subSection(label, items, emptyMsg) {
  return `<div class="section-label">${esc(label)}</div>`
    + (items && items.length ? items.map((it, i) => newsItem(it, 0, i)).join('') : `<div class="empty">${esc(emptyMsg)}</div>`);
}

// ── History ───────────────────────────────────────────────────────────────────
// No new storage: every scheduled build already commits digest.json to the `data`
// branch, so that branch IS the archive (41 runs at the time of writing). Both calls
// below are public, keyless and CORS-enabled.
const HISTORY_API = `https://api.github.com/repos/${REPO}/commits?sha=data&path=digest.json&per_page=40`;
// The sha reaches here from the commits API and from the URL hash. parseHash already
// validates its copy; this validates every caller, so nothing can be smuggled into the
// path (a '..' segment would otherwise point the fetch somewhere else in the repo).
export const isSha = v => /^[0-9a-f]{7,40}$/i.test(String(v ?? ''));
const digestAtSha = sha => `https://raw.githubusercontent.com/${REPO}/${sha}/digest.json`;

export function fmtRun(iso) {
  // Validate before formatting: toLocaleString does NOT throw on an invalid date, it
  // returns the literal string "Invalid Date", which would render straight into an
  // archive row.
  const t = new Date(iso ?? '').getTime();
  if (!Number.isFinite(t)) return '';
  try {
    return new Date(t).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
}

// The in-flight promise is cached, not just the result: two quick taps on History
// would otherwise both pass the `if (historyRuns)` guard and fire duplicate requests
// against an unauthenticated API that allows only 60/hour.
let historyInFlight = null;
function loadHistory() {
  if (historyRuns) return Promise.resolve(historyRuns);
  if (historyInFlight) return historyInFlight;
  historyInFlight = (async () => {
    const res = await fetch(HISTORY_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`history HTTP ${res.status}`);
    historyRuns = (await res.json()).map(c => ({
      sha: c.sha,
      date: (c.commit && c.commit.committer && c.commit.committer.date) || '',
    })).filter(r => r.sha);
    return historyRuns;
  })().finally(() => { historyInFlight = null; });
  return historyInFlight;
}

function renderHistory() {
  if (!historyRuns) {
    return `<div class="section-label">Past briefings</div>`
      + `<div class="skeleton" aria-hidden="true">`
      + Array.from({ length: 6 }, () => '<div class="skel skel-item"></div>').join('') + `</div>`;
  }
  if (!historyRuns.length) return '<div class="empty">No archived briefings found.</div>';
  return `<div class="section-label">Past briefings</div>`
    + `<div class="runs">` + historyRuns.map((r, i) => {
        const on = r.sha === viewingSha;
        return `<button class="run${on ? ' on' : ''}" data-sha="${esc(r.sha)}" style="--i:${i}"
          ${on ? 'aria-current="true"' : ''}>
          <span class="run-when">${esc(fmtRun(r.date))}</span>
          <span class="run-go" aria-hidden="true">${on ? 'Viewing' : 'Open'}</span>
        </button>`;
      }).join('') + `</div>`
    + `<div class="empty">Archived from the build history. Opening one shows that
        morning's briefing on every tab.</div>`;
}

// Banner shown on every tab while an archived run is open, so you can never forget
// you are reading old news.
function archiveBanner() {
  if (!viewingSha) return '';
  const run = (historyRuns || []).find(r => r.sha === viewingSha);
  const when = run ? fmtRun(run.date) : fmtRun(digest && digest.generatedAt);
  return `<div class="archive-bar" role="status">
    <span>Archived briefing — ${esc(when)}</span>
    <button class="to-live" type="button">Back to latest</button>
  </div>`;
}

async function openRun(sha) {
  if (!isSha(sha)) { console.warn('ignoring malformed archive ref:', sha); return; }
  const main = document.getElementById('main');
  main.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(digestAtSha(sha), { cache: 'force-cache' });
    if (!res.ok) throw new Error(`digest HTTP ${res.status}`);
    digest = await res.json();
    viewingSha = sha;
    newLinks = new Set();          // newness is meaningless inside an archived run
    main.removeAttribute('aria-busy');
    show('local', true);
  } catch (err) {
    main.removeAttribute('aria-busy');
    console.error('archive load failed:', err);
    main.innerHTML = `<div class="error" role="alert"><p>Couldn't open that briefing.</p></div>`;
  }
}

function backToLive() {
  if (!live) return;
  digest = live;
  viewingSha = null;
  computeNew(digest);
  show(current === 'history' ? 'history' : current, true);
}

// ── "New since your last visit" ────────────────────────────────────────────────
// There are no per-story timestamps in the digest, so newness is computed by diffing
// story links against the set stored on the previous visit. The set is persisted
// immediately after the diff, so badges reflect "since last time you opened this",
// not "since the last build" — which is the question you actually have at 6am.
function allLinks(d) {
  const out = [];
  const push = l => { for (const it of (l || [])) if (it.link) out.push(it.link); };
  const t = d.tabs || {};
  push(t.local && t.local.items); push(t.local && t.local.stlouis);
  push(t.world && t.world.items);
  push(t.india && t.india.items); push(t.india && t.india.immigration);
  push(t.finance && t.finance.items);
  push(d.micro && d.micro.ai);
  return out;
}

// Which tab each link belongs to, for the nav badges.
function linksByTab(d) {
  const t = d.tabs || {}, m = {};
  const add = (tab, l) => { for (const it of (l || [])) if (it.link) (m[tab] ||= []).push(it.link); };
  add('local', t.local && t.local.items); add('local', t.local && t.local.stlouis);
  add('world', t.world && t.world.items);
  add('india', t.india && t.india.items); add('india', t.india && t.india.immigration);
  add('finance', t.finance && t.finance.items);
  add('micro', d.micro && d.micro.ai);
  return m;
}

export function diffNew(links, seen) {
  const s = new Set(seen || []);
  return new Set((links || []).filter(l => l && !s.has(l)));
}

function computeNew(d) {
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(LS.seen) || '[]'); } catch { seen = []; }
  const links = allLinks(d);
  newLinks = diffNew(links, seen);
  // First ever visit: everything would be "new", which is noise, not information.
  if (!seen.length) newLinks = new Set();
  try { localStorage.setItem(LS.seen, JSON.stringify(links)); } catch { /* private mode */ }
}

function paintBadges() {
  const byTab = digest ? linksByTab(digest) : {};
  for (const btn of document.querySelectorAll('.nav-btn')) {
    const tab = btn.dataset.tab;
    const n = (byTab[tab] || []).filter(l => newLinks.has(l)).length;
    let b = btn.querySelector('.badge');
    if (!n || viewingSha) { if (b) b.remove(); continue; }
    if (!b) {
      b = document.createElement('span');
      b.className = 'badge';
      btn.appendChild(b);
    }
    b.textContent = n > 9 ? '9+' : String(n);
    // Announced as a complete phrase rather than a bare number.
    b.setAttribute('aria-label', `${n} new ${n === 1 ? 'story' : 'stories'}`);
  }
}

function renderTab(tab) {
  if (tab === 'history') return archiveBanner() + renderHistory();
  const t = digest.tabs;
  if (tab === 'local') {
    return archiveBanner()
      + tabHero('./usa-news.jpg', 'USA General News — US Capitol, flag, and city skyline')
      + renderAlerts(digest.weather && digest.weather.alerts)
      + renderWeather(digest.weather, digest.location) + rankedBlock(t.local.items)
      + subSection('St. Louis Metro', t.local.stlouis, 'No St. Louis metro news today.')
      + renderWatch(digest.watch);
  }
  if (tab === 'world') return archiveBanner()
    + tabHero('./world-globe.svg', 'Spinning globe — world news') + rankedBlock(t.world.items);
  if (tab === 'india') {
    return archiveBanner()
      + tabHero('./india-flag.jpg', 'Indian national flag at India Gate, New Delhi', 'ken-burns') + rankedBlock(t.india.items)
      + subSection('US–India Immigration', t.india.immigration, 'No US–India immigration news today.');
  }
  if (tab === 'finance') {
    const note = t.finance && t.finance.note;
    return archiveBanner() + tabHero('./finance-banner.svg', 'Market Pulse — finance')
      + renderMarkets(t.finance && t.finance.quotes)
      + (note ? `<div class="markets-note">${esc(note)}</div>` : '')
      + rankedBlock(t.finance && t.finance.items);
  }
  if (tab === 'micro') {
    const m = digest.micro;
    return archiveBanner() + tabHero('./micro-banner.svg', 'Daily Lesson — microlearning')
      + `<span class="theme-pill">Today: ${esc(m.theme)}</span>`
      + m.cards.map((c, i) => `<details class="card" style="--i:${i}">
          <summary><h3>${esc(c.title)}</h3><span class="chev" aria-hidden="true"></span></summary>
          <div class="reveal">
            <div class="insight">${esc(c.insight)}</div>
            <div class="takeaway"><b>Try this:</b> ${esc(c.takeaway)}</div>
          </div>
        </details>`).join('')
      + subSection('AI News', m.ai, 'No AI news today.');
  }
  return '';
}

// ── URL state ─────────────────────────────────────────────────────────────────
// Hash form: #tab, or #tab@sha while reading an archived run. This makes tabs
// linkable and bookmarkable, makes browser Back behave, and makes a reload land
// where you were instead of always on USA.
export function parseHash(h) {
  const m = /^#?([a-z]+)(?:@([0-9a-f]{7,40}))?$/i.exec(String(h || '').trim());
  if (!m || !TABS.includes(m[1])) return null;
  return { tab: m[1], sha: m[2] || null };
}

// Guarded like registerSW: the module is imported directly by the Node tests, where
// there is no location/history.
const hashNow = () => (typeof location === 'undefined' ? '' : location.hash);

function writeHash(tab, sha) {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const want = '#' + tab + (sha ? '@' + sha : '');
  if (location.hash !== want) history.replaceState(null, '', want);
}

function show(tab, focus = false) {
  const main = document.getElementById('main');
  // Remember where you were on the tab you're leaving, before it's torn down.
  if (current && current !== tab) scrollMem.set(current, main.scrollTop);
  current = tab;
  document.getElementById('tab-title').textContent = TITLES[tab];
  main.innerHTML = renderTab(tab);
  // Restore your place rather than snapping to the top of every tab.
  main.scrollTop = scrollMem.get(tab) || 0;
  document.querySelectorAll('.nav-btn').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  paintBadges();
  writeHash(tab, viewingSha);
  if (focus) main.focus();  // move SR focus to the new panel on user tab change
  // The History tab fetches its list lazily, then re-renders in place.
  if (tab === 'history' && !historyRuns) {
    loadHistory().then(() => { if (current === 'history') show('history'); })
      .catch(err => {
        console.warn('history unavailable:', err.message);
        document.getElementById('main').innerHTML =
          `<div class="error" role="alert"><p>Couldn't load the archive.</p></div>`;
      });
  }
}

function fmtUpdated(iso) {
  try {
    return 'Updated ' + new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
}

// Briefing is built ~2x/day; if it's clearly older than a day the scheduled build
// has likely been failing, so flag it rather than showing stale news as current.
function freshness(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { label: '', stale: false };
  const label = fmtUpdated(iso);
  const stale = now - t > 24 * 3.6e6;
  return { label: stale ? `⚠ ${label} · may be stale` : label, stale };
}

// Skeleton that mirrors the real layout (weather block + a few cards) so there's
// no layout shift when content arrives.
const SKELETON =
  '<div class="skel skel-weather"></div>'
  + '<div class="skel skel-top"></div>'
  + Array.from({ length: 4 }, () => '<div class="skel skel-item"></div>').join('');

// The digest lives on the repo's `data` branch (refreshed by the scheduled Action),
// so updating the briefing never touches main and never redeploys the app. Fetched
// cross-origin from GitHub raw; the service worker caches it network-first for offline.
const DIGEST_URL = 'https://raw.githubusercontent.com/rishihjoshi/DailyPulse/refs/heads/data/digest.json';

async function loadDigest() {
  const main = document.getElementById('main');
  main.setAttribute('aria-busy', 'true');
  main.innerHTML = `<div class="skeleton" aria-hidden="true">${SKELETON}</div>`;
  try {
    const res = await fetch(DIGEST_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    live = await res.json();
    digest = live;
    computeNew(digest);
    const f = freshness(digest.generatedAt);
    const u = document.getElementById('updated');
    u.textContent = f.label;
    u.classList.toggle('stale', f.stale);
    main.removeAttribute('aria-busy');
    // Deep link wins over the default tab; an archived sha loads that run.
    const route = parseHash(hashNow());
    if (route && route.sha) { current = route.tab; await openRun(route.sha); }
    else show(route ? route.tab : current);
  } catch (err) {
    main.removeAttribute('aria-busy');
    main.innerHTML =
      `<div class="error" role="alert">
        <p>Couldn't load today's briefing.</p>
        <button class="retry" type="button">Try again</button>
      </div>`;
    main.querySelector('.retry').addEventListener('click', loadDigest);
    console.error('digest load failed:', err);
  }
}

// ── Service worker + update prompt ──
// A new deploy ships a new SW that waits (sw.js no longer skipWaiting's). When one is
// detected we reveal the update banner; tapping Reload activates it and reloads once.
let updating = false;

function showUpdate(reg) {
  const b = document.getElementById('update-banner');
  if (!b || b.dataset.shown) return;          // show once
  b.dataset.shown = '1';
  b.hidden = false;
  document.getElementById('update-btn').addEventListener('click', () => {
    updating = true;
    reg.waiting && reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  });
}

function registerSW() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // Reload only for an update the user asked for — not the first-install claim.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload(); });
  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg);   // update already waiting
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(reg);
      });
    });
    // Catch deploys that landed while the PWA sat open in the background.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update();
    });
  }).catch(err => console.warn('SW:', err));
}


// ── Theme ─────────────────────────────────────────────────────────────────────
// Default follows the OS; the toggle sets an explicit override that persists.
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function systemDark() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}
export function nextTheme(stored, sysDark) {
  // One button, two states: flip away from whatever is showing now.
  const showing = stored || (sysDark ? 'dark' : 'light');
  return showing === 'dark' ? 'light' : 'dark';
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode) root.setAttribute('data-theme', mode); else root.removeAttribute('data-theme');
  const dark = mode ? mode === 'dark' : systemDark();
  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.innerHTML = dark ? SUN : MOON;
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#14110d' : '#faf8f4');
}

function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem(LS.theme); } catch { /* private mode */ }
  applyTheme(stored === 'dark' || stored === 'light' ? stored : null);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.addEventListener('click', () => {
    let cur = null;
    try { cur = localStorage.getItem(LS.theme); } catch {}
    const next = nextTheme(cur, systemDark());
    try { localStorage.setItem(LS.theme, next); } catch {}
    applyTheme(next);
  });
}

function init() {
  const v = document.getElementById('version');
  if (v) v.textContent = 'v' + APP_VERSION;
  initTheme();
  registerSW();
  document.getElementById('nav').addEventListener('click', e => {
    const btn = e.target.closest('.nav-btn');
    if (btn && digest) show(btn.dataset.tab, true);
  });
  // Archive list + "back to latest" are delegated, so re-renders don't need rebinding.
  document.getElementById('main').addEventListener('click', e => {
    const run = e.target.closest('.run');
    if (run) { openRun(run.dataset.sha); return; }
    if (e.target.closest('.to-live')) backToLive();
  });
  // Browser Back / forward between tabs.
  addEventListener('hashchange', () => {
    const r = parseHash(hashNow());
    if (!r || !digest) return;
    if (r.sha && r.sha !== viewingSha) { openRun(r.sha); return; }
    if (!r.sha && viewingSha) { backToLive(); return; }
    if (r.tab !== current) show(r.tab, true);
  });
  loadDigest();
}

// Guarded so the pure render helpers can be imported in Node tests without a DOM.
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

export { esc, safeUrl, newsItem, topStory, renderWeather, renderAlerts, renderWatch, rankedBlock, renderTab, show, loadDigest, freshness, showUpdate, APP_VERSION, TITLES, TABS };
