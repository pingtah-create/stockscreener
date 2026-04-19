"""
Stock data fetcher and screener logic.
Fetches from Yahoo Finance via yfinance, caches results, applies filters.
"""
import json
import os
import time
import threading
from datetime import datetime, timedelta
from pathlib import Path

import yfinance as yf

CACHE_DIR = Path("cache")
CACHE_DIR.mkdir(exist_ok=True)
CACHE_TTL_HOURS = 24

# Fields we care about from yfinance .info
FIELDS = [
    "symbol", "shortName", "longName", "sector", "industry",
    "marketCap", "currentPrice", "previousClose",
    "trailingPE", "forwardPE", "priceToBook", "pegRatio",
    "enterpriseToEbitda", "enterpriseValue",
    "revenueGrowth", "earningsGrowth", "earningsQuarterlyGrowth",
    "returnOnEquity", "returnOnAssets", "returnOnCapital",
    "debtToEquity", "currentRatio", "quickRatio",
    "operatingMargins", "grossMargins", "profitMargins", "ebitdaMargins",
    "dividendYield", "dividendRate", "payoutRatio",
    "fiftyTwoWeekHigh", "fiftyTwoWeekLow",
    "fiftyDayAverage", "twoHundredDayAverage",
    "regularMarketChangePercent",
    "trailingEps", "forwardEps",
    "totalRevenue", "freeCashflow", "operatingCashflow",
    "beta", "sharesOutstanding", "floatShares",
    "heldPercentInstitutions", "heldPercentInsiders",
    "recommendationKey", "targetMeanPrice",
]

# Investment thesis presets
PRESETS = {
    "value": {
        "name": "Value Investing",
        "icon": "💎",
        "description": "Find undervalued companies trading below intrinsic value. Low P/E, low P/B, low EV/EBITDA.",
        "thesis": "Buy good businesses at cheap prices. The market overreacts to short-term news, creating opportunities to buy quality companies at a discount.",
        "filters": {
            "trailingPE": {"max": 20, "label": "P/E Ratio"},
            "priceToBook": {"max": 3, "label": "Price/Book"},
            "enterpriseToEbitda": {"max": 15, "label": "EV/EBITDA"},
        }
    },
    "growth": {
        "name": "Growth Investing",
        "icon": "🚀",
        "description": "Find fast-growing companies with accelerating revenue and earnings.",
        "thesis": "Buy companies growing faster than the market. Revenue and EPS expansion drives long-term stock price appreciation.",
        "filters": {
            "revenueGrowth": {"min": 0.15, "label": "Revenue Growth"},
            "earningsGrowth": {"min": 0.20, "label": "Earnings Growth"},
            "pegRatio": {"max": 2, "label": "PEG Ratio"},
        }
    },
    "momentum": {
        "name": "Momentum",
        "icon": "⚡",
        "description": "Buy stocks in strong uptrends. Price momentum tends to persist.",
        "thesis": "Stocks that have outperformed recently tend to continue outperforming in the near term. Follow the trend until it ends.",
        "filters": {
            "regularMarketChangePercent": {"min": 0, "label": "Price Change %"},
            "above50dma": {"value": True, "label": "Above 50-Day MA"},
            "above200dma": {"value": True, "label": "Above 200-Day MA"},
        }
    },
    "quality": {
        "name": "Quality / GARP",
        "icon": "⭐",
        "description": "Growth at a Reasonable Price. High ROE, strong margins, manageable debt.",
        "thesis": "The best investments combine quality (high returns on capital, strong competitive moats) with reasonable valuations.",
        "filters": {
            "returnOnEquity": {"min": 0.15, "label": "Return on Equity"},
            "debtToEquity": {"max": 1.0, "label": "Debt/Equity"},
            "operatingMargins": {"min": 0.15, "label": "Operating Margin"},
            "trailingPE": {"max": 35, "label": "P/E Ratio"},
        }
    },
    "dividend": {
        "name": "Dividend Income",
        "icon": "💰",
        "description": "Reliable dividend payers with sustainable yields and payout growth.",
        "thesis": "Collect steady income from quality businesses. Dividends compound powerfully over time and signal financial strength.",
        "filters": {
            "dividendYield": {"min": 0.02, "label": "Dividend Yield"},
            "payoutRatio": {"max": 0.75, "label": "Payout Ratio"},
            "returnOnEquity": {"min": 0.10, "label": "Return on Equity"},
        }
    },
    "deepvalue": {
        "name": "Deep Value",
        "icon": "🔍",
        "description": "Contrarian plays — very cheap by all metrics, potential turnarounds.",
        "thesis": "Buy extremely cheap stocks ignored by the market. Deep discounts provide a margin of safety even if the business doesn't fully recover.",
        "filters": {
            "trailingPE": {"max": 12, "label": "P/E Ratio"},
            "priceToBook": {"max": 1.5, "label": "Price/Book"},
            "currentRatio": {"min": 1.5, "label": "Current Ratio"},
        }
    },
}


def _cache_path(ticker: str) -> Path:
    return CACHE_DIR / f"{ticker.upper()}.json"


def _is_cache_fresh(ticker: str) -> bool:
    path = _cache_path(ticker)
    if not path.exists():
        return False
    mtime = datetime.fromtimestamp(path.stat().st_mtime)
    return datetime.now() - mtime < timedelta(hours=CACHE_TTL_HOURS)


def _load_cache(ticker: str) -> dict | None:
    path = _cache_path(ticker)
    if path.exists():
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return None
    return None


def _save_cache(ticker: str, data: dict):
    with open(_cache_path(ticker), "w") as f:
        json.dump(data, f)


def _extract_fields(info: dict, ticker: str) -> dict:
    """Extract and normalise fields from yfinance info dict."""
    data = {"symbol": ticker, "fetched_at": datetime.now().isoformat()}
    for field in FIELDS:
        val = info.get(field)
        if isinstance(val, float) and (val != val):  # NaN check
            val = None
        data[field] = val

    # Compute above/below moving averages
    price = data.get("currentPrice") or data.get("previousClose")
    dma50 = data.get("fiftyDayAverage")
    dma200 = data.get("twoHundredDayAverage")
    data["above50dma"] = bool(price and dma50 and price > dma50)
    data["above200dma"] = bool(price and dma200 and price > dma200)

    # 52-week position (0–100%)
    lo = data.get("fiftyTwoWeekLow")
    hi = data.get("fiftyTwoWeekHigh")
    if price and lo and hi and hi != lo:
        data["fiftyTwoWeekPosition"] = round((price - lo) / (hi - lo) * 100, 1)
    else:
        data["fiftyTwoWeekPosition"] = None

    # Normalize dividendYield — yfinance sometimes returns as % (e.g. 2.5) instead of decimal (0.025)
    dy = data.get("dividendYield")
    if dy and dy > 0.5:
        data["dividendYield"] = round(dy / 100, 6)

    # Analyst upside
    target = data.get("targetMeanPrice")
    if price and target:
        data["analystUpside"] = round((target - price) / price * 100, 1)
    else:
        data["analystUpside"] = None

    return data


def fetch_ticker(ticker: str, force: bool = False) -> dict | None:
    """Fetch one ticker, using cache if fresh."""
    if not force and _is_cache_fresh(ticker):
        return _load_cache(ticker)
    try:
        info = yf.Ticker(ticker).info
        if not info or info.get("trailingPE") is None and info.get("currentPrice") is None:
            cached = _load_cache(ticker)
            return cached
        data = _extract_fields(info, ticker)
        _save_cache(ticker, data)
        return data
    except Exception:
        return _load_cache(ticker)


def fetch_batch(tickers: list[str], force: bool = False,
                progress_cb=None) -> list[dict]:
    """Fetch a list of tickers. Calls progress_cb(done, total) after each."""
    results = []
    total = len(tickers)
    for i, ticker in enumerate(tickers):
        data = fetch_ticker(ticker, force=force)
        if data:
            results.append(data)
        if progress_cb:
            progress_cb(i + 1, total)
        # Small delay to avoid rate limiting
        if force:
            time.sleep(0.05)
    return results


# --- Refresh state ---
_refresh_state = {"running": False, "done": 0, "total": 0, "started_at": None}
_refresh_lock = threading.Lock()


def get_refresh_state() -> dict:
    with _refresh_lock:
        return dict(_refresh_state)


def start_background_refresh(tickers: list[str]):
    """Kick off a background thread to refresh all tickers."""
    with _refresh_lock:
        if _refresh_state["running"]:
            return False
        _refresh_state.update({"running": True, "done": 0,
                                "total": len(tickers),
                                "started_at": datetime.now().isoformat()})

    def _worker():
        def _cb(done, total):
            with _refresh_lock:
                _refresh_state["done"] = done
        fetch_batch(tickers, force=True, progress_cb=_cb)
        with _refresh_lock:
            _refresh_state["running"] = False

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    return True


# --- Screening ---

def _passes_filter(stock: dict, filters: dict) -> bool:
    for field, rule in filters.items():
        val = stock.get(field)

        if field in ("above50dma", "above200dma"):
            if rule.get("value") is True and not val:
                return False
            continue

        if val is None:
            # Skip stocks with missing data for required filters
            continue

        if "min" in rule and val < rule["min"]:
            return False
        if "max" in rule and val > rule["max"]:
            return False
    return True


def screen(all_stocks: list[dict], filters: dict,
           sort_by: str = "marketCap", sort_dir: str = "desc") -> list[dict]:
    """Apply filters and return matching stocks, sorted."""
    results = [s for s in all_stocks if _passes_filter(s, filters)]

    reverse = sort_dir == "desc"
    results.sort(
        key=lambda s: (s.get(sort_by) is not None, s.get(sort_by) or 0),
        reverse=reverse
    )
    return results


def compute_scores(stock: dict) -> dict:
    """Compute 0–100 fit scores for each preset strategy."""

    def n(v, lo, hi):
        """Normalize v to [0,1]: lo=worst, hi=best."""
        if v is None: return 0.0
        return max(0.0, min(1.0, (v - lo) / (hi - lo) if hi != lo else 0.0))

    def ni(v, lo, hi):
        """Inverted normalize: lo=best, hi=worst."""
        if v is None: return 0.0
        return max(0.0, min(1.0, (hi - v) / (hi - lo) if hi != lo else 0.0))

    pe   = stock.get("trailingPE")
    pb   = stock.get("priceToBook")
    ev   = stock.get("enterpriseToEbitda")
    roe  = stock.get("returnOnEquity")
    de   = stock.get("debtToEquity")
    opm  = stock.get("operatingMargins")
    rg   = stock.get("revenueGrowth")
    eg   = stock.get("earningsGrowth")
    peg  = stock.get("pegRatio")
    dy   = stock.get("dividendYield")
    chg  = stock.get("regularMarketChangePercent")
    pr   = stock.get("payoutRatio")
    cr   = stock.get("currentRatio")
    a50  = stock.get("above50dma")
    a200 = stock.get("above200dma")

    # Value: low P/E, low P/B, low EV/EBITDA
    v_pe = ni(pe,  5, 30) if pe  and 0 < pe  < 200 else 0.0
    v_pb = ni(pb,  0.5, 6) if pb  and 0 < pb  < 30  else 0.0
    v_ev = ni(ev,  3, 20) if ev  and 0 < ev  < 60  else 0.0
    scores_value = v_pe * 0.4 + v_pb * 0.3 + v_ev * 0.3

    # Growth: high rev growth, high EPS growth, low PEG
    g_rg  = n(rg,  0,    0.5)  if rg  else 0.0
    g_eg  = n(eg,  0,    0.5)  if eg  else 0.0
    g_peg = ni(peg, 0.5, 3.0) if peg and peg > 0 else 0.0
    scores_growth = g_rg * 0.40 + g_eg * 0.35 + g_peg * 0.25

    # Momentum: price trend, above MAs
    m_chg = n(chg, -10, 25) if chg is not None else 0.5
    m_50  = 1.0 if a50  else 0.0
    m_200 = 1.0 if a200 else 0.0
    scores_momentum = m_chg * 0.40 + m_50 * 0.30 + m_200 * 0.30

    # Quality/GARP: high ROE, low D/E, wide op margin
    q_roe = n(roe, 0,    0.4)  if roe else 0.0
    q_de  = ni(de,  0,   3.0) if de is not None and de >= 0 else 0.5
    q_opm = n(opm, 0,    0.35) if opm else 0.0
    scores_quality = q_roe * 0.40 + q_de * 0.30 + q_opm * 0.30

    # Dividend: sustainable yield, reasonable payout, quality underlying
    d_dy = n(dy, 0.005, 0.07) if dy else 0.0
    d_pr = ni(pr, 0.1, 0.8)   if pr and 0 < pr < 2 else 0.5
    scores_dividend = d_dy * 0.50 + d_pr * 0.25 + q_roe * 0.25

    # Deep value: very cheap on all metrics + healthy balance sheet
    dv_pe = ni(pe,  3, 15)  if pe  and 0 < pe  < 100 else 0.0
    dv_pb = ni(pb,  0.3, 2) if pb  and 0 < pb  < 10  else 0.0
    dv_cr = n(cr,  1.0, 3.0) if cr else 0.0
    scores_deepvalue = dv_pe * 0.40 + dv_pb * 0.35 + dv_cr * 0.25

    raw = {
        "value":     scores_value,
        "growth":    scores_growth,
        "momentum":  scores_momentum,
        "quality":   scores_quality,
        "dividend":  scores_dividend,
        "deepvalue": scores_deepvalue,
    }
    return {k: max(0, min(100, round(v * 100))) for k, v in raw.items()}
