"""
FinBot agent — PydanticAI with Gemini 2.5 Flash.
All 14 tool implementations are unchanged; the raw Gemini HTTP loop is replaced
with PydanticAI's Agent + RunContext dependency injection.
run_agent() is the main entry point called by /api/chat in app.py.
"""
import json
from dataclasses import dataclass
from datetime import datetime

import yfinance as yf


# ── TOOL IMPLEMENTATIONS ──────────────────────────────────────────────────────

def tool_get_stock_fundamentals(ticker: str, stock_cache: list) -> dict:
    ticker = ticker.upper().strip()
    data = next((s for s in stock_cache if s.get("symbol") == ticker), None)
    if not data:
        try:
            data = yf.Ticker(ticker).info
        except Exception:
            return {"error": f"No data found for {ticker}"}
    price = data.get("currentPrice") or data.get("previousClose")
    mcap  = data.get("marketCap")
    return {
        "ticker": ticker,
        "name": data.get("shortName") or data.get("longName"),
        "sector": data.get("sector"),
        "industry": data.get("industry"),
        "price": round(price, 2) if price else None,
        "change_pct": round(data["regularMarketChangePercent"], 2) if data.get("regularMarketChangePercent") else None,
        "market_cap_b": round(mcap / 1e9, 2) if mcap else None,
        "pe_trailing": data.get("trailingPE"),
        "pe_forward": data.get("forwardPE"),
        "pb": data.get("priceToBook"),
        "peg": data.get("pegRatio"),
        "ev_ebitda": data.get("enterpriseToEbitda"),
        "revenue_growth": data.get("revenueGrowth"),
        "earnings_growth": data.get("earningsGrowth"),
        "roe": data.get("returnOnEquity"),
        "gross_margin": data.get("grossMargins"),
        "operating_margin": data.get("operatingMargins"),
        "profit_margin": data.get("profitMargins"),
        "debt_equity": data.get("debtToEquity"),
        "current_ratio": data.get("currentRatio"),
        "52w_high": data.get("fiftyTwoWeekHigh"),
        "52w_low": data.get("fiftyTwoWeekLow"),
        "52w_position": data.get("fiftyTwoWeekPosition"),
        "50dma": data.get("fiftyDayAverage"),
        "200dma": data.get("twoHundredDayAverage"),
        "beta": data.get("beta"),
        "analyst_target": data.get("targetMeanPrice"),
        "analyst_rating": data.get("recommendationKey"),
        "short_ratio": data.get("shortRatio"),
        "short_float_pct": data.get("shortPercentOfFloat"),
        "institutional_pct": data.get("heldPercentInstitutions"),
        "insider_pct": data.get("heldPercentInsiders"),
        "scores": data.get("scores", {}),
    }


def tool_get_technical_signals(ticker: str, stock_cache: list) -> dict:
    ticker = ticker.upper().strip()
    data = next((s for s in stock_cache if s.get("symbol") == ticker), None)
    if not data:
        return {"error": f"No cached data for {ticker}"}
    price  = data.get("currentPrice") or data.get("previousClose")
    sma50  = data.get("fiftyDayAverage")
    sma200 = data.get("twoHundredDayAverage")
    rsi    = data.get("rsi14")
    signals = []
    if price and sma50:
        signals.append(f"Price {'ABOVE' if price > sma50 else 'BELOW'} 50-day MA ({'bullish' if price > sma50 else 'bearish'})")
    if price and sma200:
        signals.append(f"Price {'ABOVE' if price > sma200 else 'BELOW'} 200-day MA ({'bullish' if price > sma200 else 'bearish'})")
    if rsi:
        label = "overbought" if rsi > 70 else "oversold" if rsi < 30 else "neutral"
        signals.append(f"RSI {rsi:.1f} — {label}")
    if sma50 and sma200:
        signals.append(f"{'Golden cross (bullish)' if sma50 > sma200 else 'Death cross (bearish)'}: 50DMA {'>' if sma50 > sma200 else '<'} 200DMA")
    return {"ticker": ticker, "price": price, "50dma": sma50, "200dma": sma200, "rsi14": rsi, "signals": signals}


def tool_get_recent_news(ticker: str, count: int = 5) -> dict:
    ticker = ticker.upper().strip()
    try:
        news_raw = yf.Ticker(ticker).news or []
        headlines = []
        for n in news_raw[:count]:
            ct    = n.get("content", {})
            title = ct.get("title") or n.get("title", "")
            pub   = (ct.get("provider") or {}).get("displayName") or n.get("publisher", "")
            link  = (ct.get("canonicalUrl") or {}).get("url") or n.get("link", "")
            headlines.append({"title": title, "publisher": pub, "link": link})
        return {"ticker": ticker, "headlines": headlines}
    except Exception as e:
        return {"error": str(e)}


def tool_get_peer_comparison(ticker: str, stock_cache: list) -> dict:
    ticker = ticker.upper().strip()
    base = next((s for s in stock_cache if s.get("symbol") == ticker), None)
    if not base:
        return {"error": f"No data for {ticker}"}
    industry = base.get("industry")
    sector   = base.get("sector")
    peers = [s for s in stock_cache
             if s.get("symbol") != ticker
             and not s.get("symbol", "").endswith(".TW")
             and s.get("marketCap")
             and (s.get("industry") == industry or s.get("sector") == sector)]
    peers.sort(key=lambda s: s.get("marketCap", 0), reverse=True)
    peers = peers[:5]

    def row(s):
        price = s.get("currentPrice") or s.get("previousClose")
        mcap  = s.get("marketCap")
        return {
            "ticker": s.get("symbol"),
            "name": (s.get("shortName") or "")[:22],
            "market_cap_b": round(mcap / 1e9, 1) if mcap else None,
            "pe": s.get("trailingPE"),
            "fwd_pe": s.get("forwardPE"),
            "rev_growth": s.get("revenueGrowth"),
            "profit_margin": s.get("profitMargins"),
            "roe": s.get("returnOnEquity"),
            "change_pct": s.get("regularMarketChangePercent"),
        }

    return {"ticker": ticker, "industry": industry, "sector": sector,
            "base": row(base), "peers": [row(p) for p in peers]}


def tool_get_earnings_info(ticker: str) -> dict:
    ticker = ticker.upper().strip()
    try:
        t   = yf.Ticker(ticker)
        cal = {}
        try:
            c  = t.calendar
            ed = (c or {}).get("Earnings Date")
            if ed:
                cal["next_earnings"] = str(ed[0].date() if hasattr(ed[0], "date") else ed[0])
        except Exception:
            pass
        history = []
        try:
            df = t.earnings_history
            if df is not None and not df.empty:
                for _, r in df.tail(4).iterrows():
                    history.append({
                        "date": str(r.name.date() if hasattr(r.name, "date") else r.name),
                        "eps_estimate": r.get("epsEstimate"),
                        "eps_actual":   r.get("epsActual"),
                        "surprise_pct": round(float(r["surprisePercent"]) * 100, 1)
                            if r.get("surprisePercent") is not None else None,
                    })
        except Exception:
            pass
        return {"ticker": ticker, **cal, "eps_history": history}
    except Exception as e:
        return {"error": str(e)}


def tool_get_insider_activity(ticker: str) -> dict:
    ticker = ticker.upper().strip()
    try:
        df = yf.Ticker(ticker).insider_transactions
        if df is None or df.empty:
            return {"ticker": ticker, "transactions": [], "note": "No insider data available"}
        rows = []
        for _, r in df.head(8).iterrows():
            rows.append({
                "date":        str(r.get("startDate") or ""),
                "name":        str(r.get("filerName") or ""),
                "title":       str(r.get("filerRelation") or ""),
                "transaction": str(r.get("transactionText") or ""),
                "shares":      r.get("shares"),
                "value":       r.get("value"),
            })
        return {"ticker": ticker, "transactions": rows}
    except Exception as e:
        return {"ticker": ticker, "transactions": [], "error": str(e)}


def tool_get_dividend_info(ticker: str) -> dict:
    ticker = ticker.upper().strip()
    try:
        t    = yf.Ticker(ticker)
        info = t.info
        divs = t.dividends
        history = []
        if divs is not None and not divs.empty:
            for date, val in divs.tail(8).items():
                history.append({"date": str(date.date()), "amount": round(float(val), 4)})
        return {
            "ticker":          ticker,
            "dividend_yield":  info.get("dividendYield"),
            "annual_dividend": info.get("dividendRate"),
            "payout_ratio":    info.get("payoutRatio"),
            "recent_history":  history,
        }
    except Exception as e:
        return {"error": str(e)}


def tool_screen_stocks(stock_cache: list, sector: str = None,
                       strategy: str = None, limit: int = 10) -> dict:
    results = [s for s in stock_cache if not s.get("symbol", "").endswith(".TW")]
    if sector and sector.lower() not in ("all", ""):
        results = [s for s in results if (s.get("sector") or "").lower() == sector.lower()]
    if strategy:
        key     = strategy.lower()
        results = [s for s in results if s.get("scores", {}).get(key) is not None]
        results.sort(key=lambda s: s.get("scores", {}).get(key, 0), reverse=True)
    else:
        results.sort(key=lambda s: s.get("marketCap") or 0, reverse=True)
    rows = []
    for s in results[:limit]:
        price = s.get("currentPrice") or s.get("previousClose")
        mcap  = s.get("marketCap")
        rows.append({
            "ticker":      s.get("symbol"),
            "name":        (s.get("shortName") or "")[:22],
            "sector":      s.get("sector"),
            "price":       round(price, 2) if price else None,
            "change_pct":  s.get("regularMarketChangePercent"),
            "market_cap_b": round(mcap / 1e9, 1) if mcap else None,
            "pe":          s.get("trailingPE"),
            "scores":      s.get("scores", {}),
        })
    return {"results": rows, "total_matched": len(results), "sector": sector, "strategy": strategy}


def tool_get_market_overview(indices_cache: dict, stock_cache: list) -> dict:
    idx = {name: {"price": d["price"], "change_pct": d.get("change_pct", 0)}
           for name, d in (indices_cache or {}).items() if d.get("price") is not None}
    totals: dict = {}
    counts: dict = {}
    for s in stock_cache:
        sec = s.get("sector")
        chg = s.get("regularMarketChangePercent")
        if sec and chg is not None and not s.get("symbol", "").endswith(".TW"):
            totals[sec] = totals.get(sec, 0) + chg
            counts[sec] = counts.get(sec, 0) + 1
    sector_perf = dict(sorted(
        {sec: round(totals[sec] / counts[sec], 2) for sec in totals}.items(),
        key=lambda x: x[1], reverse=True
    ))
    return {"indices": idx, "sector_performance": sector_perf}


def tool_compare_stocks(tickers: list, stock_cache: list) -> dict:
    rows = []
    for t in tickers[:6]:
        t = t.upper().strip()
        s = next((x for x in stock_cache if x.get("symbol") == t), None)
        if not s:
            continue
        price = s.get("currentPrice") or s.get("previousClose")
        mcap  = s.get("marketCap")
        rows.append({
            "ticker":        t,
            "name":          (s.get("shortName") or "")[:22],
            "sector":        s.get("sector"),
            "price":         round(price, 2) if price else None,
            "change_pct":    s.get("regularMarketChangePercent"),
            "market_cap_b":  round(mcap / 1e9, 1) if mcap else None,
            "pe":            s.get("trailingPE"),
            "fwd_pe":        s.get("forwardPE"),
            "rev_growth":    s.get("revenueGrowth"),
            "profit_margin": s.get("profitMargins"),
            "roe":           s.get("returnOnEquity"),
            "beta":          s.get("beta"),
            "analyst_target": s.get("targetMeanPrice"),
            "analyst_rating": s.get("recommendationKey"),
            "scores":        s.get("scores", {}),
        })
    return {"comparison": rows}


def tool_get_analyst_consensus(ticker: str, stock_cache: list) -> dict:
    ticker = ticker.upper().strip()
    data   = next((s for s in stock_cache if s.get("symbol") == ticker), None)
    base   = {}
    if data:
        price  = data.get("currentPrice") or data.get("previousClose")
        target = data.get("targetMeanPrice")
        base   = {
            "current_price":  round(price, 2) if price else None,
            "target_mean":    target,
            "upside_pct":     round((target / price - 1) * 100, 1) if target and price else None,
            "target_low":     data.get("targetLowPrice"),
            "target_high":    data.get("targetHighPrice"),
            "recommendation": data.get("recommendationKey"),
            "num_analysts":   data.get("numberOfAnalystOpinions"),
        }
    # Buy/Hold/Sell distribution from recommendations summary (new yfinance format)
    distribution = {}
    try:
        recs = yf.Ticker(ticker).recommendations
        if recs is not None and not recs.empty:
            row = recs.iloc[0]
            sb  = int(row.get("strongBuy",  0) or 0)
            b   = int(row.get("buy",        0) or 0)
            h   = int(row.get("hold",       0) or 0)
            s   = int(row.get("sell",       0) or 0)
            ss  = int(row.get("strongSell", 0) or 0)
            distribution = {"strong_buy": sb, "buy": b, "hold": h,
                            "sell": s, "strong_sell": ss, "total": sb+b+h+s+ss}
    except Exception:
        pass

    # Recent firm upgrades/downgrades
    recent = []
    try:
        ud = yf.Ticker(ticker).upgrades_downgrades
        if ud is not None and not ud.empty:
            ud = ud.sort_index(ascending=False)
            for idx, r in ud.head(6).iterrows():
                firm = str(r.get("Firm") or "").strip()
                if not firm or firm in ("nan", "None", ""):
                    continue
                recent.append({
                    "date":       str(idx.date() if hasattr(idx, "date") else idx),
                    "firm":       firm,
                    "to_grade":   str(r.get("ToGrade")   or ""),
                    "from_grade": str(r.get("FromGrade") or ""),
                    "action":     str(r.get("Action")    or "").lower(),
                })
    except Exception:
        pass

    return {"ticker": ticker, **base, "distribution": distribution, "recent_changes": recent}


def tool_get_watchlist_analysis(tickers: list, stock_cache: list) -> dict:
    rows = []
    for t in tickers:
        t = t.upper().strip()
        s = next((x for x in stock_cache if x.get("symbol") == t), None)
        if not s:
            continue
        price = s.get("currentPrice") or s.get("previousClose")
        mcap  = s.get("marketCap")
        scores = s.get("scores") or {}
        best_strategy = max(scores, key=scores.get) if scores else None
        rows.append({
            "ticker":         t,
            "name":           (s.get("shortName") or "")[:22],
            "price":          round(price, 2) if price else None,
            "change_pct":     s.get("regularMarketChangePercent"),
            "sector":         s.get("sector"),
            "pe":             s.get("trailingPE"),
            "analyst_rating": s.get("recommendationKey"),
            "analyst_target": s.get("targetMeanPrice"),
            "best_strategy":  best_strategy,
            "top_score":      scores.get(best_strategy) if best_strategy else None,
        })
    rows.sort(key=lambda r: r.get("top_score") or 0, reverse=True)
    return {"watchlist": rows, "count": len(rows)}


def tool_get_options_chain(ticker: str) -> dict:
    ticker = ticker.upper().strip()
    try:
        t        = yf.Ticker(ticker)
        expiries = t.options
        if not expiries:
            return {"error": f"No options data for {ticker}"}
        expiry = expiries[0]
        chain  = t.option_chain(expiry)

        def fmt_side(df):
            rows = []
            for _, r in df.iterrows():
                rows.append({
                    "strike":        r.get("strike"),
                    "bid":           round(float(r["bid"]), 2)  if r.get("bid")  else None,
                    "ask":           round(float(r["ask"]), 2)  if r.get("ask")  else None,
                    "last":          round(float(r["lastPrice"]), 2) if r.get("lastPrice") else None,
                    "volume":        int(r["volume"])            if r.get("volume") and r["volume"] == r["volume"] else None,
                    "open_interest": int(r["openInterest"])      if r.get("openInterest") and r["openInterest"] == r["openInterest"] else None,
                    "iv":            round(float(r["impliedVolatility"]), 4) if r.get("impliedVolatility") else None,
                    "itm":           bool(r.get("inTheMoney", False)),
                })
            rows.sort(key=lambda x: x.get("open_interest") or 0, reverse=True)
            return rows[:8]

        price = None
        try:
            price = t.fast_info.last_price
        except Exception:
            pass

        return {
            "ticker":        ticker,
            "expiry":        expiry,
            "all_expiries":  list(expiries[:6]),
            "current_price": round(price, 2) if price else None,
            "calls":         fmt_side(chain.calls),
            "puts":          fmt_side(chain.puts),
            "put_call_ratio": round(
                chain.puts["volume"].sum() / chain.calls["volume"].sum(), 2
            ) if chain.calls["volume"].sum() > 0 else None,
        }
    except Exception as e:
        return {"error": str(e)}


def tool_get_macro_indicators() -> dict:
    import urllib.request as _ur
    result = {}

    market_tickers = {
        "10Y_yield":  "^TNX",
        "2Y_yield":   "^IRX",
        "VIX":        "^VIX",
        "USD_index":  "DX-Y.NYB",
        "Gold":       "GC=F",
        "Oil_WTI":    "CL=F",
        "Bitcoin":    "BTC-USD",
    }
    for label, sym in market_tickers.items():
        try:
            info  = yf.Ticker(sym).fast_info
            price = float(getattr(info, "last_price", None) or 0)
            prev  = float(getattr(info, "previous_close", None) or 0)
            chg   = round((price - prev) / prev * 100, 2) if prev else 0
            if price:
                result[label] = {"value": round(price, 2), "change_pct": chg}
        except Exception:
            pass

    wb_series = {
        "US_GDP_growth_pct":   ("US", "NY.GDP.MKTP.KD.ZG"),
        "US_inflation_pct":    ("US", "FP.CPI.TOTL.ZG"),
        "US_unemployment_pct": ("US", "SL.UEM.TOTL.ZS"),
    }
    for label, (country, indicator) in wb_series.items():
        try:
            url = (f"https://api.worldbank.org/v2/country/{country}/indicator/{indicator}"
                   f"?format=json&mrv=2&per_page=2")
            with _ur.urlopen(url, timeout=8) as r:
                data = json.loads(r.read())
            entries = [e for e in (data[1] or []) if e.get("value") is not None]
            if entries:
                latest = entries[0]
                result[label] = {"value": round(float(latest["value"]), 2), "year": latest.get("date")}
        except Exception:
            pass

    return result


# ── CLAUDE HAIKU AGENT ────────────────────────────────────────────────────────

_CLAUDE_MODEL = "claude-haiku-4-5"

# ── CLAUDE TOOL DEFINITIONS ───────────────────────────────────────────────────

CLAUDE_TOOLS = [
    {
        "name": "get_stock_fundamentals",
        "description": "Get valuation ratios, growth metrics, margins, moving averages, analyst target for a stock. Use this first for any single-stock question.",
        "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
    },
    {
        "name": "get_technical_signals",
        "description": "Get RSI, 50/200-day MA position, golden/death cross signals. Use for timing, entry/exit, or chart-based questions.",
        "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
    },
    {
        "name": "get_recent_news",
        "description": "Get recent news headlines for a ticker. Use for news, catalysts, or 'what happened' questions.",
        "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}, "count": {"type": "integer", "default": 5}}, "required": ["ticker"]},
    },
    {
        "name": "get_analyst_consensus",
        "description": "Get analyst price targets, buy/hold/sell distribution, and recent upgrades/downgrades.",
        "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
    },
    {
        "name": "get_peer_comparison",
        "description": "Compare a stock vs industry peers on P/E, growth, margins. Use for 'vs peers' or 'is it cheap' questions.",
        "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
    },
    {
        "name": "get_earnings_info",
        "description": "Get next earnings date and last 4 quarters of EPS beat/miss history.",
        "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
    },
    {
        "name": "get_insider_activity",
        "description": "Get recent insider buying/selling. Use only when asked specifically about insider transactions.",
        "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
    },
    {
        "name": "get_dividend_info",
        "description": "Get dividend yield, payout ratio, and history. Use only for dividend or income questions.",
        "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
    },
    {
        "name": "get_options_chain",
        "description": "Get options chain data. Use only when asked about options, calls/puts, or implied volatility.",
        "input_schema": {"type": "object", "properties": {"ticker": {"type": "string"}}, "required": ["ticker"]},
    },
    {
        "name": "screen_stocks",
        "description": "Find top stocks by sector and/or strategy. Use for 'best value stocks', 'top growth stocks', screening questions.",
        "input_schema": {"type": "object", "properties": {
            "sector":   {"type": "string", "description": "Sector name or empty for all"},
            "strategy": {"type": "string", "enum": ["value", "growth", "momentum", "dividend", "quality", "deepvalue", ""]},
            "limit":    {"type": "integer", "default": 10}
        }},
    },
    {
        "name": "compare_stocks",
        "description": "Side-by-side comparison of multiple tickers. Use for 'AAPL vs MSFT' or 'compare X and Y' questions.",
        "input_schema": {"type": "object", "properties": {"tickers": {"type": "array", "items": {"type": "string"}}}, "required": ["tickers"]},
    },
    {
        "name": "get_market_overview",
        "description": "Get market indices and sector performance. Use for broad market or macro questions.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_macro_indicators",
        "description": "Get treasury yields, VIX, USD, gold, oil, bitcoin, GDP, inflation. Use for macro/economy questions.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

SYSTEM_PROMPT = f"""You are FinBot — a sharp financial analyst. Today: {datetime.utcnow().strftime('%Y-%m-%d')}.

You have tools to fetch real market data. Use them — never invent numbers.

Rules:
- ONLY use numbers that come from tool results. If a number is not in a tool result, write "data unavailable" — never guess.
- Call only the tools you actually need. A swing trade question needs fundamentals + technicals. A dividend question needs dividend_info. Don't call all tools every time.
- After getting data, write an opinionated, specific analysis. Use exact numbers as evidence.
- Be decisive: say BULLISH / BEARISH / LONG / SHORT with a reason, not "it depends".
- For follow-up questions, answer directly and briefly — no need to re-run full analysis.
- Write prose for narratives, tables only for comparisons."""


def _dispatch_tool(name: str, inp: dict, stock_cache: list, indices_cache: dict) -> dict:
    """Execute a tool call by name and return the result."""
    try:
        if name == "get_stock_fundamentals":
            return tool_get_stock_fundamentals(inp["ticker"], stock_cache)
        if name == "get_technical_signals":
            return tool_get_technical_signals(inp["ticker"], stock_cache)
        if name == "get_recent_news":
            return tool_get_recent_news(inp["ticker"], inp.get("count", 5))
        if name == "get_analyst_consensus":
            return tool_get_analyst_consensus(inp["ticker"], stock_cache)
        if name == "get_peer_comparison":
            return tool_get_peer_comparison(inp["ticker"], stock_cache)
        if name == "get_earnings_info":
            return tool_get_earnings_info(inp["ticker"])
        if name == "get_insider_activity":
            return tool_get_insider_activity(inp["ticker"])
        if name == "get_dividend_info":
            return tool_get_dividend_info(inp["ticker"])
        if name == "get_options_chain":
            return tool_get_options_chain(inp["ticker"])
        if name == "screen_stocks":
            return tool_screen_stocks(stock_cache, inp.get("sector"), inp.get("strategy"), inp.get("limit", 10))
        if name == "compare_stocks":
            return tool_compare_stocks(inp["tickers"], stock_cache)
        if name == "get_market_overview":
            return tool_get_market_overview(indices_cache, stock_cache)
        if name == "get_macro_indicators":
            return tool_get_macro_indicators()
        return {"error": f"Unknown tool: {name}"}
    except Exception as e:
        return {"error": str(e)}


def _run_claude_agent(messages: list, stock_cache: list, indices_cache: dict,
                      api_key: str, max_tokens: int = 2000) -> tuple[str, list]:
    """
    Runs a full Claude agentic loop with tool use.
    Returns (reply_text, tools_used_list).
    Claude decides which tools to call — we just execute them and feed results back.
    """
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)

    claude_messages = []
    for m in messages:
        role    = m.get("role")
        content = (m.get("content") or "").strip()
        if content and role in ("user", "assistant"):
            claude_messages.append({"role": role, "content": content})

    tools_used = []

    for _ in range(8):  # max 8 agentic turns
        resp = client.messages.create(
            model=_CLAUDE_MODEL,
            max_tokens=max_tokens,
            system=SYSTEM_PROMPT,
            tools=CLAUDE_TOOLS,
            messages=claude_messages,
        )

        # Collect any text and tool calls from this response
        text_parts = []
        tool_calls = []
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_calls.append(block)

        if resp.stop_reason == "end_turn" or not tool_calls:
            return "".join(text_parts), tools_used

        # Execute all tool calls in parallel, feed results back
        from concurrent.futures import ThreadPoolExecutor
        def _exec(tc):
            return tc.id, tc.name, _dispatch_tool(tc.name, tc.input, stock_cache, indices_cache)

        with ThreadPoolExecutor(max_workers=4) as ex:
            results = list(ex.map(_exec, tool_calls))

        for _, name, _ in results:
            if name not in tools_used:
                tools_used.append(name)

        # Append assistant turn with tool calls, then user turn with tool results
        claude_messages.append({"role": "assistant", "content": resp.content})
        claude_messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tc_id, "content": json.dumps(result)}
            for tc_id, _, result in results
        ]})

    return "Analysis incomplete — too many tool calls.", tools_used


def _run_claude_stream(messages: list, stock_cache: list, indices_cache: dict,
                       api_key: str, max_tokens: int = 2000):
    """
    Streaming Claude agent. Yields {"type": "chunk", "text": str} during streaming,
    then {"type": "done", "tools_used": list, "tickers": list} at the end.
    Tool calls are executed silently; only the final text response is streamed.
    """
    import anthropic, re as _re
    client = anthropic.Anthropic(api_key=api_key)

    claude_messages = []
    for m in messages:
        role    = m.get("role")
        content = (m.get("content") or "").strip()
        if content and role in ("user", "assistant"):
            claude_messages.append({"role": role, "content": content})

    tools_used = []

    for turn in range(8):
        # Non-streaming turns for tool calls; streaming only on the final text turn
        if turn == 0:
            # First turn: try streaming — if tool_use comes back, switch to non-streaming
            with client.messages.stream(
                model=_CLAUDE_MODEL,
                max_tokens=max_tokens,
                system=SYSTEM_PROMPT,
                tools=CLAUDE_TOOLS,
                messages=claude_messages,
            ) as stream:
                final = stream.get_final_message()

            tool_calls = [b for b in final.content if b.type == "tool_use"]
            if not tool_calls:
                # Pure text response — stream it out word by word from the collected text
                text = "".join(b.text for b in final.content if b.type == "text")
                for word in text.split(" "):
                    yield {"type": "chunk", "text": word + " "}
                tickers = list({t for t in _re.findall(r'\b[A-Z]{1,5}\b', text)
                                if any(s.get("symbol") == t for s in stock_cache)})
                yield {"type": "done", "tools_used": tools_used, "tickers": tickers}
                return
        else:
            resp = client.messages.create(
                model=_CLAUDE_MODEL,
                max_tokens=max_tokens,
                system=SYSTEM_PROMPT,
                tools=CLAUDE_TOOLS,
                messages=claude_messages,
            )
            final = resp
            tool_calls = [b for b in final.content if b.type == "tool_use"]

            if not tool_calls or final.stop_reason == "end_turn":
                # Final answer — stream it out
                text = "".join(b.text for b in final.content if b.type == "text")
                for word in text.split(" "):
                    yield {"type": "chunk", "text": word + " "}
                tickers = list({t for t in _re.findall(r'\b[A-Z]{1,5}\b', text)
                                if any(s.get("symbol") == t for s in stock_cache)})
                yield {"type": "done", "tools_used": tools_used, "tickers": tickers}
                return

        # Execute tool calls
        from concurrent.futures import ThreadPoolExecutor
        def _exec(tc):
            return tc.id, tc.name, _dispatch_tool(tc.name, tc.input, stock_cache, indices_cache)
        with ThreadPoolExecutor(max_workers=4) as ex:
            results = list(ex.map(_exec, tool_calls))

        for _, name, _ in results:
            if name not in tools_used:
                tools_used.append(name)

        claude_messages.append({"role": "assistant", "content": final.content})
        claude_messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tc_id, "content": json.dumps(result)}
            for tc_id, _, result in results
        ]})

    yield {"type": "chunk", "text": "Analysis incomplete."}
    yield {"type": "done", "tools_used": tools_used, "tickers": []}


# ── DEAD CODE — kept for reference only ──────────────────────────────────────

def _UNUSED_format_stock_sections(data: dict) -> str:  # dead code — kept for reference
    f  = data.get("fundamentals", {})
    t  = data.get("technicals", {})
    c  = data.get("consensus", {})
    n  = data.get("news", {})
    e  = data.get("earnings", {})
    sw = data.get("swing")

    def pct(v):           return f"{v*100:.1f}%" if v is not None else "—"
    def fmtf(v, d=".2f"): return f"{v:{d}}" if v is not None else "—"

    lines = []

    # ── Strategy Scores ───────────────────────────────────────
    scores = f.get("scores") or {}
    if scores:
        SCORE_LABELS = [("value","Value"),("growth","Growth"),("momentum","Momentum"),
                        ("quality","Quality"),("dividend","Dividend"),("deepvalue","DeepVal")]
        best = max(scores, key=scores.get) if scores else None
        parts = []
        for key, label in SCORE_LABELS:
            v = scores.get(key)
            if v is None: continue
            tag = f"**{label} {v}**" if key == best else f"{label} {v}"
            parts.append(tag)
        if parts:
            lines.append("### Strategy Scores")
            lines.append(" · ".join(parts))
            lines.append("")

    # ── Swing Setup ───────────────────────────────────────────
    if sw:
        lines.append("### Swing Setup")
        entry  = sw.get("entry");  stop   = sw.get("stop")
        target = sw.get("target"); rr     = sw.get("rr")
        upside = sw.get("upside_pct")
        line   = f"⚡ **{sw.get('type','')}**"
        if entry:  line += f"  ·  Entry ${entry:.2f}"
        if stop:   line += f"  |  Stop ${stop:.2f}"
        if target: line += f"  |  Target ${target:.2f}"
        if rr:     line += f"  |  R:R **{rr}x**"
        if upside: line += f"  |  +{upside:.1f}% upside"
        lines.append(line)
        lines.append("")

    # ── Fundamentals table ────────────────────────────────────
    lines.append("### Fundamentals")
    lines.append("| Metric | Value |")
    lines.append("|---|---|")
    mcap = f.get("market_cap_b")
    lines.append(f"| Market Cap | {'$'+fmtf(mcap, '.1f')+'B' if mcap else '—'} |")
    pe_ttm = fmtf(f.get("pe_trailing"), ".1f") if f.get("pe_trailing") else "—"
    pe_fwd = fmtf(f.get("pe_forward"),  ".1f") if f.get("pe_forward")  else "—"
    lines.append(f"| P/E (TTM / Fwd) | {pe_ttm} / {pe_fwd} |")
    lines.append(f"| P/B | {fmtf(f.get('pb'))} |")
    lines.append(f"| PEG | {fmtf(f.get('peg'))} |")
    lines.append(f"| EV/EBITDA | {fmtf(f.get('ev_ebitda'), '.1f')} |")
    lines.append(f"| Revenue Growth | {pct(f.get('revenue_growth'))} |")
    lines.append(f"| Earnings Growth | {pct(f.get('earnings_growth'))} |")
    lines.append(f"| ROE | {pct(f.get('roe'))} |")
    lines.append(f"| Gross / Op / Net Margin | {pct(f.get('gross_margin'))} / {pct(f.get('operating_margin'))} / {pct(f.get('profit_margin'))} |")
    lines.append(f"| Debt/Equity | {fmtf(f.get('debt_equity'), '.1f')} |")
    lines.append(f"| Beta | {fmtf(f.get('beta'))} |")
    lo, hi = f.get("52w_low"), f.get("52w_high")
    pos52 = f.get("52w_position")
    range_str = f"${fmtf(lo)} – ${fmtf(hi)}" if lo and hi else "—"
    if pos52 is not None: range_str += f" ({pos52:.0f}% of range)"
    lines.append(f"| 52W Range | {range_str} |")
    inst = f.get("institutional_pct")
    ins  = f.get("insider_pct")
    if inst is not None or ins is not None:
        own_parts = []
        if inst is not None: own_parts.append(f"Inst {inst*100:.1f}%")
        if ins  is not None: own_parts.append(f"Insider {ins*100:.1f}%")
        lines.append(f"| Ownership | {' · '.join(own_parts)} |")
    lines.append("")

    # ── Technical Signals ─────────────────────────────────────
    signals = t.get("signals") or []
    price  = t.get("price")
    sma50  = t.get("50dma")
    sma200 = t.get("200dma")
    extra = []
    if sma50 and price:
        diff = (price - sma50) / sma50 * 100
        extra.append(f"50 DMA ${sma50:.2f} | price {'+' if diff > 0 else ''}{diff:.1f}% from MA")
    if sma200 and price:
        diff = (price - sma200) / sma200 * 100
        extra.append(f"200 DMA ${sma200:.2f} | price {'+' if diff > 0 else ''}{diff:.1f}% from MA")
    if signals or extra:
        lines.append("### Technical Signals")
        for s in signals + extra:
            lines.append(f"- {s}")
        lines.append("")

    # ── Analyst Consensus ─────────────────────────────────────
    rating    = (c.get("recommendation") or "—").upper()
    n_ana     = c.get("num_analysts")
    target    = c.get("target_mean")
    upside    = c.get("upside_pct")
    cur_price = c.get("current_price")
    t_low     = c.get("target_low")
    t_high    = c.get("target_high")
    dist      = c.get("distribution") or {}
    recent    = (c.get("recent_changes") or [])[:5]
    lines.append("### Analyst Consensus")
    lines.append(f"- **Consensus:** {rating}{' | ' + str(n_ana) + ' analysts' if n_ana else ''}")
    if target and cur_price:
        up_str = f" → {'+' if upside and upside > 0 else ''}{upside:.1f}% upside" if upside is not None else ""
        lines.append(f"- **Price Target:** ${target:.2f} (current ${cur_price:.2f}{up_str})")
    if t_low and t_high:
        lines.append(f"- **Target Range:** ${t_low:.2f} – ${t_high:.2f}")
    total = dist.get("total", 0)
    if total > 0:
        buys  = dist.get("strong_buy", 0) + dist.get("buy", 0)
        holds = dist.get("hold", 0)
        sells = dist.get("sell", 0) + dist.get("strong_sell", 0)
        lines.append(f"- **Analyst Split:** {buys} Buy · {holds} Hold · {sells} Sell")
    if recent:
        lines.append("- **Recent upgrades/downgrades:**")
        for r in recent:
            firm   = r.get("firm", "")
            action = r.get("action", "")
            frm    = r.get("from_grade", "")
            to     = r.get("to_grade", "")
            date   = r.get("date", "")
            arrow  = "↑" if action == "up" else "↓" if action == "down" else "→"
            change = f"{frm} → {to}" if frm and frm not in ("nan","None","") else to
            lines.append(f"  - {date}: **{firm}** {arrow} {change}")
    lines.append("")

    # ── Earnings ──────────────────────────────────────────────
    next_earn = e.get("next_earnings")
    eps_hist  = e.get("eps_history") or []
    if next_earn or eps_hist:
        lines.append("### Earnings")
        if next_earn:
            lines.append(f"- **Next earnings:** {next_earn}")
        if eps_hist:
            lines.append("- **Recent EPS (est vs actual):**")
            for q in eps_hist[-4:]:
                est  = q.get("eps_estimate")
                act  = q.get("eps_actual")
                surp = q.get("surprise_pct")
                dt   = q.get("date", "")
                beat = " ✓" if surp and surp > 0 else " ✗" if surp and surp < 0 else ""
                parts = [dt]
                if est is not None: parts.append(f"est ${est:.2f}")
                if act is not None: parts.append(f"act ${act:.2f}")
                if surp is not None: parts.append(f"({'+' if surp > 0 else ''}{surp:.1f}%{beat})")
                lines.append(f"  - {' · '.join(parts)}")
        lines.append("")

    # ── Recent News ───────────────────────────────────────────
    headlines = (n.get("headlines") or [])[:5]
    if headlines:
        lines.append("### Recent News")
        for i, h in enumerate(headlines, 1):
            title = h.get("title", "")
            pub   = h.get("publisher", "")
            pub_str = f" *({pub})*" if pub else ""
            lines.append(f"{i}. {title}{pub_str}")
        lines.append("")

    return "\n".join(lines)


def _detect_analysis_ticker(text: str, stock_cache: list) -> str | None:
    """Return a ticker if the message is a single-stock analysis request."""
    import re
    text_lower = text.lower().strip()

    # Exclude multi-stock / market-wide queries
    if any(w in text_lower for w in [" vs ", " versus ", "compare ", "comparison",
                                      "find me", "screen", "best stocks", "top stocks",
                                      "market overview", "macro ", "which sector"]):
        return None

    ticker_universe = {s.get("symbol", "") for s in stock_cache}
    found = re.findall(r'\b([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b', text.upper())
    valid = [t for t in found if t in ticker_universe]

    if not valid:
        return None

    # Short query — bare ticker or very brief ("NVDA?", "tell me TSLA")
    if len(text.strip().split()) <= 3:
        return valid[0]

    # Broader intent phrases — natural language people actually use
    analysis_words = [
        "analyze", "analyse", "analysis", "tell me about", "what do you think",
        "should i buy", "should i sell", "overview", "research", "deep dive",
        "breakdown", "report on", "thoughts on", "opinion on", "assess",
        "evaluate", "review", "look at", "what about", "give me",
        "how is", "how's", "how about", "what's happening with",
        "worth buying", "worth it", "good buy", "bad buy", "invest in",
        "bullish on", "bearish on", "long on", "short on",
    ]
    return valid[0] if any(w in text_lower for w in analysis_words) else None


def _detect_any_ticker(text: str, stock_cache: list) -> str | None:
    """Return the first valid ticker found in text, regardless of intent."""
    import re
    ticker_universe = {s.get("symbol", "") for s in stock_cache}
    found = re.findall(r'\b([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b', text.upper())
    valid = [t for t in found if t in ticker_universe]
    return valid[0] if valid else None


def _is_followup(question: str) -> bool:
    """True when the user is asking a focused follow-up, not requesting a full analysis."""
    q = question.lower().strip()
    followup_words = [
        "what about", "how about", "and the", "what's the", "whats the",
        "tell me more", "more about", "explain", "why is", "why did",
        "what does", "what do", "what happened", "any news", "recent news",
        "what's happening", "whats happening", "debt", "margins", "growth",
        "revenue", "earnings", "dividend", "options", "insider",
        "compared to", "vs ", "versus", "better than", "worse than",
        "too expensive", "cheap", "overvalued", "undervalued", "risky",
    ]
    # Short direct questions are almost always follow-ups
    words = q.split()
    if len(words) <= 5 and not any(w in q for w in ["analyze", "analysis", "overview", "research"]):
        return True
    return any(w in q for w in followup_words)


def run_debate_analysis(ticker: str, stock_cache: list, indices_cache: dict, api_key: str,
                        user_question: str = "", stream: bool = False, skill: str = "",
                        message_history: list = None):
    """Gather data then write an opinionated narrative. Returns dict or generator when stream=True."""
    ticker = ticker.upper().strip()

    from screener import compute_swing_setup as _swing
    from concurrent.futures import ThreadPoolExecutor
    raw_stock = next((s for s in stock_cache if s.get("symbol") == ticker), None)

    # In-memory lookups are instant; network calls (news, consensus, earnings) run in parallel
    f  = tool_get_stock_fundamentals(ticker, stock_cache)
    t  = tool_get_technical_signals(ticker, stock_cache)
    pe = tool_get_peer_comparison(ticker, stock_cache)
    sw = _swing(raw_stock) if raw_stock else None

    with ThreadPoolExecutor(max_workers=3) as ex:
        fn = ex.submit(tool_get_recent_news, ticker, 5)
        fc = ex.submit(tool_get_analyst_consensus, ticker, stock_cache)
        fe = ex.submit(tool_get_earnings_info, ticker)
        n  = fn.result()
        c  = fc.result()
        e  = fe.result()

    def pct(v):  return f"{v*100:.1f}%" if v is not None else "—"
    def fmt(v, d=1): return f"{v:.{d}f}" if v is not None else "—"

    name   = f.get("name") or ticker
    price  = f.get("price")
    chg    = f.get("change_pct")
    sector = f.get("sector") or ""

    # Compact data brief — token-efficient, no raw JSON
    brief_lines = []
    if user_question:
        brief_lines += [f"USER QUESTION: {user_question}", ""]
    brief_lines += [
        f"Stock: {ticker} ({name}) | Sector: {sector} | Industry: {f.get('industry') or ''}",
        f"Price: ${fmt(price, 2)} ({'+' if chg and chg>0 else ''}{fmt(chg, 2)}%)",
        "",
        "VALUATION",
        f"  P/E (TTM/Fwd): {fmt(f.get('pe_trailing'))} / {fmt(f.get('pe_forward'))}",
        f"  P/B: {fmt(f.get('pb'))} | PEG: {fmt(f.get('peg'))} | EV/EBITDA: {fmt(f.get('ev_ebitda'))}",
        f"  Market Cap: ${fmt(f.get('market_cap_b'), 1)}B",
        "",
        "GROWTH & PROFITABILITY",
        f"  Revenue Growth: {pct(f.get('revenue_growth'))} | EPS Growth: {pct(f.get('earnings_growth'))}",
        f"  Gross/Op/Net Margin: {pct(f.get('gross_margin'))} / {pct(f.get('operating_margin'))} / {pct(f.get('profit_margin'))}",
        f"  ROE: {pct(f.get('roe'))} | D/E: {fmt(f.get('debt_equity'))}",
        "",
        "TECHNICALS",
        f"  RSI-14: {fmt(t.get('rsi14'))} | 50DMA: ${fmt(t.get('50dma'), 2)} | 200DMA: ${fmt(t.get('200dma'), 2)}",
        f"  Signals: {'; '.join(t.get('signals') or ['—'])}",
    ]
    if sw:
        brief_lines += ["", f"SWING SETUP: {sw.get('type','')} | Entry ${fmt(sw.get('entry'),2)} | Stop ${fmt(sw.get('stop'),2)} | Target ${fmt(sw.get('target'),2)} | R:R {sw.get('rr')}x"]

    dist = c.get("distribution") or {}
    total = dist.get("total", 0)
    buy_str = f"{dist.get('strong_buy',0)+dist.get('buy',0)} Buy / {dist.get('hold',0)} Hold / {dist.get('sell',0)+dist.get('strong_sell',0)} Sell ({total} analysts)" if total else "—"
    brief_lines += [
        "",
        "ANALYST CONSENSUS",
        f"  Rating: {(c.get('recommendation') or '—').upper()} | Target: ${fmt(c.get('target_mean'), 2)} (upside: {fmt(c.get('upside_pct'), 1)}%)",
        f"  Distribution: {buy_str}",
    ]
    recent_grades = (c.get("recent_changes") or [])[:3]
    for r in recent_grades:
        arrow = "↑" if r.get("action") == "up" else "↓" if r.get("action") == "down" else "→"
        brief_lines.append(f"  {r.get('date','')} {r.get('firm','')} {arrow} {r.get('from_grade','')} → {r.get('to_grade','')}")

    eps_hist = (e.get("eps_history") or [])[-4:]
    if eps_hist or e.get("next_earnings"):
        brief_lines += ["", "EARNINGS"]
        if e.get("next_earnings"):
            brief_lines.append(f"  Next: {e['next_earnings']}")
        for q in eps_hist:
            surp = q.get("surprise_pct")
            brief_lines.append(f"  {q.get('date','')} est ${fmt(q.get('eps_estimate'),2)} act ${fmt(q.get('eps_actual'),2)} ({'+' if surp and surp>0 else ''}{fmt(surp,1)}%)")

    peers = (pe.get("peers") or [])[:4]
    if peers:
        brief_lines += ["", "PEERS (same industry, by market cap)"]
        for p in peers:
            brief_lines.append(f"  {p.get('ticker')} P/E {fmt(p.get('pe'))} RevGrowth {pct(p.get('rev_growth'))} Margin {pct(p.get('profit_margin'))}")

    headlines = (n.get("headlines") or [])[:4]
    if headlines:
        brief_lines += ["", "RECENT NEWS"]
        for h in headlines:
            brief_lines.append(f"  - {h.get('title','')}")

    data_brief = "\n".join(brief_lines)

    chg_sign = "+" if chg and chg > 0 else ""
    header = f"## {ticker} — {name}\n**${fmt(price, 2)}** ({chg_sign}{fmt(chg, 2)}%) · {sector}\n"

    # ── Skill-specific prompts ────────────────────────────────────────────────
    if skill == "timing":
        prompt = f"""You are a technical analyst. Answer only: what are the best entry and exit levels for {ticker} right now?

DATA:
{data_brief}

{header}

Output EXACTLY this. No preamble.

**[BUY / WAIT / AVOID]** — *One sentence on timing.*

### Entry Zone
- **Support**: $[level] — why this level matters
- **Trigger**: what price action or condition confirms entry
- **Risk/Reward**: entry $[x] → target $[y] → stop $[z] = [ratio]:1

### Exit / Target
- **Target 1**: $[level] — reason
- **Target 2**: $[level] — reason (stretch)
- **Stop-Loss**: $[level] — the level that invalidates the setup

### Technical Read
- **Trend**: [up/down/sideways] — [evidence from data]
- **Momentum**: [RSI / MACD signal]
- **Key level to watch**: $[price]

Rules: specific prices only, no vague ranges, use DATA numbers."""

    elif skill == "swing":
        prompt = f"""You are a swing trader. Give a concrete 2–4 week swing trade setup for {ticker}.

DATA:
{data_brief}

{header}

Output EXACTLY this. No preamble.

**[LONG / SHORT / NO SETUP]** — *One sentence: why this is a swing trade right now.*

### Setup
| | Price |
|---|---|
| Entry | $[price] |
| Target | $[price] |
| Stop | $[price] |
| R/R | [x]:1 |
| Timeframe | [2–4 weeks] |

### Why Now
- **Catalyst**: [specific trigger — earnings, breakout, pattern]
- **Technical**: [key signal from data]
- **Risk**: [main thing that kills this trade]

### Management
- Enter: [condition — e.g. "on break above $X with volume"]
- Exit: [condition — e.g. "take 50% at $Y, trail rest"]

Rules: give exact prices, be specific about entry condition, one clear reason per bullet."""

    elif skill == "earnings":
        prompt = f"""You are an earnings analyst. Preview the next earnings for {ticker}.

DATA:
{data_brief}

{header}

Output EXACTLY this. No preamble.

### Next Earnings
- **Date**: [date or TBD]
- **EPS Estimate**: $[value]
- **Revenue Estimate**: $[value]

### Recent Beat Rate
| Quarter | Est | Actual | Surprise |
|---|---|---|---|
| [date] | $[est] | $[actual] | [+/-]% |
| [date] | $[est] | $[actual] | [+/-]% |
| [date] | $[est] | $[actual] | [+/-]% |

### What to Watch
- **[metric 1]**: why the market is focused on this number
- **[metric 2]**: the guidance or segment that will move the stock
- **[risk]**: what could cause a sell-off even on a beat

### Historical Reaction
*One sentence: how has this stock typically moved the day after earnings.*

Rules: use only DATA numbers, be specific about what matters this quarter."""

    elif skill == "compare":
        prompt = f"""You are a sector analyst. Compare {ticker} against its closest peers.

DATA:
{data_brief}

{header}

Output EXACTLY this. No preamble.

### Peer Comparison
| Ticker | P/E | Fwd P/E | Rev Growth | Gross Margin | Net Margin |
|---|---|---|---|---|---|
| **{ticker}** | [value] | [value] | [value]% | [value]% | [value]% |
| [peer] | [value] | [value] | [value]% | [value]% | [value]% |
| [peer] | [value] | [value] | [value]% | [value]% | [value]% |
| [peer] | [value] | [value] | [value]% | [value]% | [value]% |

### Where {ticker} Wins
- **[metric]**: [specific number vs peers]
- **[metric]**: [specific number vs peers]

### Where {ticker} Loses
- **[metric]**: [specific number vs peers]
- **[metric]**: [specific number vs peers]

### Verdict
**[BEST IN CLASS / MID-PACK / LAGGARD]** — One sentence: buy {ticker} over peers or not, and why.

Rules: fill every cell with real numbers from DATA, be direct about the ranking."""

    else:
        # Default: fundamentals / general "is this a good company" question
        q_line = f"\nUser asked: {user_question}" if user_question else ""
        prompt = f"""You are a sharp analyst. Is {ticker} worth owning?{q_line}

DATA:
{data_brief}

{header}

Output EXACTLY this. No preamble.

**[BULLISH / BEARISH / NEUTRAL]** — *One sentence: the single most important thing about this stock right now.*

### Verdict
2–3 sentences. What does this company do, is the business working, and is the valuation fair. Hard numbers only.

### Bull Case
- **[metric]**: specific number + why it matters
- **[metric]**: specific number + why it matters
- **[metric]**: specific number + why it matters

### Bear Case
- **[risk]**: specific number + why it matters
- **[risk]**: specific number + why it matters

### Key Numbers
| Metric | Value |
|---|---|
| P/E (TTM / Fwd) | [value] / [value] |
| Revenue Growth | [value]% |
| Gross Margin | [value]% |
| EPS Growth | [value]% |
| Analyst Target | $[value] ([upside]% upside) |
| 52W Position | [value]% of range |

### What to Watch
*One sentence: the specific number or event that changes this view.*

Rules: be decisive, real numbers only, no hedging."""

    _tools_used = [
        "get_stock_fundamentals", "get_technical_signals", "get_recent_news",
        "get_analyst_consensus", "get_peer_comparison", "get_earnings_info",
    ]

    # Follow-up questions skip the full template — answer directly with data context
    is_followup = bool(skill == "" and user_question and _is_followup(user_question)
                       and message_history)
    if is_followup:
        prompt = f"""You are a sharp financial analyst in a conversation about {ticker}.
The user has already seen a full analysis. They are asking a follow-up question.

STOCK DATA:
{data_brief}

Answer ONLY the question asked. Be direct, use specific numbers from the data, 2–5 sentences max.
No headers, no template, no preamble. Just answer the question.

Question: {user_question}"""

    # Build message list: include conversation history so the AI remembers context
    history_msgs = []
    if message_history:
        for m in message_history[:-1]:  # exclude the current question (already in prompt)
            role    = m.get("role")
            content = (m.get("content") or "").strip()
            if content and role in ("user", "assistant"):
                history_msgs.append({"role": role, "content": content})

    msgs = history_msgs + [{"role": "user", "content": prompt}]
    max_tok = 800 if is_followup else 1800

    if stream:
        def _gen():
            try:
                for chunk in _groq_stream(api_key, msgs, temperature=0.4, max_tokens=max_tok):
                    yield {"type": "chunk", "text": chunk}
            except Exception as ex:
                yield {"type": "chunk", "text": f"\n\n*Analysis unavailable: {ex}*"}
            yield {"type": "done", "tools_used": _tools_used, "tickers": [ticker]}
        return _gen()

    try:
        reply = _groq_post(api_key, msgs, temperature=0.4, max_tokens=max_tok)
    except Exception as ex:
        reply = f"*Analysis unavailable: {ex}*"
    return {"reply": reply, "tools_used": _tools_used, "tickers": [ticker]}


# ── Entry points ──────────────────────────────────────────────────────────────

def run_agent(messages: list, stock_cache: list, indices_cache: dict, api_key: str) -> dict:
    """Called by /api/chat (non-streaming). Returns {"reply": str, "tools_used": [str]}."""
    if not messages:
        return {"reply": "No message provided.", "tools_used": []}
    try:
        reply, tools_used = _run_claude_agent(messages, stock_cache, indices_cache, api_key)
        return {"reply": reply, "tools_used": tools_used}
    except Exception as ex:
        return {"reply": f"Error: {ex}", "tools_used": []}


def run_agent_stream(messages: list, stock_cache: list, indices_cache: dict, api_key: str,
                     skill: str = ""):
    """
    Streaming entry point. Yields:
      {"type": "chunk", "text": str}  — one or more times
      {"type": "done",  "tools_used": list, "tickers": list}  — once, last
    """
    if not messages:
        yield {"type": "chunk", "text": "No message provided."}
        yield {"type": "done", "tools_used": [], "tickers": []}
        return
    try:
        yield from _run_claude_stream(messages, stock_cache, indices_cache, api_key)
    except Exception as ex:
        yield {"type": "chunk", "text": f"Error: {ex}"}
        yield {"type": "done", "tools_used": [], "tickers": []}
