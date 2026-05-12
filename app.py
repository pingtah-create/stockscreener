"""
US Stock Screener — Flask backend
Run: python app.py
"""
import json
import os as _os_top
import base64 as _b64
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from flask import Flask, render_template, jsonify, request, redirect, url_for, session, make_response, Response, stream_with_context

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
_stock_cache_lock = threading.Lock()

_swingscan_cache: dict = {"results": None, "at": None}
_SWINGSCAN_TTL = 120

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
_snapshot_cache: dict = {"data": None, "ts": 0.0}

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
_PORTFOLIO_DIR = Path("/tmp/portfolios") if _IS_SERVERLESS else Path(__file__).parent / "auth" / "portfolios"
_PORTFOLIO_DIR.mkdir(parents=True, exist_ok=True)

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

_GROQ_MODEL = "llama-3.1-8b-instant"
_GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions"


def _groq_complete(prompt: str, *, system: str = "",
                   temperature: float = 0.35, max_tokens: int = 1024) -> str:
    """Call Groq (OpenAI-compatible) with up to 3 retries on 429."""
    import requests as _req, time as _time
    api_key = _os.environ.get("GROQ_API_KEY") or _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise ValueError("GROQ_API_KEY not set")
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    for attempt in range(5):
        r = _req.post(
            _GROQ_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": _GROQ_MODEL, "messages": msgs,
                  "temperature": temperature, "max_tokens": max_tokens},
            timeout=30,
        )
        if r.status_code == 429:
            wait = float(r.headers.get("retry-after", 2 ** (attempt + 1)))
            _time.sleep(wait)  # honour Groq's Retry-After fully
            continue
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    r.raise_for_status()
    return ""


_TICKER_PATTERN = __import__("re").compile(r"^[A-Z0-9]{1,5}(?:\.[A-Z]{1,2})?$")


def _clean_ticker(raw: str) -> str | None:
    """Return uppercased ticker if it looks valid, else None."""
    t = (raw or "").strip().upper()
    return t if _TICKER_PATTERN.match(t) else None


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
        with _stock_cache_lock:
            if not _stock_cache:  # double-checked — only one thread loads
                _stock_cache = _load_all_from_cache()
    if _IS_SERVERLESS:
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
    return render_template("login.html", mode="login", error=error,
                           signup_enabled=auth.signup_enabled(),
                           signup_code_required=bool(auth._signup_code()))


@app.route("/signup", methods=["GET", "POST"])
def signup_page():
    if auth.current_user():
        return redirect(url_for("index"))
    if not auth.signup_enabled():
        return redirect(url_for("login_page"))
    error = None
    if request.method == "POST":
        username    = (request.form.get("username")    or "").strip()
        password    = request.form.get("password")    or ""
        confirm     = request.form.get("confirm")     or ""
        invite_code = request.form.get("invite_code") or ""
        if password != confirm:
            error = "Passwords do not match."
        else:
            ok, msg = auth.create_user(username, password, invite_code)
            if ok:
                auth.login_session(username)
                return redirect(url_for("index"))
            error = msg
    return render_template("login.html", mode="signup", error=error,
                           signup_enabled=auth.signup_enabled(),
                           signup_code_required=bool(auth._signup_code()))


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
    ticker = _clean_ticker(ticker)
    if not ticker:
        return jsonify({"prices": [], "dates": []})
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
    ticker = _clean_ticker(ticker)
    if not ticker:
        return jsonify({"ohlcv": [], "technicals": {}, "error": "invalid ticker"})
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
    ticker = (_clean_ticker(ticker) or "").upper()
    if not ticker:
        return jsonify([])
    try:
        from tools_external import fetch_finnhub_news
        fh = fetch_finnhub_news(ticker, days=14)
        if fh:
            return jsonify(fh)
        # fallback to yfinance
        return jsonify(_parse_news(yf.Ticker(ticker).news, 30))
    except Exception:
        return jsonify([])


@app.route("/api/news-events/<ticker>")
@auth.require_login_api
def api_news_events(ticker: str):
    """AI-identified key price-moving events. Cached 6h."""
    ticker = _clean_ticker(ticker)
    if not ticker:
        return jsonify([])
    p = _INTEL_DIR / f"{ticker}_newsevents.json"
    if p.exists():
        age = (datetime.utcnow() - datetime.utcfromtimestamp(p.stat().st_mtime)).total_seconds()
        if age < 6 * 3600:
            try:
                return jsonify(json.loads(p.read_text()))
            except Exception:
                p.unlink(missing_ok=True)

    api_key = _os.environ.get("GROQ_API_KEY") or _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return jsonify({"error": "GROQ_API_KEY not set"}), 503

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

        import re as _re
        raw = _groq_complete(prompt, system="Respond with valid JSON only.",
                             temperature=0.2, max_tokens=2048)
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
    now = datetime.utcnow()
    if (_swingscan_cache["at"] and
            (now - _swingscan_cache["at"]).total_seconds() < _SWINGSCAN_TTL and
            _swingscan_cache["results"] is not None):
        return jsonify(_swingscan_cache["results"])

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
    top = results[:20]
    _swingscan_cache["results"] = top
    _swingscan_cache["at"] = now
    return jsonify(top)


@app.route("/api/swing/<ticker>")
@auth.require_login_api
def api_swing(ticker: str):
    """AI swing trade setup via Groq. Cached 24h."""
    ticker = _clean_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker"}), 400
    p = _INTEL_DIR / f"{ticker}_swing.json"
    if p.exists():
        age = (datetime.utcnow() - datetime.utcfromtimestamp(p.stat().st_mtime)).total_seconds()
        if age < 86400:
            try:
                return jsonify(json.loads(p.read_text()))
            except Exception:
                p.unlink(missing_ok=True)  # delete corrupt cache, regenerate below

    api_key = _os.environ.get("GROQ_API_KEY") or _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return jsonify({"error": "GROQ_API_KEY not set"}), 503

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
        import re as _re
        text = _groq_complete(prompt, system="Respond with valid JSON only.",
                              temperature=0.2, max_tokens=1024)
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


@app.route("/api/intel/<ticker>")
@auth.require_login_api
def api_intel(ticker: str):
    """AI-generated company intel via Groq. Cached 7 days on disk."""
    ticker = _clean_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker"}), 400
    p = _INTEL_DIR / f"{ticker}.json"

    # Serve from cache if fresh
    if p.exists():
        age = (datetime.utcnow() - datetime.utcfromtimestamp(p.stat().st_mtime)).total_seconds()
        if age < _INTEL_TTL:
            try:
                return jsonify(json.loads(p.read_text()))
            except Exception:
                p.unlink(missing_ok=True)

    api_key = _os.environ.get("GROQ_API_KEY") or _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return jsonify({"error": "GROQ_API_KEY not set"}), 503

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
        import re as _re
        text = _groq_complete(prompt, system="Respond with valid JSON only.",
                              temperature=0.25, max_tokens=2048)
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
    """Streaming SSE chat endpoint.
    Body: {messages: [{role, content}, ...]}
    Yields: text/event-stream with 'chunk' and 'done' events."""
    _ensure_stocks_loaded()
    body     = request.json or {}
    messages = body.get("messages") or []
    if not messages:
        return jsonify({"error": "no messages"}), 400

    api_key = _os.environ.get("GROQ_API_KEY") or _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return jsonify({"error": "GROQ_API_KEY not set on server"}), 503

    import json as _json
    stock_snap   = _stock_cache[:]
    indices_snap = dict(_indices_cache)

    def _build_chart(tools_used):
        if "get_market_overview" not in tools_used:
            return None
        sectors: dict = {}
        for s in stock_snap:
            sec = s.get("sector")
            chg = s.get("regularMarketChangePercent")
            if sec and chg is not None and not s.get("symbol", "").endswith(".TW"):
                if sec not in sectors:
                    sectors[sec] = {"total": 0.0, "count": 0}
                sectors[sec]["total"] += chg
                sectors[sec]["count"] += 1
        return {"type": "sector", "data": {
            sec: round(v["total"] / v["count"], 2)
            for sec, v in sectors.items() if v["count"] > 0
        }}

    def generate():
        from agent import run_agent_stream
        full_text = ""
        try:
            for event in run_agent_stream(messages, stock_snap, indices_snap, api_key):
                if event["type"] == "chunk":
                    full_text += event["text"]
                    yield f"data: {_json.dumps({'type': 'chunk', 'text': event['text']})}\n\n"
                elif event["type"] == "done":
                    tickers    = _extract_tickers(full_text)
                    chart_data = _build_chart(event.get("tools_used", []))
                    yield f"data: {_json.dumps({'type': 'done', 'tools_used': event.get('tools_used', []), 'tickers': tickers, 'chart_data': chart_data})}\n\n"
        except Exception as e:
            yield f"data: {_json.dumps({'type': 'error', 'error': str(e)})}\n\n"

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@app.route("/portfolio")
@auth.require_login
def portfolio_page():
    return render_template("portfolio.html")


_SB_URL = _os_top.environ.get("SUPABASE_URL", "").rstrip("/")
_SB_KEY = _os_top.environ.get("SUPABASE_KEY", "")


def _sb_headers():
    return {
        "apikey": _SB_KEY,
        "Authorization": f"Bearer {_SB_KEY}",
        "Content-Type": "application/json",
    }


def _sb_load(username: str, col: str = "holdings") -> list | None:
    if not _SB_URL or not _SB_KEY:
        return None
    import requests as _req
    try:
        r = _req.get(
            f"{_SB_URL}/rest/v1/portfolios",
            headers={**_sb_headers(), "Accept": "application/json"},
            params={"username": f"eq.{username}", "select": col},
            timeout=5,
        )
        data = r.json()
        if isinstance(data, list) and data:
            return data[0].get(col, [])
    except Exception:
        pass
    return None


def _sb_save(username: str, **cols) -> None:
    if not _SB_URL or not _SB_KEY:
        return
    import requests as _req
    try:
        _req.post(
            f"{_SB_URL}/rest/v1/portfolios",
            headers={**_sb_headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
            json={"username": username, "updated_at": datetime.now(timezone.utc).isoformat(), **cols},
            timeout=5,
        )
    except Exception:
        pass


def _portfolio_path(user: str):
    return _PORTFOLIO_DIR / f"{user}.json"


def _pf_cookie(user: str) -> str:
    return f"pf_{user}"


def _pf_cookie_encode(user: str, holdings: list) -> str:
    """Base64-encode holdings — no secret-key dependency, works across Vercel instances."""
    payload = json.dumps({"u": user, "h": holdings}, separators=(",", ":"))
    return _b64.b64encode(payload.encode()).decode()


def _pf_cookie_load(user: str) -> list | None:
    """Decode the portfolio cookie. Returns holdings list or None."""
    try:
        raw = request.cookies.get(_pf_cookie(user), "")
        if raw:
            data = json.loads(_b64.b64decode(raw).decode())
            if data.get("u") == user and isinstance(data.get("h"), list):
                return data["h"]
    except Exception:
        pass
    return None


@app.route("/api/portfolio/holdings", methods=["GET"])
@auth.require_login_api
def api_portfolio_holdings_get():
    user = auth.current_user()
    # 1. Supabase — reliable cross-device store
    sb_data = _sb_load(user, "holdings")
    if sb_data is not None:
        return jsonify(sb_data)
    # 2. Disk — local dev or warm Vercel instance
    p = _portfolio_path(user)
    if p.exists():
        try:
            data = json.loads(p.read_text())
            if data:
                return jsonify(data)
        except Exception:
            p.unlink(missing_ok=True)
    # 3. Cookie — last resort (survives Vercel cold starts without Supabase)
    cookie_data = _pf_cookie_load(user)
    if cookie_data:
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(cookie_data))
        except Exception:
            pass
        return jsonify(cookie_data)
    return jsonify([])


@app.route("/api/portfolio/holdings", methods=["POST"])
@auth.require_login_api
def api_portfolio_holdings_save():
    user = auth.current_user()
    holdings = request.json
    if not isinstance(holdings, list):
        return jsonify({"error": "expected list"}), 400
    if len(holdings) > 100:
        return jsonify({"error": "portfolio exceeds 100 holdings limit"}), 400
    # Write to all three layers
    _sb_save(user, holdings=holdings)
    try:
        p = _portfolio_path(user)
        p.write_text(json.dumps(holdings))
    except Exception:
        pass
    resp = make_response(jsonify({"ok": True}))
    try:
        resp.set_cookie(_pf_cookie(user), _pf_cookie_encode(user, holdings),
                        max_age=90 * 24 * 3600, httponly=True, samesite="Lax")
    except Exception:
        pass
    return resp


@app.route("/api/watchlist", methods=["GET"])
@auth.require_login_api
def api_watchlist_get():
    user = auth.current_user()
    data = _sb_load(user, "watchlist")
    if data is not None:
        return jsonify(data)
    return jsonify([])


@app.route("/api/watchlist", methods=["POST"])
@auth.require_login_api
def api_watchlist_save():
    user = auth.current_user()
    watchlist = request.json
    if not isinstance(watchlist, list):
        return jsonify({"error": "expected list"}), 400
    _sb_save(user, watchlist=watchlist)
    return jsonify({"ok": True})


@app.route("/api/portfolio/summary", methods=["GET", "POST"])
@auth.require_login_api
def api_portfolio_summary():
    """Live price summary. Client POSTs its holdings so this never depends on
    server-side storage being warm (survives Vercel cold starts cleanly)."""
    _ensure_stocks_loaded()
    # Client always sends holdings in the body — server is just a price fetcher
    body = request.get_json(silent=True) or {}
    holdings = body.get("holdings") or []

    # Fallback: load from disk/cookie for old GET callers
    if not holdings:
        user = auth.current_user()
        p = _portfolio_path(user)
        try:
            holdings = json.loads(p.read_text()) if p.exists() else []
        except Exception:
            holdings = []
        if not holdings:
            cookie_data = _pf_cookie_load(user)
            if cookie_data:
                holdings = cookie_data

    if not holdings:
        return jsonify({"allocation": [], "metrics": {}})

    allocation = []
    total_value = 0.0
    total_cost  = 0.0
    has_cost    = False

    for h in holdings:
        ticker = h.get("ticker", "").upper()
        shares = float(h.get("shares") or 0)
        buyin  = h.get("buyin")
        if not ticker or shares <= 0:
            continue

        data  = next((s for s in _stock_cache if s.get("symbol") == ticker), None)
        price = (data.get("currentPrice") or data.get("previousClose")) if data else None
        if price is None:
            try:
                info  = yf.Ticker(ticker).fast_info
                price = getattr(info, "last_price", None) or getattr(info, "previous_close", None)
            except Exception:
                pass
        if not price:
            continue

        value      = shares * price
        total_value += value
        cost_basis = shares * buyin if buyin else None
        if cost_basis:
            total_cost += cost_basis
            has_cost = True

        unreal     = round(value - cost_basis, 2)    if cost_basis is not None else None
        unreal_pct = round(unreal / cost_basis * 100, 2) if cost_basis and cost_basis > 0 else None
        sector     = (data.get("sector") or "Unknown") if data else "Unknown"
        chg        = (data.get("regularMarketChangePercent") or 0) if data else 0

        allocation.append({
            "ticker":              ticker,
            "shares":              shares,
            "buyin":               buyin,
            "price":               round(price, 2),
            "change_pct":          round(chg, 2),
            "value":               round(value, 2),
            "cost_basis":          round(cost_basis, 2) if cost_basis else None,
            "unrealized_pnl":      unreal,
            "unrealized_pnl_pct":  unreal_pct,
            "sector":              sector,
        })

    for a in allocation:
        a["pct"] = round(a["value"] / total_value * 100, 1) if total_value > 0 else 0

    allocation.sort(key=lambda a: -a["pct"])
    top       = allocation[0] if allocation else {}
    total_pnl = round(total_value - total_cost, 2) if has_cost else None
    total_pnl_pct = round(total_pnl / total_cost * 100, 2) if has_cost and total_cost else None

    return jsonify({
        "allocation": allocation,
        "metrics": {
            "total_value":          round(total_value, 2),
            "total_cost":           round(total_cost, 2) if has_cost else None,
            "total_pnl":            total_pnl,
            "total_pnl_pct":        total_pnl_pct,
            "num_stocks":           len(allocation),
            "top_stock":            top.get("ticker"),
            "top_concentration_pct": top.get("pct"),
        },
    })


@app.route("/api/portfolio/perf", methods=["POST"])
@auth.require_login_api
def api_portfolio_perf():
    """Lightweight portfolio performance chart — no AI. Supports 1d/5d/1mo/3mo/6mo/1y."""
    import pandas as pd
    _ensure_stocks_loaded()
    body        = request.json or {}
    holdings_in = body.get("holdings") or []
    period      = body.get("period", "3mo")
    if not holdings_in:
        return jsonify({"error": "No holdings"}), 400

    tickers    = [h["ticker"].upper() for h in holdings_in]
    shares_map = {h["ticker"].upper(): float(h.get("shares", 1)) for h in holdings_in}
    need_spy   = "SPY" not in tickers
    dl_list    = tickers + (["SPY"] if need_spy else [])
    interval   = "5m" if period == "1d" else ("1h" if period == "5d" else "1d")
    date_fmt   = "%Y-%m-%d %H:%M" if interval in ("5m", "1h") else "%Y-%m-%d"

    try:
        raw = yf.download(dl_list, period=period, interval=interval,
                          auto_adjust=True, progress=False)
        if raw.empty:
            return jsonify({"error": "No price data"}), 400
        close = (pd.DataFrame({dl_list[0]: raw["Close"]}) if len(dl_list) == 1
                 else raw["Close"].copy())
        close = close.dropna(how="all").ffill()

        port_vals, spy_vals, dates = [], [], []
        for dt in close.index:
            pv, ok = 0.0, True
            for t in tickers:
                if t not in close.columns or pd.isna(close.loc[dt, t]):
                    ok = False; break
                pv += float(close.loc[dt, t]) * shares_map[t]
            if not ok:
                continue
            port_vals.append(pv)
            dates.append(dt.strftime(date_fmt))
            bv = close.loc[dt, "SPY"] if "SPY" in close.columns else None
            spy_vals.append(float(bv) if bv is not None and not pd.isna(bv) else None)

        if not port_vals:
            return jsonify({"error": "Not enough data"}), 400

        p0 = port_vals[0]
        b0 = next((v for v in spy_vals if v is not None), None)
        historical = []
        for i, d in enumerate(dates):
            entry = {"date": d, "value": round(port_vals[i], 2),
                     "pct": round((port_vals[i] / p0 - 1) * 100, 2) if p0 else 0}
            if b0 and spy_vals[i] is not None:
                entry["spy_pct"] = round((spy_vals[i] / b0 - 1) * 100, 2)
            historical.append(entry)

        total = round(port_vals[-1], 2)
        pnl   = round(port_vals[-1] - p0, 2)
        return jsonify({"historical": historical, "total_value": total,
                        "period_pnl": pnl, "period_pnl_pct": round(pnl / p0 * 100, 2) if p0 else 0})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
    buyin_map    = {h["ticker"].upper(): float(h["buyin"]) for h in holdings_in if h.get("buyin")}
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
        allocation   = []
        total_value  = 0.0
        total_cost   = 0.0
        for t in tickers:
            price  = float(current_prices.get(t) or 0)
            shares = shares_map[t]
            buyin  = buyin_map.get(t)
            value  = price * shares
            total_value += value
            cost_basis       = round(buyin * shares, 2) if buyin else None
            unrealized_pnl   = round(value - cost_basis, 2) if cost_basis else None
            unrealized_pnl_pct = round((price - buyin) / buyin * 100, 2) if buyin and buyin > 0 else None
            if cost_basis:
                total_cost += cost_basis
            sd = next((s for s in _stock_cache if s.get("symbol") == t), {})
            allocation.append({
                "ticker":            t,
                "name":              sd.get("shortName") or sd.get("longName") or t,
                "shares":            shares,
                "buyin":             buyin,
                "price":             round(price, 2),
                "value":             round(value, 2),
                "cost_basis":        cost_basis,
                "unrealized_pnl":    unrealized_pnl,
                "unrealized_pnl_pct": unrealized_pnl_pct,
                "sector":            sd.get("sector") or "Unknown",
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

        top        = max(allocation, key=lambda a: a["pct"]) if allocation else {}
        has_cost   = total_cost > 0
        total_pnl  = round(total_value - total_cost, 2) if has_cost else None
        total_pnl_pct = round((total_value - total_cost) / total_cost * 100, 2) if has_cost and total_cost > 0 else None
        metrics = {
            "total_value":           round(total_value, 2),
            "total_cost":            round(total_cost, 2) if has_cost else None,
            "total_pnl":             total_pnl,
            "total_pnl_pct":         total_pnl_pct,
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

        # ── Groq analysis ─────────────────────────────────────────────────────
        analysis = ""
        if (_os.environ.get("GROQ_API_KEY") or _os.environ.get("GEMINI_API_KEY")) and allocation:
            ret_map = {r["ticker"]: r["return_pct"] for r in ticker_returns}
            def _holding_line(a):
                line = (f"  {a['ticker']} ({a['name']}) — {a['pct']}% weight, ${a['value']:,.0f}, "
                        f"sector: {a['sector']}, period return: {ret_map.get(a['ticker'], '?')}%")
                if a.get("buyin") and a.get("unrealized_pnl") is not None:
                    line += (f", avg cost ${a['buyin']:.2f}, "
                             f"unrealized P&L ${a['unrealized_pnl']:+,.0f} ({a['unrealized_pnl_pct']:+.1f}%)")
                return line
            holdings_brief = "\n".join(
                _holding_line(a) for a in sorted(allocation, key=lambda x: -x["pct"])
            )
            sector_brief = ", ".join(f"{k}: {v}%" for k, v in sectors.items())
            num_sectors  = len(sectors)
            prompt = f"""Analyse this investment portfolio and write a structured report.

PORTFOLIO:
- Total Value: ${total_value:,.2f} across {len(tickers)} stocks{f" | Cost Basis ${total_cost:,.2f} | Unrealized P&L ${total_pnl:+,.2f} ({total_pnl_pct:+.1f}%)" if has_cost else ""}
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

            try:
                analysis = _groq_complete(prompt, temperature=0.3, max_tokens=1024)
            except Exception as ex:
                msg = str(ex)
                if "429" in msg:
                    return jsonify({"error": "rate_limited",
                                    "message": "Groq rate limit hit — wait a minute and try again."}), 429
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
    ticker = (_clean_ticker(ticker) or "").upper()
    if not ticker:
        return jsonify([])
    try:
        from tools_external import fetch_finnhub_insider
        fh = fetch_finnhub_insider(ticker)
        if fh:
            rows = []
            _code_map = {"P": "Buy", "S": "Sell", "A": "Grant", "D": "Disposition",
                         "G": "Gift", "F": "Tax", "M": "Exercise"}
            for t in fh:
                code = t.get("transaction_code", "")
                rows.append({
                    "date":     t.get("date", ""),
                    "name":     t.get("name", ""),
                    "position": "",
                    "type":     _code_map.get(code, code),
                    "shares":   abs(int(t.get("change") or 0)),
                    "value":    round(abs(t.get("change") or 0) * (t.get("transaction_price") or 0), 2) or None,
                })
            rows.sort(key=lambda x: x["date"], reverse=True)
            if rows:
                return jsonify(rows)
    except Exception:
        pass
    # fallback: yfinance
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
            rows.append({
                "date":     str(date_raw)[:10],
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


@app.route("/api/filings/<ticker>")
@auth.require_login_api
def api_filings(ticker: str):
    """EDGAR SEC filings for a ticker. Cached 1h."""
    ticker = _clean_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker"}), 400
    if ticker.endswith(".TW"):
        return jsonify({"filings": [], "note": "SEC filings not available for Taiwan stocks"})
    from tools_external import fetch_sec_filings
    return jsonify(fetch_sec_filings(ticker))


@app.route("/api/filings-summary/<ticker>")
@auth.require_login_api
def api_filings_summary(ticker: str):
    """AI summary of recent SEC filings. Cached 6h."""
    ticker = _clean_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker"}), 400

    p = _INTEL_DIR / f"{ticker}_filings_summary.json"
    if p.exists():
        age = (datetime.utcnow() - datetime.utcfromtimestamp(p.stat().st_mtime)).total_seconds()
        if age < 6 * 3600:
            try:
                return jsonify(json.loads(p.read_text()))
            except Exception:
                p.unlink(missing_ok=True)

    api_key = _os.environ.get("GROQ_API_KEY") or _os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return jsonify({"error": "GROQ_API_KEY not set"}), 503

    from tools_external import fetch_sec_filings, fetch_filing_text
    data = fetch_sec_filings(ticker)
    filings = data.get("filings", [])
    if not filings:
        return jsonify({"error": "No filings found for this ticker"})

    company = data.get("company", ticker)

    # Fetch text for up to 3 most recent 8-Ks + reference the 10-K/10-Q dates
    sections = []
    eightk_count = 0
    for f in filings:
        if f["form"] == "8-K" and eightk_count < 3:
            text = fetch_filing_text(f["url"], max_chars=3000)
            sections.append(f"### 8-K filed {f['date']}\n{text}")
            eightk_count += 1
        elif f["form"] in ("10-K", "10-Q") and len(sections) < 5:
            sections.append(f"### {f['form']} filed {f['date']} — {f.get('desc','')}")

    if not sections:
        sections = [f"### {f['form']} filed {f['date']}" for f in filings[:5]]

    combined = "\n\n".join(sections)
    prompt = f"""You are a financial analyst. Summarize the following SEC filings for {company} ({ticker}) in plain English for a retail investor.

FILINGS:
{combined}

Write a clear, concise summary (3-5 bullet points) covering:
- What material events were disclosed (acquisitions, earnings, guidance, leadership changes, legal issues)
- Any risks or red flags mentioned
- Overall tone: is the company in a strong or concerning position based on these filings?

Format as bullet points. Be specific — use numbers and names from the filings. No preamble."""

    try:
        summary = _groq_complete(prompt, temperature=0.2, max_tokens=600)
        result = {"ticker": ticker, "company": company, "summary": summary,
                  "filing_count": len(filings)}
        try:
            p.write_text(json.dumps(result))
        except Exception:
            pass
        return jsonify(result)
    except Exception as ex:
        if "429" in str(ex):
            return jsonify({"error": "rate_limited", "message": "Rate limit hit — try again in a minute"}), 429
        return jsonify({"error": str(ex)}), 500


@app.route("/api/fmp/<ticker>")
@auth.require_login_api
def api_fmp(ticker: str):
    """FMP income statements + TTM ratios. Cached 24h."""
    ticker = _clean_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker"}), 400
    from tools_external import fetch_fmp_income, fetch_fmp_ratios
    return jsonify({
        "income": fetch_fmp_income(ticker),
        "ratios": fetch_fmp_ratios(ticker),
    })


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


# ── Market Snapshot ───────────────────────────────────────────────────────────

def _calc_fg(vix: float) -> tuple[int, str]:
    score = max(5, min(95, int(100 - (vix - 10) * 3.0)))
    if score >= 75: label = "Extreme Greed"
    elif score >= 55: label = "Greed"
    elif score >= 45: label = "Neutral"
    elif score >= 25: label = "Fear"
    else: label = "Extreme Fear"
    return score, label


@app.route("/api/market-snapshot")
@auth.require_login_api
def api_market_snapshot():
    import time as _t
    if _snapshot_cache["data"] and _t.time() - _snapshot_cache["ts"] < 3600:
        return jsonify(_snapshot_cache["data"])

    idx = _indices_cache or {}
    vix    = (idx.get("VIX")    or {}).get("price") or 20.0
    sp500  = idx.get("SP500")   or {}
    nasdaq = idx.get("NASDAQ")  or {}
    dow    = idx.get("DOW")     or {}
    fg_score, fg_label = _calc_fg(float(vix))

    headline  = "Markets in Focus"
    narrative = "Equities are trading on mixed signals as investors weigh macro data and earnings results."
    bullets   = [
        "Monitor key economic data releases this week",
        "Earnings season drives individual stock moves",
        "Watch sector rotation for positioning clues",
        "Fed commentary remains the key macro driver",
    ]

    api_key = _os.environ.get("GROQ_API_KEY") or _os.environ.get("GEMINI_API_KEY", "")
    if api_key:
        try:
            import requests as _req, re as _re
            prompt = (
                f"Market data right now: VIX={vix:.1f} ({fg_label}), "
                f"S&P 500 {sp500.get('change_pct', 0):+.2f}%, "
                f"NASDAQ {nasdaq.get('change_pct', 0):+.2f}%, "
                f"DOW {dow.get('change_pct', 0):+.2f}%.\n\n"
                "Write a brief market snapshot. Return ONLY valid JSON with no extra text:\n"
                '{"headline":"6-8 word headline","narrative":"2 sentences on what\'s driving markets",'
                '"bullets":["bullet1","bullet2","bullet3","bullet4"]}'
            )
            r = _req.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"model": "llama-3.1-8b-instant",
                      "messages": [{"role": "user", "content": prompt}],
                      "temperature": 0.5, "max_tokens": 350},
                timeout=8,
            )
            txt = r.json()["choices"][0]["message"]["content"]
            m = _re.search(r'\{.*\}', txt, _re.S)
            if m:
                parsed = json.loads(m.group())
                headline  = parsed.get("headline", headline)
                narrative = parsed.get("narrative", narrative)
                bullets   = parsed.get("bullets", bullets)[:4]
        except Exception:
            pass

    result = {
        "headline": headline, "narrative": narrative, "bullets": bullets,
        "fg_score": fg_score, "fg_label": fg_label,
        "indices": {
            "VIX":    {"price": vix,                        "change_pct": (idx.get("VIX")    or {}).get("change_pct", 0)},
            "SP500":  {"price": sp500.get("price"),          "change_pct": sp500.get("change_pct", 0)},
            "NASDAQ": {"price": nasdaq.get("price"),         "change_pct": nasdaq.get("change_pct", 0)},
        },
        "generated_at": datetime.utcnow().strftime("%H:%M UTC"),
    }
    _snapshot_cache["data"] = result
    _snapshot_cache["ts"] = _t.time()
    return jsonify(result)


@app.route("/api/trending")
@auth.require_login_api
def api_trending():
    _ensure_stocks_loaded()
    us = [s for s in _stock_cache
          if not str(s.get("symbol", "")).endswith(".TW") and s.get("symbol")]

    def _score(s):
        chg = abs(s.get("regularMarketChangePercent") or 0)
        vol  = s.get("regularMarketVolume") or 0
        avg  = s.get("averageVolume") or 1
        vol_ratio = min(5.0, vol / max(avg, 1))
        return chg * (1 + vol_ratio)

    top = sorted(us, key=_score, reverse=True)[:10]
    return jsonify([{
        "rank":       i + 1,
        "ticker":     s.get("symbol"),
        "name":       (s.get("shortName") or s.get("longName") or s.get("symbol", ""))[:28],
        "price":      round(float(s.get("currentPrice") or s.get("regularMarketPrice") or 0), 2),
        "change_pct": round(float(s.get("regularMarketChangePercent") or 0), 2),
    } for i, s in enumerate(top)])


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
