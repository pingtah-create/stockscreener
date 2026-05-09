"""One-off: pull Taiwan tickers and add them to data/stocks.json so the
stock map shows them. Run once: `python fetch_taiwan.py`."""
import json
from pathlib import Path
from screener import fetch_batch, compute_scores
from stock_list import TAIWAN

print(f"Fetching {len(TAIWAN)} Taiwan tickers from Yahoo Finance...")
data = fetch_batch(TAIWAN, force=True)
print(f"  Got {len(data)} stocks back.")

for d in data:
    d["scores"] = compute_scores(d)

# Merge into the seed file so cold-start has them too.
seed_path = Path("data/stocks.json")
if seed_path.exists():
    existing = json.loads(seed_path.read_text())
    by_sym = {s.get("symbol"): s for s in existing}
    for d in data:
        by_sym[d["symbol"]] = d
    merged = list(by_sym.values())
else:
    merged = data

seed_path.write_text(json.dumps(merged))
print(f"  Wrote {len(merged)} total stocks to {seed_path}")
print("  Restart the server (or wait for next refresh) to see them.")
