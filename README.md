# DailyPulse

![DailyPulse — twice-daily editorial briefings](docs/hero.svg)

Personal daily-briefing PWA that captures the rhythm of twice-daily updates
spanning US & local news, world events, India, and markets. Editorial-light,
newspaper-style, installable, offline-capable. Five tabs, refreshed on a schedule:

1. **USA** — the day's weather + 5 ranked US national stories, plus a **St. Louis Metro** subsection
2. **World** — 5 ranked world stories
3. **India** — 5 ranked India stories + a dedicated **US–India immigration** section
4. **Finance** — live index quotes (S&P/Nasdaq/Dow, India, world via ETF proxies) + 5 ranked markets stories
5. **Learn** — 3–5 original microlearning cards on a theme that rotates daily + an **AI News** section with 5 ranked AI stories

## How it works

A scheduled **GitHub Action** (`.github/workflows/build-digest.yml`, 2×/day) runs
`scripts/build-digest.mjs`, which:

1. fetches free **RSS** feeds for the seven news pools (`rss-parser`, multiple feeds each for resilience),
2. fetches **Open-Meteo** weather (no key) and **market quotes** from Yahoo's chart endpoint, Stooq as fallback (no key),
3. makes **one Claude call** (Haiku) that ranks each pool to the top items *by index* and writes a one-line
   "why it matters" per pick, plus the microlearning cards,
4. publishes the result as `digest.json` to the repo's **`data` branch** (via the contents API).

Decoupling the data onto its own branch means a content refresh **never redeploys the app** —
`main` only changes when code changes. The browser fetches `digest.json` from the `data` branch
over GitHub raw; it never holds an API key and makes no AI calls. The service worker caches the
shell and last digest for offline use, shows an **update prompt** when a new version ships, and the
header flags the briefing as **stale** if a build has been failing for over a day. A failed build
opens a tracking **issue** automatically.

```
Scheduled Action → build digest → PUT to `data` branch (Vercel ignores it)
                                        ↓
Deployed app (on main) → fetch raw.githubusercontent.com/.../data/digest.json
```

## Deploy (Vercel)

`vercel.json` serves the static `docs/` folder with no build step and disables deploys for the
`data` branch. Point a Vercel project at the repo; production is `main`. (GitHub Pages from `/docs`
also works as an alternative static host.)

## Setup

1. Push to a GitHub repo (public — the app fetches the digest from GitHub raw, which needs public + CORS).
2. **Settings → Secrets and variables → Actions** → add `ANTHROPIC_API_KEY`. (Weather and market quotes are keyless.)
3. Connect the repo to **Vercel** (or enable **Pages** from `/docs`).
4. **Actions** tab → run **Build daily digest** once via *Run workflow* to create the `data` branch and real data.

## Local development

```bash
npm install
npm test                                      # unit + render + browser-flow e2e, then digest self-check
npm run check                                 # validate the committed seed digest shape
ANTHROPIC_API_KEY=sk-ant-... npm run build    # do a real build (writes docs/data/digest.json locally)
npm run serve                                 # http://localhost:3000  (do NOT open via file://)
```

## Notes / tuning

- **Weather** is hardcoded to St. Louis (lat/lon in `build-digest.mjs`); the St. Louis Metro news feed is separate.
- **Finance quotes** use US-listed ETF proxies labelled with their ticker; the Finance tab degrades to news-only if both quote sources are unreachable.
- **Cadence**: cron is `0 11,23 * * *` UTC (~6am/6pm CT). Drop to once/day to cut cost.
- **Version**: keep `APP_VERSION` in `docs/app.js` in sync with `CACHE_NAME` in `docs/sw.js` when shipping a UI change.
- A code map of the project (communities, god nodes, dependencies) lives in `graphify-out/GRAPH_REPORT.md` / `graph.html`.
