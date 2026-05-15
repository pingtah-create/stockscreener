"""
add_popular.py — add popular retail / meme / fintech / EV / China ADR tickers
that aren't in the S&P 500 or NASDAQ 100 but are heavily traded.

Run once:
    python add_popular.py
"""
import json
import time
from pathlib import Path

import yfinance as yf

SEED_FILE = Path("data/stocks.json")

POPULAR = [
    # Meme / retail favourites
    "PLTR", "RBLX", "COIN", "HOOD", "SOFI", "GME", "AMC", "CHWY", "DKNG", "PENN",
    "SNAP", "PINS", "U", "RDDT", "RKLB", "ASTS", "JOBY", "ACHR", "LUNR", "BBAI",
    "SOUN", "PATH", "AI", "TEM", "OSCR", "HIMS",
    # EV / clean energy
    "RIVN", "LCID", "NIO", "XPEV", "LI",
    # China ADRs
    "TSM", "BABA", "JD", "PDD", "BIDU", "NTES", "TME", "BILI",
    # Southeast Asia / LATAM
    "SE", "GRAB", "MELI",
    # Fintech
    "SQ", "XYZ", "AFRM", "UPST", "LMND", "OPEN", "Z", "SHOP",
    # Cloud / software (non-NDX)
    "S", "SNOW", "DDOG", "CRWD", "ZS", "NET", "PANW", "FTNT", "OKTA",
    "MDB", "TEAM", "ZM", "DOCU", "TWLO", "HUBS", "BILL", "GTLB",
    # Semiconductors (non-NDX)
    "MRVL", "MU", "LRCX", "KLAC", "AMAT", "ASML", "ARM", "SMCI", "VRT", "ANET",
    # Biotech / cannabis
    "MRNA", "BNTX", "NVAX", "TDOC", "CGC", "TLRY", "ACB",
    # Shipping / Energy
    "SBLK", "ENPH", "SEDG", "RUN", "PLUG", "BLDP", "FCEL", "RIG",
    # Hedge fund favourites
    "RXRX",
]


def build_entry(sym: str, info: dict) -> dict:
    name = info.get("shortName") or info.get("longName") or sym
    price = info.get("currentPrice") or info.get("previousClose") or info.get("regularMarketPrice")
    return {
        "symbol":                    sym,
        "shortName":                 name,
        "longName":                  info.get("longName") or name,
        "sector":                    info.get("sector") or "",
        "industry":                  info.get("industry") or "",
        "currentPrice":              round(price, 2) if price else None,
        "previousClose":             info.get("previousClose"),
        "regularMarketChangePercent": info.get("regularMarketChangePercent"),
        "marketCap":                 info.get("marketCap"),
        "trailingPE":                info.get("trailingPE"),
        "forwardPE":                 info.get("forwardPE"),
        "priceToBook":               info.get("priceToBook"),
        "pegRatio":                  info.get("pegRatio"),
        "enterpriseToEbitda":        info.get("enterpriseToEbitda"),
        "revenueGrowth":             info.get("revenueGrowth"),
        "earningsGrowth":            info.get("earningsGrowth"),
        "returnOnEquity":            info.get("returnOnEquity"),
        "grossMargins":              info.get("grossMargins"),
        "operatingMargins":          info.get("operatingMargins"),
        "profitMargins":             info.get("profitMargins"),
        "debtToEquity":              info.get("debtToEquity"),
        "currentRatio":              info.get("currentRatio"),
        "beta":                      info.get("beta"),
        "fiftyTwoWeekHigh":          info.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow":           info.get("fiftyTwoWeekLow"),
        "fiftyDayAverage":           info.get("fiftyDayAverage"),
        "twoHundredDayAverage":      info.get("twoHundredDayAverage"),
        "targetMeanPrice":           info.get("targetMeanPrice"),
        "targetLowPrice":            info.get("targetLowPrice"),
        "targetHighPrice":           info.get("targetHighPrice"),
        "recommendationKey":         info.get("recommendationKey"),
        "numberOfAnalystOpinions":   info.get("numberOfAnalystOpinions"),
        "shortRatio":                info.get("shortRatio"),
        "shortPercentOfFloat":       info.get("shortPercentOfFloat"),
        "heldPercentInstitutions":   info.get("heldPercentInstitutions"),
        "heldPercentInsiders":       info.get("heldPercentInsiders"),
        "dividendYield":             info.get("dividendYield"),
        "dividendRate":              info.get("dividendRate"),
        "payoutRatio":               info.get("payoutRatio"),
        "volume":                    info.get("volume"),
        "averageVolume":             info.get("averageVolume"),
        "scores":                    {},
    }


def main():
    existing = json.loads(SEED_FILE.read_text(encoding="utf-8"))
    existing_symbols = {s["symbol"].upper() for s in existing}
    print(f"Existing seed: {len(existing)} stocks")

    to_add = [t for t in POPULAR if t not in existing_symbols]
    print(f"To add: {len(to_add)}")
    if not to_add:
        print("Nothing to add.")
        return

    added = []
    for i, sym in enumerate(to_add, 1):
        try:
            info = yf.Ticker(sym).info
            has_price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
            if not info or not has_price:
                print(f"  [{i}/{len(to_add)}] SKIP {sym} — no price data")
                continue
            entry = build_entry(sym, info)
            added.append(entry)
            print(f"  [{i}/{len(to_add)}] OK {sym} — {entry.get('shortName','?')} | ${entry.get('currentPrice','?')}")
        except Exception as e:
            print(f"  [{i}/{len(to_add)}] SKIP {sym} — {e}")
        if i % 20 == 0:
            time.sleep(1)

    print(f"\nFetched {len(added)} new stocks successfully")
    merged = existing + added
    SEED_FILE.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Saved {len(merged)} total stocks to {SEED_FILE}")


if __name__ == "__main__":
    main()
