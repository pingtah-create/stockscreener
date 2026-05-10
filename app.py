"""
US Stock Screener — Flask backend
Run: python app.py
"""
import json
from datetime import datetime, timedelta
from pathlib import Path
from flask import Flask, render_template, jsonify, request, redirect, url_for

import yfinance as yf

from stock_list import get_all_tickers
from screener import (
    fetch_ticker, fetch_batch, screen, compute_scores, compute_swing_setup,
    start_background_refresh, get_refresh_state, _load_cache,
)
import auth

app = Flask(__name__)
auth.init_app(app)


@app.context_processor
def _inject_user():
    return {"current_user": auth.current_user()}

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
# Load .env for local development
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        if _line.strip() and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            _os.environ.setdefault(_k.strip(), _v.strip())

_IS_SERVERLESS = bool(_os.environ.get("VERCEL") or _os.environ.get("VERCEL_ENV"))
_CACHE_BASE = Path("/tmp/cache") if _IS_SERVERLESS else Path("cache")

# ── Finnhub live-quote cache (30-second TTL per ticker) ───────────
_quote_cache: dict = {}
_QUOTE_TTL = 30

# ── Gemini intel cache (7-day TTL, stored on disk) ────────────────
_INTEL_DIR = _CACHE_BASE / "intel"
_INTEL_DIR.mkdir(parents=True, exist_ok=True)
_INTEL_TTL = 7 * 24 * 3600
SPARKLINE_CACHE = _CACHE_BASE / "sparklines"
SPARKLINE_CACHE.mkdir(parents=True, exist_ok=True)


_SEED_FILE = Path(__file__).parent / "data" / "stocks.json"


def _live_quote(ticker: str):
    """Return (current_price, previous_close) using the same data path the
    chart endpoint uses — guarantees the header price matches the rightmost
    candle on the chart. Falls back to 1-min bars then fast_info."""
    try:
        t = yf.Ticker(ticker)
        hist = t.history(period="5d", interval="1d", timeout=15)
        if not hist.empty:
            cur  = float(hist["Close"].iloc[-1])
            prev = float(hist["Close"].iloc[-2]) if len(hist) >= 2 else cur
            if cur > 0:
                return cur, prev
    except Exception:
        pass
    try:
        t = yf.Ticker(ticker)
        hist = t.history(period="2d", interval="1m", prepost=True)
        if not hist.empty:
            cur   = float(hist["Close"].iloc[-1])
            dates = [d.date() for d in hist.index]
            today = dates[-1]
            prev_idx = [i for i, d in enumerate(dates) if d < today]
            prev = float(hist["Close"].iloc[prev_idx[-1]]) if prev_idx else \
                   float(getattr(t.fast_info, "previous_close", None) or 0)
            if cur > 0:
                return cur, prev
    except Exception:
        pass
    try:
        info = yf.Ticker(ticker).fast_info
        cur  = float(getattr(info, "last_price", None) or 0)
        prev = float(getattr(info, "previous_close", None) or 0)
        if cur > 0:
            return cur, prev
    except Exception:
        pass
    return None, None


def _load_all_from_cache() -> list[dict]:
    global _tickers
    _tickers = get_all_tickers()

    # Start from the bundled seed (committed to git, used on Vercel cold-start
    # and as a fallback for any ticker whose individual cache file is missing).
    by_sym: dict[str, dict] = {}
    if _SEED_FILE.exists():
        try:
            for d in json.loads(_SEED_FILE.read_text()):
                sym = d.get("symbol")
                if sym:
                    by_sym[sym] = d
        except Exception:
            pass

    # Overlay individual disk-cache files (fresher than the seed).
    for ticker in _tickers:
        data = _load_cache(ticker)
        if data:
            by_sym[data.get("symbol") or ticker] = data

    stocks = []
    for sym, data in by_sym.items():
        if not data.get("scores"):
            data["scores"] = compute_scores(data)
        stocks.append(data)
    return stocks


_prices_refreshed_at: datetime | None = None


def _refresh_live_prices():
    """Fast bulk price refresh via yf.download() — single HTTP call for all tickers."""
    global _stock_cache, _prices_refreshed_at
    if not _stock_cache:
        return
    # Only refresh once every 5 minutes per warm instance
    if _prices_refreshed_at and (datetime.utcnow() - _prices_refreshed_at).seconds < 300:
        return
    try:
        tickers = [s["symbol"] for s in _stock_cache if s.get("symbol")]
        if not tickers:
            return
        import pandas as pd
        df = yf.download(
            tickers, period="5d", interval="1d",
            progress=False, auto_adjust=True, threads=True
        )
        if df.empty:
            return
        close = df["Close"] if "Close" in df else df.get("Adj Close")
        if close is None or close.empty:
            return
        # Build price map: ticker → (latest_close, prev_close)
        price_map = {}
        for tkr in tickers:
            col = tkr if tkr in close.columns else None
            if col is None and len(tickers) == 1:
                col = close.columns[0] if not close.empty else None
            if col is None:
                continue
            series = close[col].dropna()
            if len(series) >= 2:
                price_map[tkr] = (float(series.iloc[-1]), float(series.iloc[-2]))
            elif len(series) == 1:
                price_map[tkr] = (float(series.iloc[0]), None)

        # Update in-memory cache
        for s in _stock_cache:
            tkr = s.get("symbol")
            if tkr in price_map:
                cur, prev = price_map[tkr]
                s["currentPrice"] = cur
                if prev and prev > 0:
                    s["regularMarketChangePercent"] = round((cur - prev) / prev * 100, 4)
        _prices_refreshed_at = datetime.utcnow()
    except Exception:
        pass


def _ensure_stocks_loaded():
    global _stock_cache
    if not _stock_cache:
        _stock_cache = _load_all_from_cache()
    # Refresh live prices on Vercel (seed data has stale prices)
    if _IS_SERVERLESS:
        import threading
        threading.Thread(target=_refresh_live_prices, daemon=True).start()


@app.route("/login", methods=["GET", "POST"])
def login_page():
    if auth.current_user():
        return redirect(url_for("index"))
    error = None
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        if auth.verify_user(username, password):
            auth.login_session(username)
            nxt = request.args.get("next") or url_for("index")
            if not nxt.startswith("/"):
                nxt = url_for("index")
            return redirect(nxt)
        error = "Invalid username or password."
    return render_template("login.html", mode="login", error=error)


@app.route("/signup", methods=["GET", "POST"])
def signup_page():
    if auth.current_user():
        return redirect(url_for("index"))
    error = None
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        confirm  = request.form.get("confirm")  or ""
        if password != confirm:
            error = "Passwords do not match."
        else:
            ok, msg = auth.create_user(username, password)
            if ok:
                auth.login_session(username)
                return redirect(url_for("index"))
            error = msg
    return render_template("login.html", mode="signup", error=error)


@app.route("/logout", methods=["POST", "GET"])
def logout():
    auth.logout_session()
    return redirect(url_for("login_page"))


@app.route("/")
@auth.require_login
def index():
    return render_template("chat.html")


@app.route("/dashboard")
@auth.require_login
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/status")
@auth.require_login_api
def api_status():
    _ensure_stocks_loaded()
    refresh = get_refresh_state()
    return jsonify({
        "total_tickers": len(_tickers),
        "cached_stocks": len(_stock_cache),
        "refresh": refresh,
    })


@app.route("/api/indices")
@auth.require_login_api
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
@auth.require_login_api
def api_sparkline(ticker: str):
    ticker = ticker.upper()
    path = SPARKLINE_CACHE / f"{ticker}.json"
    # Cache sparklines for 6 hours
    if path.exists():
        mtime = datetime.fromtimestamp(path.stat().st_mtime)
        if datetime.now() - mtime < timedelta(hours=2):
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
@auth.require_login_api
def api_chart(ticker: str):
    ticker = ticker.upper()
    period = request.args.get("period", "6mo")

    # Map requested period → (yfinance fetch period, # of bars to keep).
    # Fetch period is larger so SMA200/BB have full lookback for the visible
    # range — otherwise overlays show a "warmup gap" on the left edge.
    PERIOD_MAP = {
        "5d":  ("1y",  5),
        "1mo": ("1y",  21),
        "3mo": ("2y",  63),
        "6mo": ("2y",  126),
        "1y":  ("5y",  252),
        "2y":  ("5y",  504),
        "5y":  ("10y", 1260),
    }
    fetch_period, keep_bars = PERIOD_MAP.get(period, (period, None))

    try:
        import pandas as pd

        t_obj = yf.Ticker(ticker)
        hist = t_obj.history(period=fetch_period, interval="1d", timeout=20)
        if hist.empty:
            # Try once more — Yahoo sometimes returns empty on first call
            hist = t_obj.history(period=fetch_period, interval="1d", timeout=20)
        if hist.empty:
            return jsonify({"ohlcv": [], "technicals": {}, "error": f"No data found for {ticker}"})

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

        technicals = {
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
        }

        # Trim to the requested range now that indicators are warmed up.
        if keep_bars and len(ohlcv) > keep_bars:
            ohlcv = ohlcv[-keep_bars:]
            technicals = {k: v[-keep_bars:] for k, v in technicals.items()}

        return jsonify({"ohlcv": ohlcv, "technicals": technicals})
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
@auth.require_login_api
def api_news():
    try:
        return jsonify(_parse_news(yf.Ticker("SPY").news, 20))
    except Exception:
        return jsonify([])


@app.route("/api/news/<ticker>")
@auth.require_login_api
def api_news_ticker(ticker: str):
    try:
        return jsonify(_parse_news(yf.Ticker(ticker.upper()).news, 30))
    except Exception:
        return jsonify([])


@app.route("/api/news-events/<ticker>")
@auth.require_login_api
def api_news_events(ticker: str):
    """AI-identified key price-moving events. Cached 6h."""
    ticker = ticker.upper()
    p = _INTEL_DIR / f"{ticker}_newsevents.json"
    if p.exists():
        age = (datetime.utcnow() - datetime.utcfromtimestamp(p.stat().st_mtime)).total_seconds()
        if age < 6 * 3600:
            try:
                return jsonify(json.loads(p.read_text()))
            except Exception:
                p.unlink(missing_ok=True)

    api_key = _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return jsonify({"error": "GEMINI_API_KEY not set"}), 503

    try:
        t = yf.Ticker(ticker)
        hist = t.history(period="3mo", interval="1d", auto_adjust=True)
        if hist.empty:
            return jsonify([])

        closes = hist["Close"].dropna()
        pcts = closes.pct_change() * 100

        # Top significant moves by absolute size
        sig = pcts[pcts.abs() > 2.5].copy()
        if len(sig) < 3:
            sig = pcts.dropna().copy()
        sig = sig.reindex(sig.abs().sort_values(ascending=False).index).head(8)

        news_items = _parse_news(t.news, 60)

        moves = []
        for ts, pct_val in sig.items():
            date_str = str(ts.date()) if hasattr(ts, "date") else str(ts)[:10]
            pct_val = round(float(pct_val), 2)
            try:
                move_dt = datetime.strptime(date_str, "%Y-%m-%d")
            except Exception:
                continue
            nearby = []
            for n in news_items:
                if not n.get("date"):
                    continue
                try:
                    nd = datetime.strptime(n["date"], "%Y-%m-%d")
                    if abs((nd - move_dt).days) <= 4:
                        nearby.append({"title": n["title"], "publisher": n.get("publisher", ""), "link": n.get("link", "")})
                except Exception:
                    continue
            moves.append({"date": date_str, "pct": pct_val, "nearby_news": nearby[:5]})

        if not moves:
            return jsonify([])

        moves.sort(key=lambda x: x["date"])

        prompt = f"""You are a financial analyst. For the stock {ticker}, each entry below is a significant daily price move with nearby news headlines.

For each move, identify the most likely catalyst and explain in one concise sentence what drove it.

Data:
{json.dumps(moves, indent=2)}

Return ONLY a JSON array, no markdown or extra text:
[
  {{
    "date": "YYYY-MM-DD",
    "pct": <number>,
    "direction": "up" or "down",
    "headline": "<short event name or headline, max 80 chars>",
    "summary": "<one sentence: what happened and why the stock moved that day>",
    "url": "<url from nearby_news if relevant, else empty string>"
  }}
]

Order by date descending. Include all {len(moves)} moves."""

        import requests as _req
        import re as _re
        url  = (f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"gemini-2.5-flash:generateContent?key={api_key}")
        body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048,
                                 "responseMimeType": "application/json"},
        }
        r = _req.post(url, json=body, timeout=30)
        r.raise_for_status()
        raw = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        raw = _re.sub(r':\s*NaN\b', ': null', raw)
        raw = _re.sub(r',\s*([}\]])', r'\1', raw)

        events = json.loads(raw)
        p.write_text(json.dumps(events))
        return jsonify(events)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


_movers_cache: dict = {"gainers": [], "losers": [], "at": None}
_MOVERS_TTL = 120  # seconds


@app.route("/api/movers")
@auth.require_login_api
def api_movers():
    _ensure_stocks_loaded()

    # Serve from short-lived cache if fresh
    if (_movers_cache["at"] and
            (datetime.utcnow() - _movers_cache["at"]).total_seconds() < _MOVERS_TTL):
        return jsonify({"gainers": _movers_cache["gainers"], "losers": _movers_cache["losers"]})

    us_stocks = [s for s in _stock_cache
                 if not str(s.get("symbol", "")).endswith(".TW") and s.get("symbol")]
    all_tickers = [s["symbol"] for s in us_stocks]

    # Fetch fresh daily closes for all US stocks in one call
    fresh_chg: dict[str, float] = {}
    try:
        df = yf.download(
            all_tickers, period="5d", interval="1d",
            progress=False, auto_adjust=True, threads=True
        )
        if not df.empty:
            close = df["Close"] if "Close" in df else df.get("Adj Close")
            if close is not None and not close.empty:
                for tkr in all_tickers:
                    col = tkr if tkr in close.columns else None
                    if col is None and len(all_tickers) == 1:
                        col = close.columns[0] if not close.empty else None
                    if col is None:
                        continue
                    series = close[col].dropna()
                    if len(series) >= 2:
                        cur, prev = float(series.iloc[-1]), float(series.iloc[-2])
                        if prev > 0:
                            fresh_chg[tkr] = round((cur - prev) / prev * 100, 4)
    except Exception:
        pass

    def get_chg(s):
        tkr = s.get("symbol", "")
        return fresh_chg.get(tkr, s.get("regularMarketChangePercent", 0) or 0)

    stocks_sorted = sorted(us_stocks, key=get_chg, reverse=True)
    gainers = stocks_sorted[:5]
    losers  = stocks_sorted[-5:][::-1]

    def fmt(s):
        return {
            "symbol": s.get("symbol"),
            "name":   s.get("shortName", ""),
            "chg":    round(get_chg(s), 2),
        }

    result = {
        "gainers": [fmt(s) for s in gainers],
        "losers":  [fmt(s) for s in losers],
    }
    _movers_cache.update({"gainers": result["gainers"], "losers": result["losers"],
                          "at": datetime.utcnow()})
    return jsonify(result)


_FX_CACHE: dict = {"TWDUSD": None, "at": None}
def _twd_to_usd_rate() -> float:
    """USD per 1 TWD. Cached for 1 hour. Falls back to ~0.031 (~32 TWD/USD)."""
    now = datetime.utcnow()
    if _FX_CACHE["at"] and (now - _FX_CACHE["at"]).total_seconds() < 3600 and _FX_CACHE["TWDUSD"]:
        return _FX_CACHE["TWDUSD"]
    try:
        info = yf.Ticker("TWDUSD=X").fast_info
        rate = float(getattr(info, "last_price", None) or 0)
        if rate > 0:
            _FX_CACHE["TWDUSD"] = rate
            _FX_CACHE["at"] = now
            return rate
    except Exception:
        pass
    return 0.031  # ~32 TWD per USD, May 2026


@app.route("/api/stockmap")
@auth.require_login_api
def api_stockmap():
    """Per-stock treemap data: sector, market cap (USD), % change. Used by
    the dashboard stock-map panel (Finviz-style)."""
    _ensure_stocks_loaded()
    twd_usd = _twd_to_usd_rate()
    rows = []
    for s in _stock_cache:
        sym = s.get("symbol")
        mcap = s.get("marketCap")
        chg = s.get("regularMarketChangePercent")
        if not sym or not mcap:
            continue
        # Taiwan stocks get their own top-level group AND have their TWD
        # market cap converted to USD so tiles compare apples-to-apples.
        if sym.endswith(".TW"):
            sector = "Taiwan"
            mcap = mcap * twd_usd
        else:
            sector = s.get("sector") or s.get("sectorDisp") or "Other"
        rows.append({
            "symbol":     sym,
            "name":       (s.get("shortName") or s.get("longName") or sym)[:24],
            "sector":     sector,
            "mcap":       int(mcap),
            "change_pct": round(chg, 2) if chg is not None else 0.0,
        })
    rows.sort(key=lambda r: r["mcap"], reverse=True)
    return jsonify(rows)


@app.route("/api/heatmap")
@auth.require_login_api
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
@auth.require_login_api
def api_refresh():
    tickers = _tickers or get_all_tickers()
    started = start_background_refresh(tickers)
    return jsonify({"started": started})


@app.route("/api/quotes", methods=["POST"])
@auth.require_login_api
def api_quotes():
    """Batch live quotes for watchlist — uses Yahoo's quote endpoint (real-time)
    in parallel for each ticker. Cache is only used for company names."""
    _ensure_stocks_loaded()
    body = request.json or {}
    tickers = [t.upper().strip() for t in (body.get("tickers") or []) if t]
    if not tickers:
        return jsonify([])

    cache_map = {s.get("symbol"): s for s in _stock_cache}
    def name_for(tkr: str) -> str:
        s = cache_map.get(tkr) or {}
        return s.get("shortName") or s.get("longName") or tkr

    def fetch_one(tkr: str):
        cur, prev = _live_quote(tkr)
        if cur is None:
            return tkr, None
        chg = (cur - prev) / prev * 100 if prev else 0
        return tkr, {
            "symbol":     tkr,
            "name":       name_for(tkr),
            "price":      round(cur, 2),
            "change_pct": round(chg, 2),
        }

    from concurrent.futures import ThreadPoolExecutor
    results: dict = {}
    with ThreadPoolExecutor(max_workers=min(10, len(tickers))) as ex:
        for tkr, data in ex.map(fetch_one, tickers):
            if data:
                results[tkr] = data

    payload = [results[t] for t in tickers if t in results]
    resp = jsonify(payload)
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


@app.route("/api/swingscan")
@auth.require_login_api
def api_swingscan():
    """Top algorithmic swing trade setups across all cached stocks."""
    _ensure_stocks_loaded()
    results = []
    for s in _stock_cache:
        setup = compute_swing_setup(s)
        if not setup:
            continue
        price = s.get("currentPrice") or s.get("previousClose")
        results.append({
            "symbol":  s.get("symbol"),
            "name":    (s.get("shortName") or s.get("longName") or "")[:28],
            "sector":  s.get("sector") or "",
            "price":   round(price, 2) if price else None,
            "rsi":     s.get("rsi14"),
            "setup":   setup,
        })
    results.sort(key=lambda x: x["setup"]["rr"], reverse=True)
    return jsonify(results[:20])


@app.route("/api/swing/<ticker>")
@auth.require_login_api
def api_swing(ticker: str):
    """AI swing trade setup via Gemini. Cached 24h."""
    ticker = ticker.upper()
    p = _INTEL_DIR / f"{ticker}_swing.json"
    if p.exists():
        age = (datetime.utcnow() - datetime.utcfromtimestamp(p.stat().st_mtime)).total_seconds()
        if age < 86400:
            try:
                return jsonify(json.loads(p.read_text()))
            except Exception:
                p.unlink(missing_ok=True)  # delete corrupt cache, regenerate below

    api_key = _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return jsonify({"error": "GEMINI_API_KEY not set"}), 503

    data   = next((s for s in _stock_cache if s.get("symbol") == ticker), None) or _load_cache(ticker) or {}
    name   = data.get("shortName") or ticker
    price  = data.get("currentPrice") or data.get("previousClose")
    sma50  = data.get("fiftyDayAverage")
    sma200 = data.get("twoHundredDayAverage")
    rsi    = data.get("rsi14")
    sector = data.get("sector") or "Unknown"
    algo   = compute_swing_setup(data)

    def _fv(v, pfx="$"): return f"{pfx}{v:.2f}" if v else "N/A"
    lines = [
        f"Price: {_fv(price)}",
        f"50-Day MA: {_fv(sma50)} ({'above' if price and sma50 and price>sma50 else 'below'})",
        f"200-Day MA: {_fv(sma200)} ({'above' if price and sma200 and price>sma200 else 'below'})",
        f"RSI-14: {rsi or 'N/A'}",
    ]
    if algo:
        lines.append(f"Algo signal: {algo['type']} — Entry {_fv(algo['entry'])}, Stop {_fv(algo['stop'])}, Target {_fv(algo['target'])}, R:R {algo['rr']}")

    prompt = f"""You are an expert swing trader. Analyze {ticker} ({name}), a {sector} stock, for a 2-10 day swing trade.

Technicals:
{chr(10).join(lines)}

Return ONLY valid JSON:
{{
  "signal": "Bullish" or "Bearish" or "Neutral",
  "setup_type": "e.g. Pullback to 50MA",
  "entry_low": number,
  "entry_high": number,
  "stop_loss": number,
  "target_1": number,
  "target_2": number,
  "timeframe": "e.g. 3-5 days",
  "confidence": "High" or "Medium" or "Low",
  "thesis": "2-3 sentence explanation",
  "risk_factors": "1-2 sentence warning"
}}"""

    try:
        import requests as _req
        url  = (f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"gemini-2.5-flash:generateContent?key={api_key}")
        body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048,
                                 "responseMimeType": "application/json"},
        }
        r = _req.post(url, json=body, timeout=25)
        r.raise_for_status()
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        import re as _re
        m = _re.search(r'\{[\s\S]*\}', text)
        raw = m.group() if m else text
        # Fix common Gemini JSON issues
        raw = _re.sub(r':\s*NaN\b',       ': null', raw)
        raw = _re.sub(r':\s*undefined\b', ': null', raw)
        raw = _re.sub(r',\s*([}\]])',     r'\1',    raw)  # trailing commas
        result = json.loads(raw)
        p.write_text(json.dumps(result))
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/intel/<ticker>")
@auth.require_login_api
def api_intel(ticker: str):
    """AI-generated company intel via Gemini. Cached 7 days on disk."""
    ticker = ticker.upper()
    p = _INTEL_DIR / f"{ticker}.json"

    # Serve from cache if fresh
    if p.exists():
        age = (datetime.utcnow() - datetime.utcfromtimestamp(p.stat().st_mtime)).total_seconds()
        if age < _INTEL_TTL:
            try:
                return jsonify(json.loads(p.read_text()))
            except Exception:
                p.unlink(missing_ok=True)

    api_key = _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return jsonify({"error": "GEMINI_API_KEY not set"}), 503

    # Pull fundamentals for richer prompt
    data = next((s for s in _stock_cache if s.get("symbol") == ticker), None) or _load_cache(ticker) or {}
    name     = data.get("shortName") or data.get("longName") or ticker
    sector   = data.get("sector")   or "Unknown"
    industry = data.get("industry") or "Unknown"
    mcap     = data.get("marketCap")
    pe       = data.get("trailingPE")
    roe      = data.get("returnOnEquity")
    rg       = data.get("revenueGrowth")

    def _f(v, mult=1, sfx=""):
        return f"{round(v * mult, 1)}{sfx}" if v is not None else "N/A"

    prompt = f"""You are a senior financial analyst. Analyze {ticker} ({name}), a {sector} company in the {industry} industry.
Key metrics: Market Cap {f"${round(mcap/1e9,1)}B" if mcap else "N/A"}, P/E {_f(pe)}, Revenue Growth {_f(rg,100,'%')}, ROE {_f(roe,100,'%')}

Return ONLY a valid JSON object (no markdown, no code fences) with exactly these keys:
{{
  "overview": "2-3 sentence plain-English description of the business model and main revenue sources",
  "macro": "2-3 sentences on which specific macroeconomic factors drive or hurt this company (interest rates, inflation, USD strength, oil prices, regulation, consumer spending, etc.)",
  "strengths": ["concise strength 1", "concise strength 2", "concise strength 3", "concise strength 4"],
  "weaknesses": ["concise risk/weakness 1", "concise risk/weakness 2", "concise risk/weakness 3"],
  "competitors": [
    {{"ticker": "XXX", "name": "Full Company Name", "note": "one sentence on how they compete with {ticker}"}},
    {{"ticker": "YYY", "name": "Full Company Name", "note": "one sentence on how they compete with {ticker}"}}
  ]
}}
Include 4-5 competitors. Be specific and factual."""

    try:
        import requests as _req
        url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
               f"gemini-2.5-flash:generateContent?key={api_key}")
        body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.25,
                "maxOutputTokens": 2048,
                "responseMimeType": "application/json",
            },
        }
        r = _req.post(url, json=body, timeout=30)
        r.raise_for_status()
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        import re as _re
        m = _re.search(r'\{[\s\S]*\}', text)
        raw = m.group() if m else text
        raw = _re.sub(r':\s*NaN\b',       ': null', raw)
        raw = _re.sub(r':\s*undefined\b', ': null', raw)
        raw = _re.sub(r',\s*([}\]])',     r'\1',    raw)
        result = json.loads(raw)
        p.write_text(json.dumps(result))
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


_TICKER_RE = None
def _extract_tickers(text: str) -> list[str]:
    """Pull stock tickers out of free-text. Matches $AAPL, AAPL, 2330.TW.
    Restricted to symbols actually in our universe to avoid false positives."""
    global _TICKER_RE
    import re
    if _TICKER_RE is None:
        # Match $AAPL, AAPL, BRK.B, 2330.TW (Taiwan tickers start with digits).
        _TICKER_RE = re.compile(r"\$?(\d{4}\.TW|[A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b")
    universe = {s.get("symbol") for s in _stock_cache if s.get("symbol")}
    universe |= set(_tickers)
    found = []
    seen = set()
    for m in _TICKER_RE.finditer(text or ""):
        sym = m.group(1)
        if sym in universe and sym not in seen:
            found.append(sym)
            seen.add(sym)
    return found[:4]  # cap at 4 to keep prompt small



@app.route("/api/chat", methods=["POST"])
@auth.require_login_api
def api_chat():
    """Agentic multi-turn chat via Gemini function-calling.
    Body: {messages: [{role, content}, ...]}"""
    _ensure_stocks_loaded()
    body     = request.json or {}
    messages = body.get("messages") or []
    if not messages:
        return jsonify({"error": "no messages"}), 400

    api_key = _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return jsonify({"error": "GEMINI_API_KEY not set on server"}), 503

    try:
        from agent import run_agent
        result     = run_agent(messages, _stock_cache, _indices_cache, api_key)
        tickers    = _extract_tickers(result.get("reply", ""))
        tools_used = result.get("tools_used", [])

        chart_data = None
        if "get_market_overview" in tools_used:
            sectors: dict = {}
            for s in _stock_cache:
                sec = s.get("sector")
                chg = s.get("regularMarketChangePercent")
                if sec and chg is not None and not s.get("symbol", "").endswith(".TW"):
                    if sec not in sectors:
                        sectors[sec] = {"total": 0.0, "count": 0}
                    sectors[sec]["total"] += chg
                    sectors[sec]["count"] += 1
            sector_perf = {
                sec: round(v["total"] / v["count"], 2)
                for sec, v in sectors.items() if v["count"] > 0
            }
            chart_data = {"type": "sector", "data": sector_perf}

        return jsonify({
            "reply":      result["reply"],
            "tools_used": tools_used,
            "tickers":    tickers,
            "chart_data": chart_data,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/portfolio")
@auth.require_login
def portfolio_page():
    return render_template("portfolio.html")


@app.route("/api/portfolio-analysis", methods=["POST"])
@auth.require_login_api
def api_portfolio_analysis():
    import pandas as pd
    _ensure_stocks_loaded()
    body        = request.json or {}
    holdings_in = body.get("holdings") or []
    period      = body.get("period", "3mo")

    if not holdings_in:
        return jsonify({"error": "No holdings provided"}), 400

    tickers      = [h["ticker"].upper() for h in holdings_in]
    shares_map   = {h["ticker"].upper(): float(h.get("shares", 1)) for h in holdings_in}
    need_spy     = "SPY" not in tickers
    dl_list      = tickers + (["SPY"] if need_spy else [])

    try:
        raw = yf.download(dl_list, period=period, interval="1d",
                          auto_adjust=True, progress=False)
        if raw.empty:
            return jsonify({"error": "No price data found — check ticker symbols"}), 400

        # Normalise to flat DataFrame of close prices
        if len(dl_list) == 1:
            close = pd.DataFrame({dl_list[0]: raw["Close"]})
        else:
            close = raw["Close"].copy()

        close = close.dropna(how="all").ffill()

        current_prices = close.iloc[-1].to_dict()

        # ── Allocation ────────────────────────────────────────────────────────
        allocation  = []
        total_value = 0.0
        for t in tickers:
            price  = float(current_prices.get(t) or 0)
            shares = shares_map[t]
            value  = price * shares
            total_value += value
            sd = next((s for s in _stock_cache if s.get("symbol") == t), {})
            allocation.append({
                "ticker": t,
                "name":   sd.get("shortName") or sd.get("longName") or t,
                "shares": shares,
                "price":  round(price, 2),
                "value":  round(value, 2),
                "sector": sd.get("sector") or "Unknown",
            })
        for a in allocation:
            a["pct"] = round(a["value"] / total_value * 100, 1) if total_value else 0

        # ── Historical normalised to 100 ──────────────────────────────────────
        historical   = []
        port_vals    = []
        bench_vals   = []
        date_strs    = []

        for dt in close.index:
            pv = 0.0
            ok = True
            for t in tickers:
                if t not in close.columns or pd.isna(close.loc[dt, t]):
                    ok = False; break
                pv += float(close.loc[dt, t]) * shares_map[t]
            if not ok:
                continue
            port_vals.append(pv)
            date_strs.append(str(dt.date()))
            bv = close.loc[dt, "SPY"] if "SPY" in close.columns else None
            bench_vals.append(float(bv) if bv is not None and not pd.isna(bv) else None)

        if port_vals:
            p0 = port_vals[0]
            b0 = next((v for v in bench_vals if v is not None), None)
            for i, d in enumerate(date_strs):
                entry = {"date": d, "portfolio": round(port_vals[i] / p0 * 100, 2)}
                if b0 and bench_vals[i] is not None:
                    entry["benchmark"] = round(bench_vals[i] / b0 * 100, 2)
                historical.append(entry)

        # ── Per-ticker returns ────────────────────────────────────────────────
        ticker_returns = []
        for t in tickers:
            if t in close.columns:
                tc = close[t].dropna()
                if len(tc) >= 2:
                    ret = round((float(tc.iloc[-1]) / float(tc.iloc[0]) - 1) * 100, 2)
                    ticker_returns.append({"ticker": t, "return_pct": ret})
        ticker_returns.sort(key=lambda x: x["return_pct"])

        port_ret  = round(historical[-1]["portfolio"] - 100, 2) if historical else 0
        bench_ret = round(historical[-1].get("benchmark", 100) - 100, 2) if historical else 0

        sectors   = {}
        for a in allocation:
            sectors[a["sector"]] = round(sectors.get(a["sector"], 0) + a["pct"], 1)
        sectors = dict(sorted(sectors.items(), key=lambda x: -x[1]))

        top = max(allocation, key=lambda a: a["pct"]) if allocation else {}
        metrics = {
            "total_value":           round(total_value, 2),
            "portfolio_return_pct":  port_ret,
            "benchmark_return_pct":  bench_ret,
            "alpha":                 round(port_ret - bench_ret, 2),
            "num_stocks":            len(tickers),
            "top_stock":             top.get("ticker", ""),
            "top_concentration_pct": top.get("pct", 0),
            "best_performer":        ticker_returns[-1] if ticker_returns else None,
            "worst_performer":       ticker_returns[0]  if ticker_returns else None,
            "sectors":               sectors,
        }

        # ── Gemini analysis ───────────────────────────────────────────────────
        analysis = ""
        api_key  = _os.environ.get("GEMINI_API_KEY", "")
        if api_key and allocation:
            ret_map = {r["ticker"]: r["return_pct"] for r in ticker_returns}
            holdings_brief = "\n".join(
                f"  {a['ticker']} ({a['name']}) — {a['pct']}% weight, ${a['value']:,.0f}, "
                f"sector: {a['sector']}, return: {ret_map.get(a['ticker'], '?')}%"
                for a in sorted(allocation, key=lambda x: -x["pct"])
            )
            sector_brief = ", ".join(f"{k}: {v}%" for k, v in sectors.items())
            num_sectors  = len(sectors)
            prompt = f"""Analyse this investment portfolio and write a structured report.

PORTFOLIO:
- Total Value: ${total_value:,.2f} across {len(tickers)} stocks
- Period Return: {port_ret:+.1f}% vs SPY {bench_ret:+.1f}% (alpha: {port_ret - bench_ret:+.1f}%)
- Sector Mix: {sector_brief}
- Largest position: {top.get('ticker','')} at {top.get('pct',0):.1f}%

HOLDINGS (by weight):
{holdings_brief}

Output EXACTLY this format — no preamble, start with the verdict line:

**[STRONG / BALANCED / WEAK]** — *one sentence verdict.*

---

### Strengths
- **[metric]**: specific number + why it matters
- **[metric]**: specific number + why it matters

### Risks
- **[risk]**: specific number + why it matters
- **[risk]**: specific number + why it matters

---

### Diversification
| Metric | Assessment |
|---|---|
| Sectors | [{num_sectors} sector{'s' if num_sectors != 1 else ''} — comment on concentration] |
| Largest Position | [{top.get('ticker','')} at {top.get('pct',0):.1f}% — concentrated/balanced] |
| vs Benchmark | [{port_ret - bench_ret:+.1f}% alpha — outperforming/underperforming] |
| Stock Count | [{len(tickers)} stocks — too few/adequate/well spread] |

---

### Recommendation
*One specific, actionable change to improve this portfolio.*

Rules: use only numbers from the data above. Bold metric names in bullets. No hedging."""

            import requests as _req
            gurl  = (f"https://generativelanguage.googleapis.com/v1beta/models/"
                     f"gemini-2.5-flash:generateContent?key={api_key}")
            gbody = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.3, "maxOutputTokens": 1024},
            }
            try:
                gr = _req.post(gurl, json=gbody, timeout=30)
                gr.raise_for_status()
                analysis = gr.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
            except Exception as ex:
                analysis = f"*Analysis unavailable: {ex}*"

        return jsonify({
            "historical":     historical,
            "allocation":     allocation,
            "metrics":        metrics,
            "ticker_returns": ticker_returns,
            "analysis":       analysis,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/quote/<ticker>")
@auth.require_login_api
def api_quote(ticker: str):
    """Real-time quote: Finnhub for US stocks, yfinance fallback. 30s server cache."""
    ticker = ticker.upper()
    now = datetime.utcnow()

    cached = _quote_cache.get(ticker)
    if cached and (now - cached["at"]).total_seconds() < _QUOTE_TTL:
        return jsonify({k: v for k, v in cached.items() if k != "at"})

    cur = prev = None
    source = "yfinance"

    if not ticker.endswith(".TW"):
        api_key = _os.environ.get("FINNHUB_API_KEY", "")
        if api_key:
            try:
                import urllib.request as _ur, json as _js
                url = f"https://finnhub.io/api/v1/quote?symbol={ticker}&token={api_key}"
                with _ur.urlopen(url, timeout=5) as r:
                    d = _js.loads(r.read())
                if d.get("c", 0) > 0:
                    cur, prev, source = d["c"], d.get("pc") or d["c"], "finnhub"
            except Exception:
                pass

    if cur is None:
        cur, prev = _live_quote(ticker)

    if cur is None:
        return jsonify({"error": "No data"}), 404

    prev = prev or cur
    result = {
        "price":      round(cur, 2),
        "prev_close": round(prev, 2),
        "change_pct": round((cur - prev) / prev * 100, 2) if prev else 0,
        "source":     source,
    }
    _quote_cache[ticker] = {**result, "at": now}
    return jsonify(result)


@app.route("/api/screen", methods=["POST"])
@auth.require_login_api
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
@auth.require_login
def stock_page(ticker: str):
    return render_template("stock.html", ticker=ticker.upper())


@app.route("/api/earnings/<ticker>")
@auth.require_login_api
def api_earnings(ticker: str):
    ticker = ticker.upper()
    try:
        t = yf.Ticker(ticker)
        cal = t.calendar
        next_date = None
        if isinstance(cal, dict):
            for key in ("Earnings Date", "earningsDate"):
                if key in cal:
                    dates = cal[key]
                    if hasattr(dates, "__iter__") and not isinstance(dates, str):
                        for d in dates:
                            try:
                                next_date = str(d.date()) if hasattr(d, "date") else str(d)[:10]
                                break
                            except Exception:
                                pass
                    break
        return jsonify({"next_earnings": next_date})
    except Exception:
        return jsonify({"next_earnings": None})


@app.route("/api/insider/<ticker>")
@auth.require_login_api
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
@auth.require_login_api
def api_stock(ticker: str):
    ticker = ticker.upper()
    data = None
    for s in _stock_cache:
        if s.get("symbol") == ticker:
            data = s
            break
    if data is None:
        data = fetch_ticker(ticker, force=False)
    if not data:
        return jsonify({"error": f"No data for {ticker}"}), 404

    # Overlay live price so the header shows the current market price
    # instead of whatever the slow-moving cache held.
    cur, prev = _live_quote(ticker)
    if cur is not None:
        data["currentPrice"] = round(cur, 2)
        if prev and prev > 0:
            data["regularMarketChangePercent"] = round((cur - prev) / prev * 100, 4)
            data["previousClose"] = round(prev, 2)

    data["scores"] = compute_scores(data)
    resp = jsonify(data)
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


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
