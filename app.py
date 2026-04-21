"""
US Stock Screener — Flask backend
Run: python app.py
"""
import json
from datetime import datetime, timedelta
from pathlib import Path
from flask import Flask, render_template, jsonify, request

import yfinance as yf

from stock_list import get_all_tickers
from screener import (
    fetch_ticker, fetch_batch, screen, compute_scores,
    start_background_refresh, get_refresh_state, PRESETS, _load_cache,
)

app = Flask(__name__)

_stock_cache: list[dict] = []
_tickers: list[str] = []

INDICES = {
    "S&P 500": "^GSPC",
    "NASDAQ":  "^IXIC",
    "DOW":     "^DJI",
    "VIX":     "^VIX",
    "Russell": "^RUT",
    "10Y":     "^TNX",
}

_indices_cache: dict = {}
_indices_cached_at: datetime | None = None

import os as _os
_IS_SERVERLESS = bool(_os.environ.get("VERCEL") or _os.environ.get("VERCEL_ENV"))
_CACHE_BASE = Path("/tmp/cache") if _IS_SERVERLESS else Path("cache")
SPARKLINE_CACHE = _CACHE_BASE / "sparklines"
SPARKLINE_CACHE.mkdir(parents=True, exist_ok=True)


_SEED_FILE = Path(__file__).parent / "data" / "stocks.json"


def _load_all_from_cache() -> list[dict]:
    global _tickers
    _tickers = get_all_tickers()
    stocks = []
    for ticker in _tickers:
        data = _load_cache(ticker)
        if data:
            data["scores"] = compute_scores(data)
            stocks.append(data)

    # On Vercel cold start the runtime cache is empty — fall back to
    # the bundled seed file so the screener works immediately.
    if not stocks and _SEED_FILE.exists():
        try:
            raw = json.loads(_SEED_FILE.read_text())
            for d in raw:
                if not d.get("scores"):
                    d["scores"] = compute_scores(d)
            stocks = raw
        except Exception:
            pass
    return stocks


def _ensure_stocks_loaded():
    global _stock_cache
    if not _stock_cache:
        _stock_cache = _load_all_from_cache()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/presets")
def api_presets():
    return jsonify(PRESETS)


@app.route("/api/status")
def api_status():
    _ensure_stocks_loaded()
    refresh = get_refresh_state()
    return jsonify({
        "total_tickers": len(_tickers),
        "cached_stocks": len(_stock_cache),
        "refresh": refresh,
    })


@app.route("/api/indices")
def api_indices():
    global _indices_cache, _indices_cached_at
    # Cache for 5 minutes
    if _indices_cached_at and datetime.now() - _indices_cached_at < timedelta(minutes=5):
        return jsonify(_indices_cache)
    result = {}
    for name, sym in INDICES.items():
        try:
            t = yf.Ticker(sym)
            info = t.fast_info
            price = getattr(info, "last_price", None)
            prev  = getattr(info, "previous_close", None)
            if price and prev:
                chg = (price - prev) / prev * 100
            else:
                chg = 0
            result[name] = {"symbol": sym, "price": round(price, 2) if price else None,
                            "change_pct": round(chg, 2)}
        except Exception:
            result[name] = {"symbol": sym, "price": None, "change_pct": 0}
    _indices_cache = result
    _indices_cached_at = datetime.now()
    return jsonify(result)


@app.route("/api/sparkline/<ticker>")
def api_sparkline(ticker: str):
    ticker = ticker.upper()
    path = SPARKLINE_CACHE / f"{ticker}.json"
    # Cache sparklines for 6 hours
    if path.exists():
        mtime = datetime.fromtimestamp(path.stat().st_mtime)
        if datetime.now() - mtime < timedelta(hours=6):
            with open(path) as f:
                return jsonify(json.load(f))
    try:
        hist = yf.Ticker(ticker).history(period="3mo", interval="1d")
        if hist.empty:
            return jsonify({"prices": [], "dates": []})
        prices = [round(float(v), 2) for v in hist["Close"].tolist()]
        dates  = [str(d.date()) for d in hist.index.tolist()]
        data = {"prices": prices, "dates": dates}
        with open(path, "w") as f:
            json.dump(data, f)
        return jsonify(data)
    except Exception:
        return jsonify({"prices": [], "dates": []})


@app.route("/api/chart/<ticker>")
def api_chart(ticker: str):
    ticker = ticker.upper()
    period = request.args.get("period", "6mo")
    try:
        import pandas as pd

        hist = yf.Ticker(ticker).history(period=period, interval="1d")
        if hist.empty:
            return jsonify({"ohlcv": [], "technicals": {}})

        close  = hist["Close"]
        high   = hist["High"]
        low    = hist["Low"]
        volume = hist["Volume"]

        def r(v): return round(float(v), 4) if pd.notna(v) else None
        def to_list(s): return [r(v) for v in s]

        # ── Moving Averages ───────────────────────────
        sma20  = close.rolling(20).mean()
        sma50  = close.rolling(50).mean()
        sma200 = close.rolling(200).mean()
        ema9   = close.ewm(span=9,  adjust=False).mean()
        ema12  = close.ewm(span=12, adjust=False).mean()
        ema20  = close.ewm(span=20, adjust=False).mean()
        ema26  = close.ewm(span=26, adjust=False).mean()

        # ── Bollinger Bands (20, 2σ) ──────────────────
        bb_mid   = close.rolling(20).mean()
        bb_std   = close.rolling(20).std()
        bb_upper = bb_mid + 2 * bb_std
        bb_lower = bb_mid - 2 * bb_std
        bb_width = ((bb_upper - bb_lower) / bb_mid * 100)  # % bandwidth

        # ── RSI (14) ──────────────────────────────────
        delta = close.diff()
        gain  = delta.clip(lower=0).rolling(14).mean()
        loss  = (-delta.clip(upper=0)).rolling(14).mean()
        rs    = gain / loss.replace(0, float("nan"))
        rsi   = 100 - (100 / (1 + rs))

        # ── MACD (12, 26, 9) ──────────────────────────
        macd_line   = ema12 - ema26
        macd_signal = macd_line.ewm(span=9, adjust=False).mean()
        macd_hist   = macd_line - macd_signal

        # ── Stochastic Oscillator (14, 3) ────────────
        lowest14  = low.rolling(14).min()
        highest14 = high.rolling(14).max()
        stoch_k   = (close - lowest14) / (highest14 - lowest14 + 1e-9) * 100
        stoch_d   = stoch_k.rolling(3).mean()

        # ── VWAP (rolling daily proxy) ────────────────
        typical  = (high + low + close) / 3
        vwap     = (typical * volume).cumsum() / volume.cumsum()

        # ── ATR (14) ──────────────────────────────────
        prev_close = close.shift(1)
        tr  = pd.concat([high - low,
                         (high - prev_close).abs(),
                         (low  - prev_close).abs()], axis=1).max(axis=1)
        atr = tr.rolling(14).mean()

        # ── On-Balance Volume ─────────────────────────
        price_diff = close.diff()
        obv = (volume * price_diff.apply(lambda x: 1 if x > 0 else (-1 if x < 0 else 0))).cumsum()

        # ── Williams %R (14) ──────────────────────────
        will_r = (highest14 - close) / (highest14 - lowest14 + 1e-9) * -100

        # ── CCI (20) ──────────────────────────────────
        cci_tp  = (high + low + close) / 3
        cci_sma = cci_tp.rolling(20).mean()
        cci_mad = cci_tp.rolling(20).apply(lambda x: (x - x.mean()).abs().mean())
        cci     = (cci_tp - cci_sma) / (0.015 * cci_mad.replace(0, float("nan")))

        # ── Build OHLCV list ──────────────────────────
        ohlcv = []
        closes = close.tolist()
        for i, (idx, row) in enumerate(hist.iterrows()):
            prev = closes[i - 1] if i > 0 else closes[0]
            ohlcv.append({
                "date":   str(idx.date()),
                "open":   round(float(row["Open"]),  2),
                "high":   round(float(row["High"]),  2),
                "low":    round(float(row["Low"]),   2),
                "close":  round(float(row["Close"]), 2),
                "volume": int(row["Volume"]),
                "up":     float(row["Close"]) >= prev,
            })

        return jsonify({
            "ohlcv": ohlcv,
            "technicals": {
                "sma20":       to_list(sma20),
                "sma50":       to_list(sma50),
                "sma200":      to_list(sma200),
                "ema9":        to_list(ema9),
                "ema20":       to_list(ema20),
                "bb_upper":    to_list(bb_upper),
                "bb_mid":      to_list(bb_mid),
                "bb_lower":    to_list(bb_lower),
                "bb_width":    to_list(bb_width),
                "rsi":         to_list(rsi),
                "macd":        to_list(macd_line),
                "macd_signal": to_list(macd_signal),
                "macd_hist":   to_list(macd_hist),
                "stoch_k":     to_list(stoch_k),
                "stoch_d":     to_list(stoch_d),
                "vwap":        to_list(vwap),
                "atr":         to_list(atr),
                "obv":         to_list(obv),
                "will_r":      to_list(will_r),
                "cci":         to_list(cci),
            },
        })
    except Exception as e:
        return jsonify({"ohlcv": [], "technicals": {}, "error": str(e)})


def _parse_news(raw, max_items=20):
    """Parse yfinance news list into clean dicts with date field."""
    import time as _time
    import datetime as dt
    result = []
    for n in (raw or [])[:max_items]:
        content = n.get("content", {})
        title = content.get("title") or n.get("title", "")
        link  = content.get("canonicalUrl", {}).get("url") or n.get("link", "")
        pub   = content.get("provider", {}).get("displayName") or n.get("publisher", "")
        ts    = content.get("pubDate") or ""
        date_str = None
        age_min  = None
        if ts:
            try:
                d = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
                date_str = d.strftime("%Y-%m-%d")
                age_min  = int((dt.datetime.now(dt.timezone.utc) - d).total_seconds() / 60)
            except Exception:
                pass
        if not date_str:
            pt = n.get("providerPublishTime", 0)
            if pt:
                d = dt.datetime.fromtimestamp(pt, tz=dt.timezone.utc)
                date_str = d.strftime("%Y-%m-%d")
                age_min  = int((_time.time() - pt) / 60)
        thumb = ""
        try:
            resolutions = n.get("thumbnail", {}).get("resolutions", [])
            if resolutions:
                thumb = resolutions[0].get("url", "")
        except Exception:
            pass
        if title and link:
            result.append({
                "title": title, "publisher": pub, "link": link,
                "date": date_str, "age_min": age_min, "thumbnail": thumb,
            })
    return result


@app.route("/api/news")
def api_news():
    try:
        return jsonify(_parse_news(yf.Ticker("SPY").news, 20))
    except Exception:
        return jsonify([])


@app.route("/api/news/<ticker>")
def api_news_ticker(ticker: str):
    try:
        return jsonify(_parse_news(yf.Ticker(ticker.upper()).news, 30))
    except Exception:
        return jsonify([])


@app.route("/api/movers")
def api_movers():
    _ensure_stocks_loaded()
    stocks = [s for s in _stock_cache if s.get("regularMarketChangePercent") is not None]
    stocks_sorted = sorted(stocks, key=lambda s: s.get("regularMarketChangePercent", 0), reverse=True)
    gainers = stocks_sorted[:5]
    losers  = stocks_sorted[-5:][::-1]
    def fmt(s):
        return {
            "symbol": s.get("symbol"),
            "name":   s.get("shortName", ""),
            "chg":    round(s.get("regularMarketChangePercent", 0), 2),
        }
    return jsonify({"gainers": [fmt(s) for s in gainers], "losers": [fmt(s) for s in losers]})


@app.route("/api/heatmap")
def api_heatmap():
    _ensure_stocks_loaded()
    totals: dict = {}
    counts: dict = {}
    for s in _stock_cache:
        sec = s.get("sector") or s.get("sectorDisp") or ""
        chg = s.get("regularMarketChangePercent")
        if sec and chg is not None:
            totals[sec] = totals.get(sec, 0) + chg
            counts[sec] = counts.get(sec, 0) + 1
    result = {sec: round(totals[sec] / counts[sec], 2) for sec in totals}
    return jsonify(result)


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    tickers = _tickers or get_all_tickers()
    started = start_background_refresh(tickers)
    return jsonify({"started": started})


@app.route("/api/reload", methods=["POST"])
def api_reload():
    global _stock_cache
    _stock_cache = _load_all_from_cache()
    return jsonify({"loaded": len(_stock_cache)})


@app.route("/api/screen", methods=["POST"])
def api_screen():
    _ensure_stocks_loaded()
    body = request.json or {}
    filters = body.get("filters", {})
    sort_by = body.get("sort_by", "marketCap")
    sort_dir = body.get("sort_dir", "desc")
    page = int(body.get("page", 1))
    per_page = int(body.get("per_page", 50))

    parsed_filters = {k: v for k, v in filters.items() if isinstance(v, dict)}
    results = screen(_stock_cache, parsed_filters, sort_by, sort_dir)

    total = len(results)
    start = (page - 1) * per_page
    page_results = results[start:start + per_page]

    return jsonify({"total": total, "page": page, "per_page": per_page, "results": page_results})


@app.route("/stock/<ticker>")
def stock_page(ticker: str):
    return render_template("stock.html", ticker=ticker.upper())


@app.route("/api/insider/<ticker>")
def api_insider(ticker: str):
    ticker = ticker.upper()
    try:
        df = yf.Ticker(ticker).insider_transactions
        if df is None or df.empty:
            return jsonify([])
        rows = []
        for _, r in df.iterrows():
            text = str(r.get("Text", "") or "")
            if "sale" in text.lower():
                txn_type = "Sell"
            elif "purchase" in text.lower() or "buy" in text.lower():
                txn_type = "Buy"
            elif "gift" in text.lower():
                txn_type = "Gift"
            else:
                txn_type = "Grant"
            val = r.get("Value")
            shares = r.get("Shares")
            date_raw = r.get("Start Date")
            if date_raw is None:
                continue
            date_str = str(date_raw)[:10]
            rows.append({
                "date":     date_str,
                "name":     str(r.get("Insider", "")).title(),
                "position": str(r.get("Position", "")),
                "type":     txn_type,
                "shares":   int(shares) if shares and not (shares != shares) else 0,
                "value":    float(val) if val and not (val != val) else None,
            })
        rows.sort(key=lambda x: x["date"], reverse=True)
        return jsonify(rows[:30])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/stock/<ticker>")
def api_stock(ticker: str):
    ticker = ticker.upper()
    for s in _stock_cache:
        if s.get("symbol") == ticker:
            s["scores"] = compute_scores(s)
            return jsonify(s)
    data = fetch_ticker(ticker, force=False)
    if data:
        data["scores"] = compute_scores(data)
        return jsonify(data)
    return jsonify({"error": f"No data for {ticker}"}), 404


if __name__ == "__main__":
    print("=" * 60)
    print("  US Stock Screener  ·  http://localhost:5000")
    print("=" * 60)
    _stock_cache = _load_all_from_cache()
    print(f"  Loaded {len(_stock_cache)} stocks from cache.")
    if len(_stock_cache) < 10:
        print("  Fetching top 100 stocks…")
        quick = [
            "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","JPM","V",
            "JNJ","UNH","XOM","WMT","PG","MA","HD","CVX","LLY","ABBV",
            "PEP","MRK","COST","ORCL","CRM","BAC","CSCO","TMO","ACN","ADBE",
            "WFC","MCD","NKE","INTC","QCOM","INTU","TXN","DIS","AMD","NFLX",
            "AMGN","PM","UNP","IBM","SPGI","CAT","GS","SBUX","DE","AMAT",
            "GE","BA","HON","RTX","LMT","ISRG","VRTX","GILD","REGN","BKNG",
            "T","VZ","TMUS","CMCSA","NEE","DUK","SO","AEP","D","EXC",
            "MS","BLK","SCHW","AXP","COF","USB","PNC","TFC","C","MCO",
            "PLD","AMT","EQIX","PSA","CCI","EXR","WELL","VTR","SPG","O",
            "MMM","EMR","PH","ROK","ETN","GD","NOC","HII","F","GM",
        ]
        data = fetch_batch(quick, force=False)
        for d in data:
            d["scores"] = compute_scores(d)
        _stock_cache = data
        print(f"  Fetched {len(_stock_cache)} stocks.")
    app.run(debug=False, use_reloader=False, port=5000)
