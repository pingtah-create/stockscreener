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
```

## Architecture

Flask web app screening US and Taiwan stocks via Yahoo Finance, deployed to Vercel. No database, no build step — flat JSON files, vanilla JS.

### Pages and routes

| Route | Template | JS |
|-------|----------|----|
| `/` | `chat.html` | `chat.js`, `chat-home.css` |
| `/dashboard` | `dashboard.html` | `app.js`, `stock-map.js`, `style.css` |
| `/stock/<ticker>` | `stock.html` | `chart.js`, `chart.css` |
| `/login`, `/signup`, `/logout` | `login.html` | `login.css` |

All routes require login. HTML routes use `@auth.require_login` (redirects to `/login`). API routes use `@auth.require_login_api` (returns 401 JSON).

### Auth (`auth.py`)

Two modes depending on environment:
- **Local dev**: flat-file `auth/users.json` with werkzeug scrypt hashes. Signup enabled.
- **Vercel**: reads `AUTH_USERS=user1:pass1,user2:pass2` env var (hashed in memory at import time). Signup disabled. Secret key must be set via `FLASK_SECRET_KEY` env var — without it, every cold start generates a new key and sessions break immediately.

Required Vercel env vars: `FLASK_SECRET_KEY`, `AUTH_USERS`, `GROQ_API_KEY`.

### Backend (`app.py`, `screener.py`, `stock_list.py`)

**`screener.py`** — core data layer:
- `fetch_ticker()` / `fetch_batch()`: pull from yfinance, persist to `cache/<TICKER>.json` (TTL 12h). Vercel uses `/tmp/cache/`.
- `screen()`: server-side numeric and boolean filters.
- `compute_scores()`: 0–100 strategy scores (value, growth, momentum, quality, dividend, deepvalue).
- `compute_swing_setup()`: algorithmic swing trade signal with risk/reward ratio.

**`app.py`** — routes and in-memory cache:
- `_stock_cache`: module-level list of all stock dicts.
- `_load_all_from_cache()`: loads `data/stocks.json` seed first, then overlays individual `cache/<TICKER>.json` files on top. Both sources are always merged — never either/or.
- `_ensure_stocks_loaded()`: lazy-loads on first request; on Vercel also spawns a background thread for `_refresh_live_prices()`.
- `_refresh_live_prices()`: bulk `yf.download()` for all tickers, updates `currentPrice` and `regularMarketChangePercent` in memory. Throttled to once per 5 minutes per warm instance.
- `_twd_to_usd_rate()`: fetches `TWDUSD=X` from yfinance, 1-hour cache, fallback 0.031. Used in `/api/stockmap` to normalize Taiwan market caps to USD.

Key API endpoints:
- `POST /api/chat`: multi-turn Groq (llama-3.3-70b-versatile) chat via PydanticAI agent. Extracts tickers from the latest user message using `_extract_tickers()` (regex filtered against the ticker universe), injects compact fundamentals + 3 headlines per ticker as system context.
- `GET /api/stockmap`: treemap data. Taiwan `.TW` stocks get `sector="Taiwan"` and mcap × TWD/USD rate. US stocks excluded from movers but included in the map.
- `GET /api/movers`: top 5 gainers/losers. Explicitly excludes `.TW` stocks (different market session, stale change%).
- `POST /api/quotes`: batch live quotes for watchlist using `_live_quote()` in a ThreadPoolExecutor.
- `GET /api/quote/<ticker>`: single live quote. Tries Finnhub first for US stocks (if `FINNHUB_API_KEY` set), falls back to yfinance. 30s server cache.
- `GET /api/chart/<ticker>`: full OHLCV + all TA indicators (SMA, EMA, BB, RSI, MACD, Stochastic, VWAP, ATR, OBV, Williams %R, CCI) computed server-side.
- `GET /api/sparkline/<ticker>`: 3-month close prices, 2h cache.

**`stock_list.py`** — ticker universe: S&P 500 (Wikipedia-scraped with hardcoded fallback) + NASDAQ 100 + additional large/mid caps + major Taiwan TWSE stocks (`.TW` suffix).

### Frontend

**`/` — AI Chat (`chat.js` + `chat-home.css`)**
- Hero state (first load) collapses to thread view on first message send.
- Conversation history persisted in `localStorage` (`stockdash_chat_v1`), last 20 messages sent to `/api/chat` per request.
- Ticker pills auto-rendered from `data.tickers` in the API response, linking to `/stock/<ticker>`.
- Suggestion chips send preset questions on click.

**`/dashboard` — Dashboard (`app.js` + `stock-map.js` + `style.css`)**
- Auto-refresh intervals: indices 60s, movers 60s, heatmap 60s, stock map 60s, watchlist 30s, swing setups 120s.
- Watchlist stored in `localStorage`; quotes fetched live via `/api/quotes` (ThreadPoolExecutor on server).
- Stock map (`stock-map.js`): squarified treemap (Bruls/Huijsen/van Wijk algorithm), outer layout = sectors, inner layout = individual stocks. Tile color = `colorForChange()` — red ↔ grey ↔ green capped at ±5%.

**`/stock/<ticker>` — Chart (`chart.js` + `chart.css`)**
- TradingView Lightweight Charts v4 (CDN). Three synchronized panels: price, volume, oscillator.
- Drawing tools on canvas overlay. Auto-extends to a longer period if too few bars are returned.
- News markers and insider transaction markers rendered on the price panel.

### Deployment (Vercel)

`api/index.py` adds the repo root to `sys.path` and imports `app`. `vercel.json` routes all traffic there.

`data/stocks.json` (193 stocks: 150 US + 43 Taiwan) is committed to git as the cold-start seed. The `cache/` and `auth/` directories are gitignored.

### Key constraints

- Adding a TA indicator requires changes in both `app.py` (`/api/chart`) and `static/chart.js`.
- Taiwan mcap conversion happens only in `/api/stockmap` — the underlying cache values stay in TWD.
- `_load_all_from_cache()` must always merge seed + disk cache, not choose one. Breaking this causes either US or Taiwan stocks to disappear.
- Session cookies require a stable `FLASK_SECRET_KEY` on Vercel. Each cold start without it generates a new key, immediately invalidating all sessions.
