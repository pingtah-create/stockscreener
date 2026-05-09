"""
FinBot agent — Gemini 2.5 Flash with function-calling tools.
Each tool wraps existing data sources (yfinance, stock cache, indices cache).
run_agent() is the main entry point called by /api/chat in app.py.
"""
import json
import yfinance as yf
from datetime import datetime


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
        "50dma": data.get("fiftyDayAverage"),
        "200dma": data.get("twoHundredDayAverage"),
        "beta": data.get("beta"),
        "analyst_target": data.get("targetMeanPrice"),
        "analyst_rating": data.get("recommendationKey"),
        "short_ratio": data.get("shortRatio"),
        "short_float_pct": data.get("shortPercentOfFloat"),
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
    recent = []
    try:
        recs = yf.Ticker(ticker).recommendations
        if recs is not None and not recs.empty:
            for _, r in recs.tail(5).iterrows():
                recent.append({
                    "date":       str(r.name.date() if hasattr(r.name, "date") else r.name),
                    "firm":       str(r.get("Firm") or ""),
                    "to_grade":   str(r.get("To Grade") or ""),
                    "from_grade": str(r.get("From Grade") or ""),
                    "action":     str(r.get("Action") or ""),
                })
    except Exception:
        pass
    return {"ticker": ticker, **base, "recent_changes": recent}


def tool_get_watchlist_analysis(tickers: list, stock_cache: list) -> dict:
    """Analyse a user's watchlist: score each holding, flag best/worst."""
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


# ── GEMINI TOOL DECLARATIONS ─────────────────────────────────────────────────

TOOL_DEFINITIONS = [{
    "functionDeclarations": [
        {
            "name": "get_stock_fundamentals",
            "description": "Get fundamental financial data for a stock: valuation ratios (P/E, P/B, EV/EBITDA), growth metrics, margins, moving averages, beta, analyst target.",
            "parameters": {"type": "OBJECT", "properties": {
                "ticker": {"type": "STRING", "description": "Stock ticker (e.g. NVDA, AAPL, 2330.TW)"}
            }, "required": ["ticker"]},
        },
        {
            "name": "get_technical_signals",
            "description": "Get technical analysis for a stock: RSI, 50/200-day moving average position, golden/death cross, trend signals.",
            "parameters": {"type": "OBJECT", "properties": {
                "ticker": {"type": "STRING", "description": "Stock ticker symbol"}
            }, "required": ["ticker"]},
        },
        {
            "name": "get_recent_news",
            "description": "Get recent news headlines for a stock or the market (use SPY for general market news).",
            "parameters": {"type": "OBJECT", "properties": {
                "ticker": {"type": "STRING", "description": "Ticker symbol (e.g. NVDA) or SPY for market news"},
                "count":  {"type": "INTEGER", "description": "Number of headlines (default 5)"},
            }, "required": ["ticker"]},
        },
        {
            "name": "get_peer_comparison",
            "description": "Find industry peers for a stock and compare P/E, growth, margins, and returns side by side.",
            "parameters": {"type": "OBJECT", "properties": {
                "ticker": {"type": "STRING", "description": "Stock ticker to find competitors for"}
            }, "required": ["ticker"]},
        },
        {
            "name": "get_earnings_info",
            "description": "Get next earnings date and last 4 quarters of EPS estimates vs actuals (beat/miss history).",
            "parameters": {"type": "OBJECT", "properties": {
                "ticker": {"type": "STRING", "description": "Stock ticker symbol"}
            }, "required": ["ticker"]},
        },
        {
            "name": "get_insider_activity",
            "description": "Get recent insider buying and selling transactions (names, titles, share counts, values).",
            "parameters": {"type": "OBJECT", "properties": {
                "ticker": {"type": "STRING", "description": "Stock ticker symbol"}
            }, "required": ["ticker"]},
        },
        {
            "name": "get_dividend_info",
            "description": "Get dividend yield, annual dividend rate, payout ratio, and recent payment history.",
            "parameters": {"type": "OBJECT", "properties": {
                "ticker": {"type": "STRING", "description": "Stock ticker symbol"}
            }, "required": ["ticker"]},
        },
        {
            "name": "screen_stocks",
            "description": "Screen stocks by sector and/or investment strategy to find top candidates. Use for 'find me good value stocks' or 'best momentum stocks in tech'.",
            "parameters": {"type": "OBJECT", "properties": {
                "sector":   {"type": "STRING", "description": "Sector filter (e.g. Technology, Healthcare, Financial Services). Omit for all sectors."},
                "strategy": {"type": "STRING", "description": "Rank by strategy score: value, growth, momentum, dividend, quality, deepvalue"},
                "limit":    {"type": "INTEGER", "description": "Max results to return (default 10)"},
            }, "required": []},
        },
        {
            "name": "get_market_overview",
            "description": "Get current market indices (S&P 500, NASDAQ, DOW, VIX) and sector performance. Use for macro / market-wide questions.",
            "parameters": {"type": "OBJECT", "properties": {}},
        },
        {
            "name": "compare_stocks",
            "description": "Side-by-side comparison of multiple stocks on valuation, growth, margins, and analyst ratings.",
            "parameters": {"type": "OBJECT", "properties": {
                "tickers": {"type": "ARRAY", "items": {"type": "STRING"},
                            "description": "List of tickers to compare (max 6)"},
            }, "required": ["tickers"]},
        },
        {
            "name": "get_analyst_consensus",
            "description": "Get analyst price target, upside/downside potential, consensus rating, and recent rating changes from brokerages.",
            "parameters": {"type": "OBJECT", "properties": {
                "ticker": {"type": "STRING", "description": "Stock ticker symbol"}
            }, "required": ["ticker"]},
        },
        {
            "name": "get_watchlist_analysis",
            "description": "Analyse the user's watchlist holdings — scores, ratings, best strategy fit, and which look strongest.",
            "parameters": {"type": "OBJECT", "properties": {
                "tickers": {"type": "ARRAY", "items": {"type": "STRING"},
                            "description": "List of tickers from the user's watchlist"},
            }, "required": ["tickers"]},
        },
    ]
}]


# ── TOOL DISPATCHER ───────────────────────────────────────────────────────────

def execute_tool(name: str, args: dict, stock_cache: list, indices_cache: dict) -> dict:
    try:
        if name == "get_stock_fundamentals":
            return tool_get_stock_fundamentals(args["ticker"], stock_cache)
        if name == "get_technical_signals":
            return tool_get_technical_signals(args["ticker"], stock_cache)
        if name == "get_recent_news":
            return tool_get_recent_news(args.get("ticker", "SPY"), int(args.get("count", 5)))
        if name == "get_peer_comparison":
            return tool_get_peer_comparison(args["ticker"], stock_cache)
        if name == "get_earnings_info":
            return tool_get_earnings_info(args["ticker"])
        if name == "get_insider_activity":
            return tool_get_insider_activity(args["ticker"])
        if name == "get_dividend_info":
            return tool_get_dividend_info(args["ticker"])
        if name == "screen_stocks":
            return tool_screen_stocks(stock_cache,
                                      sector=args.get("sector"),
                                      strategy=args.get("strategy"),
                                      limit=int(args.get("limit", 10)))
        if name == "get_market_overview":
            return tool_get_market_overview(indices_cache, stock_cache)
        if name == "compare_stocks":
            return tool_compare_stocks(args.get("tickers", []), stock_cache)
        if name == "get_analyst_consensus":
            return tool_get_analyst_consensus(args["ticker"], stock_cache)
        if name == "get_watchlist_analysis":
            return tool_get_watchlist_analysis(args.get("tickers", []), stock_cache)
        return {"error": f"Unknown tool: {name}"}
    except Exception as e:
        return {"error": str(e)}


# ── MAIN AGENT LOOP ───────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are FinBot — a sharp financial research agent embedded in a stock screener.

You have tools to look up fundamentals, technical signals, news, peer comparisons, earnings history, insider activity, analyst ratings, dividends, stock screening, and market overview.

Rules:
- ALWAYS call tools to get real data before answering. Never invent numbers.
- For "analyse X": call get_stock_fundamentals + get_technical_signals + get_recent_news + get_peer_comparison + get_analyst_consensus minimum.
- For "compare X vs Y": call compare_stocks, then get_stock_fundamentals for each if needed.
- For "find me stocks" / screening: call screen_stocks with appropriate sector/strategy.
- For "what's happening in the market": call get_market_overview.
- For competitor questions: call get_peer_comparison.
- Format with markdown: **bold** key numbers, use bullet lists, clear section headers.
- Give a clear verdict: bullish / bearish / neutral with the key reasons.
- Be concise but thorough. Aim for 200-400 words for full analysis."""


def run_agent(messages: list, stock_cache: list, indices_cache: dict, api_key: str) -> dict:
    """
    Agentic loop: send messages to Gemini with function-calling tools,
    execute any tool calls, feed results back, repeat until final text.
    Returns {"reply": str, "tools_used": [str]}.
    """
    import requests as _req

    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"gemini-2.5-flash:generateContent?key={api_key}")

    # Build conversation history
    contents = []
    for m in messages:
        role = "user" if m.get("role") == "user" else "model"
        text = (m.get("content") or "").strip()
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})

    if not contents:
        return {"reply": "No message provided.", "tools_used": []}

    system = SYSTEM_PROMPT + f"\n\nToday: {datetime.utcnow().strftime('%Y-%m-%d')}."
    tools_used = []

    for _ in range(8):  # max tool-call iterations
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": contents,
            "tools": TOOL_DEFINITIONS,
            "generationConfig": {"temperature": 0.3, "maxOutputTokens": 2048},
        }
        r = _req.post(url, json=payload, timeout=45)
        r.raise_for_status()

        candidate = r.json().get("candidates", [{}])[0]
        parts     = candidate.get("content", {}).get("parts", [])
        fn_calls  = [p["functionCall"] for p in parts if "functionCall" in p]
        text_parts = [p["text"] for p in parts if "text" in p]

        if not fn_calls:
            return {"reply": "\n".join(text_parts).strip(), "tools_used": tools_used}

        # Execute all tool calls in this round
        tool_response_parts = []
        for fc in fn_calls:
            name   = fc["name"]
            args   = fc.get("args", {})
            tools_used.append(name)
            result = execute_tool(name, args, stock_cache, indices_cache)
            tool_response_parts.append({
                "functionResponse": {
                    "name": name,
                    "response": {"result": json.dumps(result, default=str)},
                }
            })

        # Append model's function-call turn + tool results
        contents.append({"role": "model", "parts": [{"functionCall": fc} for fc in fn_calls]})
        contents.append({"role": "user",  "parts": tool_response_parts})

    return {
        "reply": "I gathered the data but hit the processing limit. Try a more specific question.",
        "tools_used": tools_used,
    }
