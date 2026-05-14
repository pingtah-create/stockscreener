"""
expand_stocks.py — fetch S&P 500 + NASDAQ 100 constituents from FMP,
then bulk-download prices via yfinance and merge into data/stocks.json.

Run once:
    python expand_stocks.py

Adds new tickers only — never overwrites existing entries.
"""
import json
import os
import time
from pathlib import Path

import requests
import yfinance as yf
from dotenv import load_dotenv

load_dotenv()

SEED_FILE = Path("data/stocks.json")


def fetch_constituents() -> list[dict]:
    """Return S&P 500 + NASDAQ 100 tickers scraped from Wikipedia via pandas."""
    import pandas as pd
    import io

    headers = {"User-Agent": "Mozilla/5.0 (stockscreener/1.0)"}

    def scrape(url: str, label: str, sym_col: str, sector_col: str = None) -> list[dict]:
        print(f"Fetching {label} from Wikipedia…")
        r = requests.get(url, timeout=15, headers=headers)
        r.raise_for_status()
        # Find the table that contains sym_col
        dfs = pd.read_html(io.StringIO(r.text))
        df = next((d for d in dfs if sym_col in d.columns), dfs[0])
        rows = []
        for _, row in df.iterrows():
            sym = str(row.get(sym_col, "") or "").strip().replace(".", "-")
            if not sym or not sym.replace("-", "").isalpha():
                continue
            sector = str(row.get(sector_col, "") or "") if sector_col else ""
            rows.append({"symbol": sym, "sector": sector})
        print(f"  Got {len(rows)} tickers")
        return rows

    sp500 = scrape(
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
        "S&P 500", sym_col="Symbol", sector_col="GICS Sector"
    )
    ndx = scrape(
        "https://en.wikipedia.org/wiki/Nasdaq-100",
        "NASDAQ 100", sym_col="Ticker", sector_col="ICB Industry[14]"
    )

    seen = set()
    result = []
    for s in sp500 + ndx:
        sym = s["symbol"]
        if sym and sym not in seen:
            seen.add(sym)
            result.append(s)
    return result


def build_seed_entry(wiki_row: dict, yf_info: dict) -> dict:
    """Merge Wikipedia constituent row with yfinance info into seed format."""
    sym  = (wiki_row.get("symbol") or "").upper()
    name = yf_info.get("shortName") or yf_info.get("longName") or sym

    price = yf_info.get("currentPrice") or yf_info.get("previousClose") or yf_info.get("regularMarketPrice")
    mcap  = yf_info.get("marketCap")

    return {
        "symbol":                    sym,
        "shortName":                 name,
        "longName":                  yf_info.get("longName") or name,
        "sector":                    yf_info.get("sector") or wiki_row.get("sector") or "",
        "industry":                  yf_info.get("industry") or "",
        "currentPrice":              round(price, 2) if price else None,
        "previousClose":             yf_info.get("previousClose"),
        "regularMarketChangePercent": yf_info.get("regularMarketChangePercent"),
        "marketCap":                 mcap,
        "trailingPE":                yf_info.get("trailingPE"),
        "forwardPE":                 yf_info.get("forwardPE"),
        "priceToBook":               yf_info.get("priceToBook"),
        "pegRatio":                  yf_info.get("pegRatio"),
        "enterpriseToEbitda":        yf_info.get("enterpriseToEbitda"),
        "revenueGrowth":             yf_info.get("revenueGrowth"),
        "earningsGrowth":            yf_info.get("earningsGrowth"),
        "returnOnEquity":            yf_info.get("returnOnEquity"),
        "grossMargins":              yf_info.get("grossMargins"),
        "operatingMargins":          yf_info.get("operatingMargins"),
        "profitMargins":             yf_info.get("profitMargins"),
        "debtToEquity":              yf_info.get("debtToEquity"),
        "currentRatio":              yf_info.get("currentRatio"),
        "beta":                      yf_info.get("beta"),
        "fiftyTwoWeekHigh":          yf_info.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow":           yf_info.get("fiftyTwoWeekLow"),
        "fiftyDayAverage":           yf_info.get("fiftyDayAverage"),
        "twoHundredDayAverage":      yf_info.get("twoHundredDayAverage"),
        "targetMeanPrice":           yf_info.get("targetMeanPrice"),
        "targetLowPrice":            yf_info.get("targetLowPrice"),
        "targetHighPrice":           yf_info.get("targetHighPrice"),
        "recommendationKey":         yf_info.get("recommendationKey"),
        "numberOfAnalystOpinions":   yf_info.get("numberOfAnalystOpinions"),
        "shortRatio":                yf_info.get("shortRatio"),
        "shortPercentOfFloat":       yf_info.get("shortPercentOfFloat"),
        "heldPercentInstitutions":   yf_info.get("heldPercentInstitutions"),
        "heldPercentInsiders":       yf_info.get("heldPercentInsiders"),
        "dividendYield":             yf_info.get("dividendYield"),
        "dividendRate":              yf_info.get("dividendRate"),
        "payoutRatio":               yf_info.get("payoutRatio"),
        "volume":                    yf_info.get("volume"),
        "averageVolume":             yf_info.get("averageVolume"),
        "scores":                    {},
    }


def main():
    # Load existing seed
    existing = json.loads(SEED_FILE.read_text(encoding="utf-8"))
    existing_symbols = {s["symbol"] for s in existing}
    print(f"Existing seed: {len(existing)} stocks ({len(existing_symbols)} unique symbols)")

    # Fetch constituent list from FMP
    constituents = fetch_constituents()
    new_symbols = [
        s for s in constituents
        if (s.get("symbol") or "").upper() not in existing_symbols
        and "." not in (s.get("symbol") or "")  # skip non-standard tickers
    ]
    print(f"New tickers to add: {len(new_symbols)}")

    if not new_symbols:
        print("Nothing to add — seed is already up to date.")
        return

    # Fetch yfinance info in batches of 50
    new_entries = []
    batch_size  = 50
    total       = len(new_symbols)

    for i in range(0, total, batch_size):
        batch = new_symbols[i:i + batch_size]
        syms  = [s["symbol"].upper() for s in batch]
        print(f"  Fetching yfinance info for batch {i//batch_size + 1} / {(total-1)//batch_size + 1}: {syms[:5]}…")

        wiki_map = {s["symbol"].upper(): s for s in batch}

        for sym in syms:
            try:
                info = yf.Ticker(sym).info
                if not info or not info.get("regularMarketPrice") and not info.get("currentPrice") and not info.get("previousClose"):
                    print(f"    SKIP {sym} — no price data")
                    continue
                entry = build_seed_entry(wiki_map[sym], info)
                new_entries.append(entry)
                print(f"    OK {sym} — {entry.get('shortName','?')} | ${entry.get('currentPrice','?')} | {entry.get('sector','?')}")
            except Exception as e:
                print(f"    SKIP {sym} — {e}")

        # Be polite to yfinance
        if i + batch_size < total:
            time.sleep(2)

    print(f"\nFetched {len(new_entries)} new stocks successfully")

    # Merge and save
    merged = existing + new_entries
    SEED_FILE.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Saved {len(merged)} total stocks to {SEED_FILE}")
    print(f"Added: {len(new_entries)} | Skipped (no data): {len(new_symbols) - len(new_entries)}")


if __name__ == "__main__":
    main()
