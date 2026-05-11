"""
External data providers: EDGAR (SEC filings), Finnhub, Financial Modeling Prep.
All functions cache aggressively to protect free-tier limits.
"""
import os, json, time, requests
from pathlib import Path
from datetime import datetime, timedelta

_IS_VERCEL  = os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV")
_CACHE_DIR  = Path("/tmp/ext_cache") if _IS_VERCEL else Path("cache/ext")
_CACHE_DIR.mkdir(parents=True, exist_ok=True)

FINNHUB_KEY = os.environ.get("FINNHUB_API_KEY", "")
FMP_KEY     = os.environ.get("FMP_API_KEY", "")
_EDGAR_UA   = "StockDash research-app/1.0 contact@stockdash.app"

# ── Cache helpers ─────────────────────────────────────────────────────────────

def _cget(key: str, ttl: int):
    f = _CACHE_DIR / f"{key}.json"
    try:
        if f.exists() and time.time() - f.stat().st_mtime < ttl:
            return json.loads(f.read_text())
    except Exception:
        pass
    return None

def _cset(key: str, data):
    try:
        (_CACHE_DIR / f"{key}.json").write_text(json.dumps(data, default=str))
    except Exception:
        pass

# ── EDGAR ─────────────────────────────────────────────────────────────────────

_edgar_tickers: dict = {}
_edgar_tickers_ts: float = 0.0

def _get_cik(ticker: str) -> int | None:
    global _edgar_tickers, _edgar_tickers_ts
    if time.time() - _edgar_tickers_ts > 86400 or not _edgar_tickers:
        try:
            r = requests.get("https://www.sec.gov/files/company_tickers.json",
                             headers={"User-Agent": _EDGAR_UA}, timeout=10)
            _edgar_tickers = {v["ticker"].upper(): v["cik_str"] for v in r.json().values()}
            _edgar_tickers_ts = time.time()
        except Exception:
            return None
    return _edgar_tickers.get(ticker.upper())


def fetch_sec_filings(ticker: str) -> dict:
    """Recent SEC filings (8-K, 10-K, 10-Q) via EDGAR. Cached 1h."""
    ticker = ticker.upper()
    cached = _cget(f"edgar_{ticker}", 3600)
    if cached:
        return cached

    cik = _get_cik(ticker)
    if not cik:
        return {"error": f"No CIK found for {ticker}", "filings": []}

    try:
        r = requests.get(
            f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json",
            headers={"User-Agent": _EDGAR_UA}, timeout=10
        )
        r.raise_for_status()
        d = r.json()
        rec = d.get("filings", {}).get("recent", {})
        forms = rec.get("form", [])
        dates = rec.get("filingDate", [])
        docs  = rec.get("primaryDocument", [])
        accns = rec.get("accessionNumber", [])
        descs = rec.get("primaryDocDescription", [])

        filings = []
        for i, form in enumerate(forms):
            if form not in ("10-K", "10-Q", "8-K", "DEF 14A", "SC 13G", "SC 13D"):
                continue
            accn_clean = accns[i].replace("-", "")
            filings.append({
                "form":  form,
                "date":  dates[i],
                "desc":  descs[i] if i < len(descs) else "",
                "url":   f"https://www.sec.gov/Archives/edgar/data/{cik}/{accn_clean}/{docs[i]}",
            })
            if len(filings) >= 15:
                break

        result = {"ticker": ticker, "company": d.get("name", ticker),
                  "cik": cik, "filings": filings}
        _cset(f"edgar_{ticker}", result)
        return result
    except Exception as e:
        return {"error": str(e), "filings": []}


def fetch_filing_text(url: str, max_chars: int = 4000) -> str:
    """Fetch a filing document from EDGAR and return plain text (stripped HTML)."""
    try:
        import re as _re
        r = requests.get(url, headers={"User-Agent": _EDGAR_UA}, timeout=15)
        r.raise_for_status()
        text = r.text
        # Strip HTML tags
        text = _re.sub(r'<style[^>]*>.*?</style>', ' ', text, flags=_re.S | _re.I)
        text = _re.sub(r'<script[^>]*>.*?</script>', ' ', text, flags=_re.S | _re.I)
        text = _re.sub(r'<[^>]+>', ' ', text)
        text = _re.sub(r'&nbsp;', ' ', text)
        text = _re.sub(r'&amp;', '&', text)
        text = _re.sub(r'&lt;', '<', text)
        text = _re.sub(r'&gt;', '>', text)
        text = _re.sub(r'\s+', ' ', text).strip()
        return text[:max_chars]
    except Exception as e:
        return f"[Could not fetch filing: {e}]"


# ── Finnhub ───────────────────────────────────────────────────────────────────

def _fh(path: str, params: dict, ttl: int, cache_key: str):
    cached = _cget(cache_key, ttl)
    if cached is not None:
        return cached
    if not FINNHUB_KEY:
        return {"error": "FINNHUB_API_KEY not set"}
    try:
        r = requests.get(f"https://finnhub.io/api/v1/{path}",
                         params={**params, "token": FINNHUB_KEY}, timeout=8)
        r.raise_for_status()
        data = r.json()
        _cset(cache_key, data)
        return data
    except Exception as e:
        return {"error": str(e)}


def fetch_finnhub_quote(ticker: str) -> dict:
    d = _fh("quote", {"symbol": ticker}, 60, f"fh_q_{ticker}")
    if "error" in d:
        return d
    return {
        "price":      d.get("c"),
        "change":     d.get("d"),
        "change_pct": d.get("dp"),
        "high":       d.get("h"),
        "low":        d.get("l"),
        "open":       d.get("o"),
        "prev_close": d.get("pc"),
    }


def fetch_finnhub_news(ticker: str, days: int = 7) -> list:
    to_d   = datetime.now().strftime("%Y-%m-%d")
    from_d = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    data   = _fh("company-news", {"symbol": ticker, "from": from_d, "to": to_d},
                 1800, f"fh_news_{ticker}")
    if isinstance(data, dict) and "error" in data:
        return []
    return [
        {
            "headline": a.get("headline", ""),
            "source":   a.get("source", ""),
            "url":      a.get("url", ""),
            "datetime": a.get("datetime", 0),
            "summary":  (a.get("summary") or "")[:280],
        }
        for a in (data if isinstance(data, list) else [])[:20]
    ]


def fetch_finnhub_insider(ticker: str) -> list:
    d = _fh("stock/insider-transactions", {"symbol": ticker}, 3600, f"fh_ins_{ticker}")
    txns = d.get("data", []) if isinstance(d, dict) else []
    results = []
    for t in txns[:25]:
        results.append({
            "date":     t.get("transactionDate", ""),
            "name":     t.get("name", ""),
            "share":    t.get("share", 0),
            "change":   t.get("change", 0),
            "transaction_price": t.get("transactionPrice"),
            "transaction_code":  t.get("transactionCode", ""),
        })
    return results


def fetch_finnhub_earnings(ticker: str) -> list:
    d = _fh("stock/earnings", {"symbol": ticker, "limit": 8}, 3600, f"fh_earn_{ticker}")
    if not isinstance(d, list):
        return []
    return [
        {
            "date":      e.get("period", ""),
            "estimate":  e.get("estimate"),
            "actual":    e.get("actual"),
            "surprise":  e.get("surprise"),
            "surprise_pct": e.get("surprisePercent"),
        }
        for e in d
    ]


# ── Financial Modeling Prep ───────────────────────────────────────────────────

def _fmp(path: str, params: dict, ttl: int, cache_key: str):
    cached = _cget(cache_key, ttl)
    if cached is not None:
        return cached
    if not FMP_KEY:
        return {"error": "FMP_API_KEY not set"}
    try:
        r = requests.get(f"https://financialmodelingprep.com/api/v3/{path}",
                         params={**params, "apikey": FMP_KEY}, timeout=10)
        r.raise_for_status()
        data = r.json()
        _cset(cache_key, data)
        return data
    except Exception as e:
        return {"error": str(e)}


def fetch_fmp_income(ticker: str) -> list:
    """Last 4 quarters of income statement."""
    d = _fmp(f"income-statement/{ticker}", {"limit": 4}, 86400, f"fmp_inc_{ticker}")
    if not isinstance(d, list):
        return []
    return [
        {
            "date":           s.get("date"),
            "revenue":        s.get("revenue"),
            "gross_profit":   s.get("grossProfit"),
            "operating_income": s.get("operatingIncome"),
            "net_income":     s.get("netIncome"),
            "eps":            s.get("eps"),
            "ebitda":         s.get("ebitda"),
        }
        for s in d
    ]


def fetch_fmp_ratios(ticker: str) -> dict:
    """TTM financial ratios."""
    d = _fmp(f"ratios-ttm/{ticker}", {}, 86400, f"fmp_rat_{ticker}")
    if isinstance(d, list) and d:
        d = d[0]
    if not isinstance(d, dict):
        return {}
    return {
        "pe_ratio":          d.get("peRatioTTM"),
        "pb_ratio":          d.get("priceToBookRatioTTM"),
        "ps_ratio":          d.get("priceToSalesRatioTTM"),
        "peg_ratio":         d.get("pegRatioTTM"),
        "ev_ebitda":         d.get("enterpriseValueMultipleTTM"),
        "debt_equity":       d.get("debtEquityRatioTTM"),
        "current_ratio":     d.get("currentRatioTTM"),
        "quick_ratio":       d.get("quickRatioTTM"),
        "roe":               d.get("returnOnEquityTTM"),
        "roa":               d.get("returnOnAssetsTTM"),
        "roic":              d.get("returnOnCapitalEmployedTTM"),
        "gross_margin":      d.get("grossProfitMarginTTM"),
        "operating_margin":  d.get("operatingProfitMarginTTM"),
        "net_margin":        d.get("netProfitMarginTTM"),
        "fcf_yield":         d.get("freeCashFlowYieldTTM"),
        "dividend_yield":    d.get("dividendYieldTTM"),
    }


def fetch_fmp_profile(ticker: str) -> dict:
    """Company profile including description, sector, employees."""
    d = _fmp(f"profile/{ticker}", {}, 86400 * 7, f"fmp_prof_{ticker}")
    if isinstance(d, list) and d:
        d = d[0]
    if not isinstance(d, dict):
        return {}
    return {
        "name":        d.get("companyName"),
        "description": d.get("description"),
        "sector":      d.get("sector"),
        "industry":    d.get("industry"),
        "employees":   d.get("fullTimeEmployees"),
        "ceo":         d.get("ceo"),
        "website":     d.get("website"),
        "ipo_date":    d.get("ipoDate"),
    }
