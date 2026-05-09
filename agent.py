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


# ── PYDANTIC-AI AGENT ─────────────────────────────────────────────────────────

from pydantic_ai import Agent, RunContext
from pydantic_ai.models.gemini import GeminiModel


@dataclass
class FinBotDeps:
    stock_cache: list
    indices_cache: dict


SYSTEM_PROMPT = """You are FinBot — a sharp financial research agent embedded in a stock screener.

You have tools to look up fundamentals, technical signals, news, peer comparisons, earnings history, insider activity, analyst ratings, dividends, stock screening, options chains, and macro indicators (rates, VIX, gold, oil, GDP, inflation).

Rules:
- ALWAYS call tools to get real data before answering. Never invent numbers.
- For "analyse X": call get_stock_fundamentals + get_technical_signals + get_recent_news + get_peer_comparison + get_analyst_consensus minimum.
- For "compare X vs Y": call compare_stocks, then get_stock_fundamentals for each if needed.
- For "find me stocks" / screening: call screen_stocks with appropriate sector/strategy.
- For "what's happening in the market": call get_market_overview.
- For competitor questions: call get_peer_comparison.
- For options / derivatives questions: call get_options_chain.
- For macro / economy / rates / inflation questions: call get_macro_indicators.
- Format with markdown: **bold** key numbers, use bullet lists, clear section headers.
- Give a clear verdict: bullish / bearish / neutral with the key reasons.
- Be concise but thorough. Aim for 200-400 words for full analysis."""


finbot: Agent[FinBotDeps, str] = Agent(
    system_prompt=SYSTEM_PROMPT,
    deps_type=FinBotDeps,
)


@finbot.system_prompt
def _add_date() -> str:
    return f"Today: {datetime.utcnow().strftime('%Y-%m-%d')}."


# ── Tools that need stock_cache / indices_cache (use RunContext) ──────────────

@finbot.tool
def get_stock_fundamentals(ctx: RunContext[FinBotDeps], ticker: str) -> dict:
    """Get fundamental financial data for a stock: valuation ratios (P/E, P/B, EV/EBITDA), growth metrics, margins, moving averages, beta, analyst target."""
    return tool_get_stock_fundamentals(ticker, ctx.deps.stock_cache)


@finbot.tool
def get_technical_signals(ctx: RunContext[FinBotDeps], ticker: str) -> dict:
    """Get technical analysis for a stock: RSI, 50/200-day moving average position, golden/death cross, trend signals."""
    return tool_get_technical_signals(ticker, ctx.deps.stock_cache)


@finbot.tool
def get_peer_comparison(ctx: RunContext[FinBotDeps], ticker: str) -> dict:
    """Find industry peers for a stock and compare P/E, growth, margins, and returns side by side."""
    return tool_get_peer_comparison(ticker, ctx.deps.stock_cache)


@finbot.tool
def screen_stocks(ctx: RunContext[FinBotDeps],
                  sector: str = "",
                  strategy: str = "",
                  limit: int = 10) -> dict:
    """Screen stocks by sector and/or investment strategy to find top candidates. Strategies: value, growth, momentum, dividend, quality, deepvalue."""
    return tool_screen_stocks(
        ctx.deps.stock_cache,
        sector=sector or None,
        strategy=strategy or None,
        limit=limit,
    )


@finbot.tool
def get_market_overview(ctx: RunContext[FinBotDeps]) -> dict:
    """Get current market indices (S&P 500, NASDAQ, DOW, VIX) and sector performance. Use for macro or market-wide questions."""
    return tool_get_market_overview(ctx.deps.indices_cache, ctx.deps.stock_cache)


@finbot.tool
def compare_stocks(ctx: RunContext[FinBotDeps], tickers: list[str]) -> dict:
    """Side-by-side comparison of multiple stocks on valuation, growth, margins, and analyst ratings (max 6 tickers)."""
    return tool_compare_stocks(tickers, ctx.deps.stock_cache)


@finbot.tool
def get_analyst_consensus(ctx: RunContext[FinBotDeps], ticker: str) -> dict:
    """Get analyst price target, upside/downside potential, consensus rating, and recent rating changes from brokerages."""
    return tool_get_analyst_consensus(ticker, ctx.deps.stock_cache)


@finbot.tool
def get_watchlist_analysis(ctx: RunContext[FinBotDeps], tickers: list[str]) -> dict:
    """Analyse a list of tickers — scores, ratings, best strategy fit, and which look strongest."""
    return tool_get_watchlist_analysis(tickers, ctx.deps.stock_cache)


# ── Tools that don't need deps (tool_plain) ───────────────────────────────────

@finbot.tool_plain
def get_recent_news(ticker: str, count: int = 5) -> dict:
    """Get recent news headlines for a stock or the market. Use SPY for general market news."""
    return tool_get_recent_news(ticker, count)


@finbot.tool_plain
def get_earnings_info(ticker: str) -> dict:
    """Get next earnings date and last 4 quarters of EPS estimates vs actuals (beat/miss history)."""
    return tool_get_earnings_info(ticker)


@finbot.tool_plain
def get_insider_activity(ticker: str) -> dict:
    """Get recent insider buying and selling transactions (names, titles, share counts, values)."""
    return tool_get_insider_activity(ticker)


@finbot.tool_plain
def get_dividend_info(ticker: str) -> dict:
    """Get dividend yield, annual dividend rate, payout ratio, and recent payment history."""
    return tool_get_dividend_info(ticker)


@finbot.tool_plain
def get_options_chain(ticker: str) -> dict:
    """Get the nearest-expiry options chain (calls + puts) with strikes, bid/ask, volume, open interest, implied volatility, and put/call ratio."""
    return tool_get_options_chain(ticker)


@finbot.tool_plain
def get_macro_indicators() -> dict:
    """Get key macro indicators: 10Y/2Y treasury yields, VIX, USD index, gold, oil, bitcoin, plus US GDP growth, inflation, and unemployment."""
    return tool_get_macro_indicators()


# ── Entry point ───────────────────────────────────────────────────────────────

def run_agent(messages: list, stock_cache: list, indices_cache: dict, api_key: str) -> dict:
    """
    Called by /api/chat. Converts the chat history to PydanticAI message format,
    runs the agent, and returns {"reply": str, "tools_used": [str]}.
    """
    from pydantic_ai.messages import (
        ModelRequest, ModelResponse,
        UserPromptPart, TextPart, ToolCallPart,
    )
    from pydantic_ai.settings import ModelSettings

    if not messages:
        return {"reply": "No message provided.", "tools_used": []}

    last_msg = (messages[-1].get("content") or "").strip()
    if not last_msg:
        return {"reply": "No message provided.", "tools_used": []}

    # Convert prior turns to PydanticAI message history
    history = []
    for m in messages[:-1]:
        role    = m.get("role")
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "user":
            history.append(ModelRequest(parts=[UserPromptPart(content=content)]))
        elif role == "assistant":
            history.append(ModelResponse(parts=[TextPart(content=content)]))

    model = GeminiModel("gemini-2.5-flash", api_key=api_key)
    deps  = FinBotDeps(stock_cache=stock_cache, indices_cache=indices_cache)

    result = finbot.run_sync(
        last_msg,
        model=model,
        deps=deps,
        message_history=history,
        model_settings=ModelSettings(temperature=0.3, max_tokens=2048),
    )

    tools_used = [
        part.tool_name
        for msg in result.all_messages()
        for part in getattr(msg, "parts", [])
        if isinstance(part, ToolCallPart)
    ]

    return {"reply": result.output, "tools_used": tools_used}
