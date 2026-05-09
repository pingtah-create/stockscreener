"""
Auth module: flat-file users.json + Flask session cookies.
Werkzeug ships with Flask so no new deps.
"""
import json
import os
import re
import secrets
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import session, redirect, url_for, request, jsonify, flash
from werkzeug.security import generate_password_hash, check_password_hash

_IS_SERVERLESS = bool(os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"))
_AUTH_DIR = Path("/tmp/auth") if _IS_SERVERLESS else Path("auth")
_AUTH_DIR.mkdir(parents=True, exist_ok=True)
_USERS_FILE = _AUTH_DIR / "users.json"
_SECRET_FILE = _AUTH_DIR / "secret.key"

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.-]{3,32}$")
MIN_PASSWORD_LEN = 6


def init_app(app):
    """Wire the secret key into a Flask app. Reads FLASK_SECRET_KEY env var,
    falls back to a persisted file, generates one on first run."""
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


def _load() -> dict:
    if not _USERS_FILE.exists():
        return {}
    try:
        return json.loads(_USERS_FILE.read_text())
    except Exception:
        return {}


def _save(users: dict):
    _USERS_FILE.write_text(json.dumps(users, indent=2))


def user_count() -> int:
    return len(_load())


def create_user(username: str, password: str) -> tuple[bool, str]:
    """Return (ok, message). Username case-insensitive, stored lowercase."""
    username = (username or "").strip().lower()
    if not USERNAME_RE.match(username):
        return False, "Username must be 3-32 chars, letters/numbers/._- only."
    if not password or len(password) < MIN_PASSWORD_LEN:
        return False, f"Password must be at least {MIN_PASSWORD_LEN} characters."
    users = _load()
    if username in users:
        return False, "Username already taken."
    users[username] = {
        "password_hash": generate_password_hash(password),
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    _save(users)
    return True, "Account created."


def verify_user(username: str, password: str) -> bool:
    username = (username or "").strip().lower()
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
    """For HTML pages — redirect anonymous users to /login."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not current_user():
            return redirect(url_for("login_page", next=request.path))
        return view(*args, **kwargs)
    return wrapper


def require_login_api(view):
    """For JSON APIs — return 401 instead of redirecting."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not current_user():
            return jsonify({"error": "auth required"}), 401
        return view(*args, **kwargs)
    return wrapper
