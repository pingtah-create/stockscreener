# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run locally (dev)
python app.py
# Server starts at http://localhost:5000

# Install dependencies
pip install -r requirements.txt

# One-off: fetch Taiwan tickers and merge into data/stocks.json seed file
python fetch_taiwan.py

# Check the full ticker universe
python stock_list.py
```

There are no tests and no lint configuration.

Local dev uses `.env` for secrets (auto-loaded by `app.py`):
```
GROQ_API_KEY=...      # free key from console.groq.com — powers all AI features
FINNHUB_API_KEY=...   # optional — enables real-time quotes on stock page
SUPABASE_URL=...      # optional — enables cloud user storage and portfolio/watchlist sync
SUPABASE_KEY=...      # anon JWT key (eyJ...) from Supabase Settings → API
SIGNUP_CODE=...       # optional — if set, users must enter this code to create an account
```

## Architecture

Flask web app screening US and Taiwan stocks via Yahoo Finance, deployed to Vercel. No database, no build step — flat JSON files, vanilla JS.

### Pages and routes

| Route | Template | JS |
|-------|----------|----|
| `/` | `chat.html` | `chat.js`, `chat-home.css` |
| `/dashboard` | `dashboard.html` | `app.js`, `stock-map.js`, `style.css` |
| `/stock/<ticker>` | `stock.html` | `chart.js`, `chart.css` |
| `/portfolio` | `portfolio.html` | `portfolio.js`, `portfolio.css` |
| `/login`, `/signup`, `/logout` | `login.html` | `login.css` |

All routes require login. HTML routes use `@auth.require_login` (redirects to `/login`). API routes use `@auth.require_login_api` (returns 401 JSON).

### Auth (`auth.py`)

Three-tier user storage, tried in order:
1. **Supabase** (`users` table, RLS must be disabled): persistent cross-device accounts. Active when `SUPABASE_URL` + `SUPABASE_KEY` are set.
2. **`AUTH_USERS` env var**: `user1:pass1,user2:pass2` — backwards-compat for Vercel deployments without Supabase.
3. **Flat-file `auth/users.json`**: local dev fallback, werkzeug scrypt hashes.

Signup is enabled when `SIGNUP_CODE` env var is set (Vercel) or in local dev (no code required). The signup page shows an invite code field only when `SIGNUP_CODE` is required. `SIGNUP_CODE` is read at call-time (`os.environ.get()` inside a function), not at import time — important because dotenv loads after the module imports.

`FLASK_SECRET_KEY` must be stable on Vercel — without it, every cold start generates a new key, invalidating sessions.

Required Vercel env vars: `FLASK_SECRET_KEY`, `GROQ_API_KEY`, and either `AUTH_USERS` or `SUPABASE_URL`+`SUPABASE_KEY`.

### AI layer (`agent.py`)

All AI runs through Groq (model `llama-3.3-70b-versatile`, OpenAI-compatible API). The env var is read as `GROQ_API_KEY` with fallback to `GEMINI_API_KEY` — the fallback exists because the Vercel deployment can't rename that env var.

Two AI paths in `agent.py`:
- **`run_debate_analysis(ticker, ...)`**: single-stock deep-dive. Gathers fundamentals, technicals, peers (in-memory, no I/O), then fetches news + analyst consensus + earnings in parallel (`ThreadPoolExecutor(3)`), then calls Groq directly via `requests.post`. Returns structured markdown with story/bull/bear/key numbers.
- **`run_agent(messages, ...)`**: everything else. Uses PydanticAI `Agent` with 14 registered tools (fundamentals, technicals, news, screening, options, macro, etc.). Falls back to a plain Groq call if PydanticAI's tool-calling loop fails.

`run_agent` routes single-stock analysis questions to `run_debate_analysis` via `_detect_analysis_ticker()` before hitting the PydanticAI path.

`app.py` also has `_groq_complete()` — a thin helper used by non-chat endpoints (`/api/intel`, `/api/swing`, `/api/news-events`) that need one-shot Groq calls.

### Backend (`app.py`, `screener.py`, `stock_list.py`)

**`screener.py`** — core data layer:
- `fetch_ticker()` / `fetch_batch()`: pull from yfinance, persist to `cache/<TICKER>.json` (TTL 12h). Vercel uses `/tmp/cache/`.
- `screen()`: server-side numeric and boolean filters.
- `compute_scores()`: 0–100 strategy scores (value, growth, momentum, quality, dividend, deepvalue).
- `compute_swing_setup()`: algorithmic swing trade signal with risk/reward ratio.

**`app.py`** — routes and in-memory cache:
- `_stock_cache`: module-level list of all stock dicts. Protected by `_stock_cache_lock` (double-checked locking in `_ensure_stocks_loaded()` prevents duplicate loads on concurrent cold-start requests).
- `_load_all_from_cache()`: loads `data/stocks.json` seed first, then overlays individual `cache/<TICKER>.json` files. Both are always merged — never either/or.
- `_ensure_stocks_loaded()`: lazy-loads on first request; on Vercel also spawns a background thread for `_refresh_live_prices()`.
- `_refresh_live_prices()`: bulk `yf.download()` for all tickers, updates `currentPrice` and `regularMarketChangePercent` in memory. Throttled to once per 5 minutes per warm instance.
- `_clean_ticker(raw)`: validates and uppercases a ticker string against a regex (`^[A-Z0-9]{1,5}(?:\.[A-Z]{1,2})?$`). Applied at every URL-parameter endpoint before passing to yfinance.
- `_twd_to_usd_rate()`: fetches `TWDUSD=X` from yfinance, 1-hour cache, fallback 0.031. Used in `/api/stockmap` to normalize Taiwan market caps to USD.
- `_swingscan_cache`: in-memory 2-minute cache for `/api/swingscan` — avoids recomputing `compute_swing_setup()` over all stocks on every dashboard refresh.

Key API endpoints:
- `POST /api/chat`: routes to `agent.run_agent()`. Extracts tickers from the reply via `_extract_tickers()` (regex filtered against ticker universe).
- `GET /api/stockmap`: treemap data. Taiwan `.TW` stocks get `sector="Taiwan"` and mcap × TWD/USD rate.
- `GET /api/movers`: top 5 gainers/losers, explicitly excludes `.TW` stocks.
- `POST /api/quotes`: batch live quotes for watchlist via `ThreadPoolExecutor`.
- `GET /api/chart/<ticker>`: full OHLCV + all TA indicators (SMA, EMA, BB, RSI, MACD, Stochastic, VWAP, ATR, OBV, Williams %R, CCI) computed server-side. Fetches a longer lookback period than displayed so indicators are warmed up at the left edge.
- `GET /api/sparkline/<ticker>`: 3-month close prices, 2h cache.
- `GET /api/intel/<ticker>`: AI company overview (business model, macro drivers, strengths, competitors). Cached 7 days on disk.
- `GET /api/swing/<ticker>`: AI swing trade setup. Cached 24h on disk.
- `GET /api/news-events/<ticker>`: AI-labelled significant price moves with nearby news. Cached 6h on disk.
- `GET /api/market-snapshot`: S&P 500, NASDAQ, VIX + Fear & Greed score (derived from VIX via `_calc_fg()`) + 2-sentence Groq narrative. Cached 1h in `_snapshot_cache`. VIX-to-F&G formula: `score = max(5, min(95, int(100 - (vix - 10) * 3.0)))`.
- `GET /api/trending`: top 10 US stocks ranked by `|change%| × (1 + min(5, vol/avgVol))`. No cache — uses in-memory `_stock_cache`.
- `GET /api/watchlist` / `POST /api/watchlist`: per-user watchlist. Reads/writes Supabase `watchlist` column first, localStorage fallback in the browser.

### Portfolio persistence (four layers)

Portfolio holdings use four redundant storage layers, tried in order on read:

1. **Supabase** (`portfolios` table, `holdings` column): primary layer when `SUPABASE_URL`+`SUPABASE_KEY` are set. RLS must be disabled on the table.
2. **Server disk** (`auth/portfolios/<user>.json` locally, `/tmp/portfolios/<user>.json` on Vercel): written on every `POST /api/portfolio/holdings`. Ephemeral on Vercel — wiped on cold starts.
3. **Cookie** (`pf_<user>`): set on every save, 90-day expiry, plain base64-encoded JSON (`{"u": username, "h": holdings}`). Survives logout. Not signed with `app.secret_key` — works across Vercel instances.
4. **`localStorage`** (key: `stockdash_portfolio_v1_<username>`): most reliable on Vercel. `init()` in `portfolio.js` reads localStorage *before* the server call; if the server returns empty, it uses localStorage and syncs back.

The Supabase `portfolios` table also stores `watchlist` in a second column — both are upserted together via the generic `_sb_save(username, **cols)` helper in `app.py`.

**Critical: `/api/portfolio/summary` is a POST that accepts `{holdings: [...]}` in the body.** The client always sends its current in-memory holdings — the server just fetches live prices. This endpoint never reads from disk during normal operation, which eliminates race conditions between `saveHoldings()` and `fetchSummary()` calls.

### Frontend

**`/` — AI Chat (`chat.js` + `chat-home.css`)**
- Hero state (first load) shows market snapshot, 6 skill cards, trending stocks, and session history. Collapses to thread view on first message.
- **Skills**: clicking a skill card (fundamentals, timing, swing, earnings, compare) shows a ticker input; "Market Overview" fires immediately. `runSkill()` builds the prompt and calls `send()`.
- **Market snapshot**: `loadMarketSnapshot()` fetches `/api/market-snapshot` on hero init. Indices dict keyed by `SP500`/`NASDAQ`/`VIX`; F&G at top-level `fg_score`/`fg_label`.
- **Trending**: `loadTrending()` fetches `/api/trending` (returns an array directly, not `{trending:[...]}`).
- **Session history**: each conversation gets a `currentSessionId`. `saveCurrentSession()` is called after every assistant reply. Up to 30 sessions stored in `localStorage` under `stockdash_sessions_v1_<username>`. "History" nav button toggles the history panel (on hero) or returns from chat to hero with history shown.
- Current conversation in `stockdash_chat_v1_<username>`; last 20 messages sent to `/api/chat`.

**`/dashboard` — Dashboard (`app.js` + `stock-map.js` + `style.css`)**
- Auto-refresh intervals: indices 60s, movers 60s, heatmap 60s, stock map 60s, watchlist 30s, swing setups 120s.
- Watchlist: `initWatchlist()` fetches from `/api/watchlist` first (Supabase-backed), falls back to `localStorage` (`stockdash_watchlist_v1_<username>`). `saveWatchlist()` fires-and-forgets `POST /api/watchlist` and updates localStorage.
- Stock map (`stock-map.js`): squarified treemap (Bruls/Huijsen/van Wijk algorithm). Tile color = `colorForChange()` — red ↔ grey ↔ green capped at ±5%.

**`/stock/<ticker>` — Chart (`chart.js` + `chart.css`)**
- TradingView Lightweight Charts v4 (CDN). Three synchronized panels: price, volume, oscillator.
- Drawing tools on canvas overlay. Auto-extends to a longer period if too few bars are returned.
- News markers and insider transaction markers rendered on the price panel.

**`/portfolio` — Portfolio (`portfolio.js` + `portfolio.css`)**
- Holdings input with ticker autocomplete (fetches `/api/screen` for the universe).
- `fetchSummary()` POSTs holdings to `/api/portfolio/summary` on every add/remove and every 60s auto-refresh.
- Full analysis (charts + AI) triggered manually via "Run Full Analysis" button → `POST /api/portfolio-analysis`.

### Deployment (Vercel)

`api/index.py` adds the repo root to `sys.path` and imports `app`. `vercel.json` routes all traffic there.

`data/stocks.json` (193 stocks: 150 US + 43 Taiwan) is committed to git as the cold-start seed. The `cache/` and `auth/` directories are gitignored.

### Key constraints

- Adding a TA indicator requires changes in both `app.py` (`/api/chart`) and `static/chart.js`.
- Taiwan mcap conversion happens only in `/api/stockmap` — the underlying cache values stay in TWD.
- `_load_all_from_cache()` must always merge seed + disk cache, not choose one. Breaking this causes either US or Taiwan stocks to disappear.
- `FLASK_SECRET_KEY` must be stable on Vercel — without it, sessions break on every cold start. The portfolio cookie is intentionally NOT signed with this key (plain base64) so it works across instances regardless.
- `GROQ_API_KEY` is read first; `GEMINI_API_KEY` is the fallback. Don't rename the Vercel env var.
- All ticker URL parameters must go through `_clean_ticker()` before being passed to yfinance — without it, arbitrary strings reach the Yahoo Finance API.
- Per-user localStorage keys use the pattern `stockdash_<feature>_v1_<username>`. `window.CURRENT_USER` is injected into every page template via `<script>window.CURRENT_USER = "{{ current_user or '' }}";</script>`.
- Supabase tables (`users`, `portfolios`) must have RLS disabled (`ALTER TABLE x DISABLE ROW LEVEL SECURITY`) — all access is server-side with the anon key.
- `SIGNUP_CODE` must be read inside a function (`os.environ.get()`) not at module level — dotenv loads after imports, so a module-level read always returns `""`.
- `/api/market-snapshot` response shape: `{fg_score, fg_label, narrative, headline, bullets, indices: {SP500, NASDAQ, VIX}}` — indices is a dict, not an array.
- `/api/trending` returns a bare array, not `{trending: [...]}`.
