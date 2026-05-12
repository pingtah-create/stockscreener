"""
Auth module — user storage priority:
  1. Supabase (persistent, cross-device) — used when SUPABASE_URL + SUPABASE_KEY are set
  2. AUTH_USERS env var (backwards-compat for existing Vercel deployments)
  3. Flat-file auth/users.json (local dev fallback)

Signup requires SIGNUP_CODE env var to be set. Share that code with
people you want to invite — they enter it on the signup page.
"""
import json
import os
import re
import secrets
from datetime import datetime
from functools import wraps
from pathlib import Path

import requests as _req
from flask import session, redirect, url_for, request, jsonify
from werkzeug.security import generate_password_hash, check_password_hash

_IS_SERVERLESS = bool(os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"))
_AUTH_DIR  = Path("/tmp/auth") if _IS_SERVERLESS else Path("auth")
_AUTH_DIR.mkdir(parents=True, exist_ok=True)
_USERS_FILE  = _AUTH_DIR / "users.json"
_SECRET_FILE = _AUTH_DIR / "secret.key"

USERNAME_RE   = re.compile(r"^[a-zA-Z0-9_.-]{3,32}$")
MIN_PASSWORD_LEN = 6

_SB_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
_SB_KEY = os.environ.get("SUPABASE_KEY", "")


def _signup_code() -> str:
    return os.environ.get("SIGNUP_CODE", "")

# ── Supabase user helpers ─────────────────────────────────────────────────────

def _sb_available() -> bool:
    return bool(_SB_URL and _SB_KEY)


def _sb_auth_headers() -> dict:
    return {
        "apikey": _SB_KEY,
        "Authorization": f"Bearer {_SB_KEY}",
        "Content-Type": "application/json",
    }


def _sb_get_user(username: str) -> dict | None:
    if not _sb_available():
        return None
    try:
        r = _req.get(
            f"{_SB_URL}/rest/v1/users",
            headers={**_sb_auth_headers(), "Accept": "application/json"},
            params={"username": f"eq.{username}", "select": "username,password_hash"},
            timeout=5,
        )
        data = r.json()
        if isinstance(data, list) and data:
            return data[0]
    except Exception:
        pass
    return None


def _sb_create_user(username: str, password_hash: str) -> bool:
    if not _sb_available():
        return False
    try:
        r = _req.post(
            f"{_SB_URL}/rest/v1/users",
            headers={**_sb_auth_headers(), "Prefer": "return=minimal"},
            json={
                "username": username,
                "password_hash": password_hash,
                "created_at": datetime.utcnow().isoformat() + "Z",
            },
            timeout=5,
        )
        return r.status_code in (200, 201)
    except Exception:
        return False


def _sb_username_taken(username: str) -> bool:
    return _sb_get_user(username) is not None

# ── Env-var user table (parsed once at import) ────────────────────────────────

_ENV_USERS: dict[str, str] = {}

def _parse_env_users():
    raw = os.environ.get("AUTH_USERS", "").strip()
    if not raw:
        return
    for pair in raw.split(","):
        pair = pair.strip()
        if ":" not in pair:
            continue
        user, pwd = pair.split(":", 1)
        user = user.strip().lower()
        pwd  = pwd.strip()
        if user and pwd:
            _ENV_USERS[user] = generate_password_hash(pwd)

_parse_env_users()

# ── Flat-file helpers (local dev) ─────────────────────────────────────────────

def _load() -> dict:
    if not _USERS_FILE.exists():
        return {}
    try:
        return json.loads(_USERS_FILE.read_text())
    except Exception:
        return {}


def _save(users: dict):
    _USERS_FILE.write_text(json.dumps(users, indent=2))

# ── Public API ────────────────────────────────────────────────────────────────

def init_app(app):
    from datetime import timedelta as _td
    key = os.environ.get("FLASK_SECRET_KEY")
    if not key:
        if _SECRET_FILE.exists():
            key = _SECRET_FILE.read_text().strip()
        else:
            key = secrets.token_hex(32)
            try:
                _SECRET_FILE.write_text(key)
            except OSError:
                pass
    app.secret_key = key
    app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
    app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")
    app.permanent_session_lifetime = _td(days=30)


def signup_enabled() -> bool:
    """Signup is open when SIGNUP_CODE is set (or in local dev)."""
    return bool(_signup_code()) or not _IS_SERVERLESS


def user_count() -> int:
    return len(_load()) + len(_ENV_USERS)


def create_user(username: str, password: str, invite_code: str = "") -> tuple[bool, str]:
    username = (username or "").strip().lower()
    if not USERNAME_RE.match(username):
        return False, "Username must be 3–32 chars, letters/numbers/._- only."
    if not password or len(password) < MIN_PASSWORD_LEN:
        return False, f"Password must be at least {MIN_PASSWORD_LEN} characters."

    # Invite code check
    code = _signup_code()
    if code and invite_code.strip() != code:
        return False, "Invalid invite code."

    password_hash = generate_password_hash(password)

    # Try Supabase first
    if _sb_available():
        if _sb_username_taken(username):
            return False, "Username already taken."
        ok = _sb_create_user(username, password_hash)
        if not ok:
            return False, "Could not create account — please try again."
        return True, "Account created."

    # Flat-file fallback (local dev)
    users = _load()
    if username in users or username in _ENV_USERS:
        return False, "Username already taken."
    users[username] = {
        "password_hash": password_hash,
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    _save(users)
    return True, "Account created."


def verify_user(username: str, password: str) -> bool:
    username = (username or "").strip().lower()

    # 1. Supabase
    if _sb_available():
        rec = _sb_get_user(username)
        if rec:
            return check_password_hash(rec.get("password_hash", ""), password or "")
        # Fall through to env/file for legacy accounts

    # 2. Env-var users (backwards compat)
    if username in _ENV_USERS:
        return check_password_hash(_ENV_USERS[username], password or "")

    # 3. Flat-file (local dev)
    users = _load()
    rec = users.get(username)
    if not rec:
        return False
    return check_password_hash(rec.get("password_hash", ""), password or "")


def login_session(username: str):
    session.clear()
    session["user"] = username.strip().lower()
    session.permanent = True


def logout_session():
    session.clear()


def current_user():
    return session.get("user")


def require_login(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not current_user():
            return redirect(url_for("login_page", next=request.path))
        return view(*args, **kwargs)
    return wrapper


def require_login_api(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not current_user():
            return jsonify({"error": "auth required"}), 401
        return view(*args, **kwargs)
    return wrapper
