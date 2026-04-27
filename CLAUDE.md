# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run locally (dev)
python app.py
# Server starts at http://localhost:5000

# Install dependencies
pip install -r requirements.txt

# Check the full ticker universe
python stock_list.py
```

There are no tests. There is no lint configuration.

## Architecture

This is a Flask web app that screens US and Taiwan stocks using Yahoo Finance data, deployable to Vercel.

### Backend (`app.py`, `screener.py`, `stock_list.py`)

**`screener.py`** — core data layer:
- `fetch_ticker()` / `fetch_batch()`: pull data from `yfinance`, persist to disk as JSON in `cache/<TICKER>.json` (TTL 24h). On Vercel uses `/tmp/cache/` instead (detected via `VERCEL` env var).
- `screen()`: applies server-side filters (min/max numeric fields, boolean `above50dma`/`above200dma`).
- `compute_scores()`: produces 0–100 strategy fit scores (value, growth, momentum, quality, dividend, deepvalue) for each stock.
- `PRESETS`: dict of 6 named investment strategies with their filter definitions, used by both backend and frontend.

**`app.py`** — Flask routes and startup:
- `_stock_cache`: module-level list holding all stock dicts in memory.
- `_ensure_stocks_loaded()`: lazy-loads cache on first request; on Vercel also spawns a background thread to refresh live prices via `yf.download()` (single bulk HTTP call, refreshes at most every 15 min per instance).
- Vercel cold-start fallback: if `cache/` is empty, loads `data/stocks.json` (a bundled seed file committed to git) so the screener works immediately.
- `/api/chart/<ticker>`: computes all TA indicators server-side (SMA, EMA, BB, RSI, MACD, Stochastic, VWAP, ATR, OBV, Williams %R, CCI) and returns OHLCV + technicals as JSON.
- `/api/sparkline/<ticker>`: 3-month price history, cached for 6h.
- `/api/refresh` (POST): starts background thread to re-fetch all tickers from Yahoo Finance.

**`stock_list.py`** — ticker universe: S&P 500 (scraped from Wikipedia, with hardcoded fallback) + NASDAQ 100 + additional large/mid caps + major Taiwan TWSE stocks (`.TW` suffix for Yahoo Finance).

### Frontend

Two separate pages with independent JS:

**`/` — Screener (`templates/index.html` + `static/app.js` + `static/style.css`)**  
Uses Chart.js (CDN). Features: ticker tape, market indices, sector heatmap, top movers, news feed, preset strategy buttons, filter panel, sortable results table with inline sparklines, watchlist (localStorage), side-by-side compare modal. Sector and market cap filters are applied **client-side** after the server returns results.

**`/stock/<ticker>` — Full chart page (`templates/stock.html` + `static/chart.js` + `static/chart.css`)**  
Uses TradingView Lightweight Charts v4 (CDN). Three synchronized panels: price (candle/line + overlays), volume (bar + 20MA), oscillator (RSI / MACD / Stochastic / CCI). Has drawing tools (trend lines, horizontal lines, free draw) on a canvas overlay. Auto-period extension: automatically loads a longer period if the chart has too few bars. Displays news markers and insider transaction markers on the price chart.

### Deployment (Vercel)

`api/index.py` is the Vercel entry point — it just adds the repo root to `sys.path` and imports `app` from `app.py`. `vercel.json` routes all traffic there. The `cache/` directory is in `.gitignore`; only `data/stocks.json` is committed as seed data.

### Key design constraints

- **No database** — everything is flat JSON files on disk.
- **No build step** — vanilla JS, no bundler or transpilation.
- **`data/stocks.json`** must be kept reasonably fresh and committed for Vercel cold-start to work.
- Adding a new TA indicator requires changes in both `app.py` (`/api/chart` endpoint) and `static/chart.js` (rendering logic).
- Taiwan tickers use Yahoo Finance's `.TW` suffix (e.g., `2330.TW` for TSMC).
