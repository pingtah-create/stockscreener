"""
Smoke test for Stockdash — verifies every page renders and every key API
endpoint responds before a deploy. Run with the dev server NOT already up;
this script starts its own server, runs the checks, and shuts it down.

    python test_smoke.py

Exit code 0 = all passed, 1 = something failed.
"""
import subprocess
import sys
import time
import json
import os
import urllib.request
import urllib.error
import http.cookiejar

BASE = "http://127.0.0.1:5000"
TEST_USER = "qatest"
TEST_PASS = "qatest12345"

# ANSI colors (skipped if not a tty)
_tty = sys.stdout.isatty()
def _c(code, s): return f"\033[{code}m{s}\033[0m" if _tty else s
def green(s): return _c("32", s)
def red(s):   return _c("31", s)
def dim(s):   return _c("2", s)

results = []  # (name, ok, detail)

def record(name, ok, detail=""):
    results.append((name, ok, detail))
    mark = green("PASS") if ok else red("FAIL")
    print(f"  [{mark}] {name}" + (f"  {dim(detail)}" if detail else ""), flush=True)


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj


def req(opener, path, method="GET", data=None, timeout=45):
    """Return (status, body_text). Never raises — errors become (status, '')."""
    url = BASE + path
    headers = {}
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with opener.open(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, f"<exception: {e}>"


def req_form(opener, path, form, timeout=20):
    """POST application/x-www-form-urlencoded (for login/signup)."""
    import urllib.parse
    body = urllib.parse.urlencode(form).encode()
    r = urllib.request.Request(BASE + path, data=body, method="POST")
    try:
        with opener.open(r, timeout=timeout) as resp:
            return resp.status, resp.geturl()
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, f"<exception: {e}>"


def ensure_test_user(opener):
    """Sign up the test user (idempotent — login works if it already exists)."""
    code = os.environ.get("SIGNUP_CODE", "")
    form = {"username": TEST_USER, "password": TEST_PASS,
            "confirm": TEST_PASS, "password2": TEST_PASS}
    if code:
        form["code"] = code
        form["invite_code"] = code
    req_form(opener, "/signup", form)
    # Always (re)login to be sure we have a session
    status, _ = req_form(opener, "/login", {"username": TEST_USER, "password": TEST_PASS})
    return status in (200, 302)


def page_ok(body):
    """A rendered HTML page is OK if it has no server error markers."""
    low = body.lower()
    for marker in ("traceback (most recent call last)",
                   "jinja2.exceptions", "werkzeug.exceptions",
                   "internal server error"):
        if marker in low:
            return False, f"contains '{marker}'"
    return True, ""


def main():
    # ── Start the server ───────────────────────────────────────────────
    # Server output goes to a log FILE, not a pipe — an un-drained pipe
    # fills its OS buffer (~64KB) and blocks/hangs the server mid-test.
    print(dim("Starting dev server…"))
    env = dict(os.environ)
    srv_log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "test_server.log")
    srv_log = open(srv_log_path, "w", encoding="utf-8")
    srv = subprocess.Popen(
        [sys.executable, "app.py"],
        stdout=srv_log, stderr=subprocess.STDOUT,
        env=env, cwd=os.path.dirname(os.path.abspath(__file__)),
    )
    try:
        # Wait for it to come up
        opener, _ = make_opener()
        up = False
        for _ in range(30):
            time.sleep(1)
            try:
                with opener.open(BASE + "/login", timeout=3) as r:
                    if r.status == 200:
                        up = True
                        break
            except Exception:
                pass
        if not up:
            print(red("Server did not start within 30s."))
            return 1
        print(dim("Server up.\n"))

        # ── Auth ───────────────────────────────────────────────────────
        print("AUTH")
        record("login as test user", ensure_test_user(opener))

        # ── Pages ──────────────────────────────────────────────────────
        print("\nPAGES")
        pages = ["/", "/dashboard", "/portfolio", "/journal",
                 "/stock/NVDA", "/about", "/disclaimer"]
        for p in pages:
            status, body = req(opener, p, timeout=30)
            ok, why = page_ok(body) if status == 200 else (False, f"HTTP {status}")
            record(f"GET {p}", status == 200 and ok, why or f"HTTP {status}")

        # ── GET API endpoints ──────────────────────────────────────────
        print("\nAPI (GET)")
        # (path, validator, timeout) — /api/movers does a cold yf.download so it
        # needs a generous timeout on the first run.
        get_apis = [
            ("/api/trending",        lambda b: isinstance(json.loads(b), list), 45),
            ("/api/market-snapshot", lambda b: "fg_score" in json.loads(b), 45),
            ("/api/stockmap",        lambda b: isinstance(json.loads(b), list), 60),
            ("/api/movers",          lambda b: "gainers" in json.loads(b), 90),
            ("/api/heatmap",         lambda b: isinstance(json.loads(b), dict), 45),
            ("/api/watchlist",       lambda b: isinstance(json.loads(b), list), 45),
            ("/api/portfolio/holdings", lambda b: isinstance(json.loads(b), list), 45),
            ("/api/swingscan",       lambda b: isinstance(json.loads(b), list), 60),
            ("/api/chart/NVDA",      lambda b: isinstance(json.loads(b), dict), 60),
        ]
        for path, validate, tmo in get_apis:
            status, body = req(opener, path, timeout=tmo)
            ok = status == 200
            detail = f"HTTP {status}"
            if ok:
                try:
                    ok = validate(body)
                    detail = "shape OK" if ok else "unexpected JSON shape"
                except Exception as e:
                    ok, detail = False, f"bad JSON: {e}"
            record(f"GET {path}", ok, detail)

        # ── POST API endpoints ─────────────────────────────────────────
        print("\nAPI (POST)")
        # portfolio summary
        status, body = req(opener, "/api/portfolio/summary", "POST",
                            {"holdings": [{"ticker": "NVDA", "shares": 10, "buyin": 100}]})
        ok = status == 200
        try:
            ok = ok and "metrics" in json.loads(body)
        except Exception:
            ok = False
        record("POST /api/portfolio/summary", ok, f"HTTP {status}")

        # screen (ticker universe)
        status, body = req(opener, "/api/screen", "POST",
                            {"filters": {}, "page": 1, "per_page": 5})
        ok = status == 200
        try:
            ok = ok and "results" in json.loads(body)
        except Exception:
            ok = False
        record("POST /api/screen", ok, f"HTTP {status}")

        # quotes (watchlist batch)
        status, body = req(opener, "/api/quotes", "POST",
                            {"tickers": ["NVDA", "AAPL"]}, timeout=45)
        ok = status == 200
        try:
            ok = ok and isinstance(json.loads(body), list)
        except Exception:
            ok = False
        record("POST /api/quotes", ok, f"HTTP {status}")

        # ── Static assets ──────────────────────────────────────────────
        print("\nSTATIC ASSETS")
        assets = ["/static/style.css", "/static/theme.js",
                  "/static/chat-home.css", "/static/chat.js",
                  "/static/chart.css", "/static/chart.js",
                  "/static/portfolio.css", "/static/portfolio.js",
                  "/static/journal.css", "/static/stock-map.js",
                  "/static/app.js"]
        for a in assets:
            status, body = req(opener, a, timeout=10)
            record(f"GET {a}", status == 200 and len(body) > 0, f"HTTP {status}, {len(body)}b")

        # ── Theme tokens present ───────────────────────────────────────
        print("\nDESIGN SYSTEM")
        _, css = req(opener, "/static/style.css", timeout=10)
        record("style.css has light theme", 'data-theme="light"' in css)
        record("style.css has TradingView tokens", "#131722" in css and "#0e1015" in css)
        _, tjs = req(opener, "/static/theme.js", timeout=10)
        record("theme.js has toggle logic", "setStockdashTheme" in tjs and "themechange" in tjs)

    finally:
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except Exception:
            srv.kill()
        try:
            srv_log.close()
        except Exception:
            pass

    # ── Summary ────────────────────────────────────────────────────────
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print("\n" + "=" * 50)
    if passed == total:
        print(green(f"  ALL {total} CHECKS PASSED"))
        print("=" * 50)
        return 0
    else:
        print(red(f"  {total - passed} / {total} CHECKS FAILED"))
        for name, ok, detail in results:
            if not ok:
                print(red(f"    - {name}: {detail}"))
        print("=" * 50)
        return 1


if __name__ == "__main__":
    sys.exit(main())
