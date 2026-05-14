# Stockdash

AI-powered stock research platform covering 559 US and Taiwan stocks. Built with Flask, vanilla JS, and Groq LLM.

## Features

- **AI Research Chat** — ask anything about a stock, get narrative analysis with bull/bear cases, key numbers, earnings, and peers
- **Stock Map** — Finviz-style treemap of the full S&P 500 + NASDAQ 100 universe, colored by daily change
- **Dashboard** — market indices, sector heatmap, top movers, swing trade setups, and watchlist
- **Portfolio Analysis** — track holdings, view performance vs SPY, and run AI analysis across your entire portfolio
- **Stock Charts** — TradingView-style charts with 12 technical indicators, news markers, and insider transactions

## Stack

- **Backend** — Python / Flask, deployed to Vercel
- **Data** — Yahoo Finance (yfinance), Finnhub (optional live quotes)
- **AI** — Groq (`llama-3.3-70b-versatile`) via PydanticAI agent with 14 tools
- **Frontend** — Vanilla JS, no framework, no build step
- **Auth** — Supabase (primary), env var fallback, local JSON fallback

## Local Setup

```bash
pip install -r requirements.txt
```

Create a `.env` file in the project root:

```
GROQ_API_KEY=...        # required — get free key at console.groq.com
FINNHUB_API_KEY=...     # optional — real-time quotes on stock page
SUPABASE_URL=...        # optional — persistent user accounts
SUPABASE_KEY=...        # anon JWT from Supabase Settings → API
SIGNUP_CODE=...         # optional — restrict signups to invite code
FLASK_SECRET_KEY=...    # optional locally, required on Vercel
```

```bash
python app.py
# → http://localhost:5000
```

Sign up at `/signup` (no invite code required locally).

## Deployment (Vercel)

Required env vars on Vercel:

```
FLASK_SECRET_KEY   # stable secret — must not change between deploys
GROQ_API_KEY       # or GEMINI_API_KEY as fallback
```

Plus either `AUTH_USERS=user1:pass1,user2:pass2` or `SUPABASE_URL` + `SUPABASE_KEY`.

The `data/stocks.json` seed file (559 stocks) is committed to the repo and serves as the cold-start data source. Live prices refresh in the background every 5 minutes.

## Expanding the Stock Universe

To add new S&P 500 / NASDAQ 100 stocks to the seed file:

```bash
python expand_stocks.py
```

This scrapes Wikipedia for current index constituents and fetches yfinance data for any new tickers, then merges them into `data/stocks.json`.
