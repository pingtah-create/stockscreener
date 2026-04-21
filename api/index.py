"""Vercel entry point — imports the Flask app from the project root."""
import sys
import os

# Add project root to path so app.py, screener.py etc. can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app  # noqa: F401 — Vercel looks for `app`
