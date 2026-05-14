"""
portfolio_agent.py — parallel per-stock analysis for portfolio deep-dive.

analyze_portfolio() is called by /api/portfolio-analysis in app.py.
It runs run_debate_analysis() for each holding in parallel (up to 5 at a time),
then asks Groq to synthesize a portfolio-level verdict from all results.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed


def analyze_portfolio(holdings: list, allocation: list, metrics: dict,
                      stock_cache: list, indices_cache: dict, api_key: str,
                      skip_stock_analyses: bool = False) -> dict:
    """
    Run per-stock analysis in parallel, then synthesize a portfolio verdict.

    Args:
        holdings:      [{"ticker": str, ...}] from the request body
        allocation:    pre-computed allocation list from api_portfolio_analysis
        metrics:       pre-computed metrics dict from api_portfolio_analysis
        stock_cache:   _stock_cache from app.py
        indices_cache: _indices_cache from app.py
        api_key:       Groq API key

    Returns:
        {
            "stock_analyses": {ticker: markdown_str, ...},
            "portfolio_verdict": markdown_str,
        }
    """
    from agent import run_debate_analysis

    tickers = [h["ticker"].upper() for h in holdings]

    # ── Step 1: per-stock analysis in parallel (skipped on Vercel) ───────────
    stock_analyses: dict[str, str] = {}

    if not skip_stock_analyses:
        max_workers = min(5, len(tickers))

        def _analyze_one(ticker: str) -> tuple[str, str]:
            try:
                result = run_debate_analysis(
                    ticker, stock_cache, indices_cache, api_key,
                    user_question=f"Analyze {ticker} as part of a portfolio review.",
                )
                return ticker, result.get("reply", "")
            except Exception as ex:
                return ticker, f"*Analysis unavailable: {ex}*"

        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futures = {ex.submit(_analyze_one, t): t for t in tickers}
            for future in as_completed(futures):
                ticker, analysis = future.result()
                stock_analyses[ticker] = analysis

    # ── Step 2: portfolio-level verdict ──────────────────────────────────────
    portfolio_verdict = _synthesize_verdict(
        tickers, allocation, metrics, stock_analyses, api_key
    )

    return {
        "stock_analyses": stock_analyses,
        "portfolio_verdict": portfolio_verdict,
    }


def _synthesize_verdict(tickers: list, allocation: list, metrics: dict,
                        stock_analyses: dict, api_key: str) -> str:
    from agent import _groq_post

    total_value  = metrics.get("total_value", 0)
    port_ret     = metrics.get("portfolio_return_pct", 0)
    bench_ret    = metrics.get("benchmark_return_pct", 0)
    alpha        = metrics.get("alpha", 0)
    sectors      = metrics.get("sectors", {})
    total_pnl    = metrics.get("total_pnl")
    total_pnl_pct = metrics.get("total_pnl_pct")
    top_stock    = metrics.get("top_stock", "")
    top_conc     = metrics.get("top_concentration_pct", 0)
    best         = metrics.get("best_performer") or {}
    worst        = metrics.get("worst_performer") or {}

    pnl_line = ""
    if total_pnl is not None and total_pnl_pct is not None:
        pnl_line = f" | Unrealized P&L ${total_pnl:+,.0f} ({total_pnl_pct:+.1f}%)"

    sector_str = ", ".join(f"{k}: {v}%" for k, v in sectors.items())

    holding_lines = []
    for a in sorted(allocation, key=lambda x: -x["pct"]):
        t = a["ticker"]
        line = f"  {t} — {a['pct']}% weight, ${a['value']:,.0f}, sector: {a['sector']}"
        if a.get("unrealized_pnl_pct") is not None:
            line += f", P&L {a['unrealized_pnl_pct']:+.1f}%"
        holding_lines.append(line)

    # Include a short excerpt from each stock analysis (first 300 chars)
    excerpts = []
    for t in tickers:
        text = stock_analyses.get(t, "")
        if text:
            first_line = text.strip().split("\n")[0][:200]
            excerpts.append(f"  {t}: {first_line}")

    perf_line = ""
    if port_ret != 0 or bench_ret != 0:
        perf_line = f"\n- Period Return: {port_ret:+.1f}% vs SPY {bench_ret:+.1f}% (alpha: {alpha:+.1f}%)"

    best_line  = f"\n- Today's top gainer: {best.get('ticker','')} ({best.get('return_pct',0):+.1f}%)" if best.get('ticker') else ""
    worst_line = f"\n- Today's top loser: {worst.get('ticker','')} ({worst.get('return_pct',0):+.1f}%)" if worst.get('ticker') else ""

    prompt = f"""You are a portfolio strategist. Based on the portfolio data below, write a concise portfolio verdict.

PORTFOLIO SUMMARY:
- Total Value: ${total_value:,.2f} across {len(tickers)} stocks{pnl_line}{perf_line}
- Sectors: {sector_str}
- Largest position: {top_stock} at {top_conc:.1f}%{best_line}{worst_line}

HOLDINGS:
{chr(10).join(holding_lines)}

KEY INSIGHTS FROM INDIVIDUAL ANALYSES:
{chr(10).join(excerpts)}

Write EXACTLY this format — no preamble:

**[STRONG / BALANCED / WEAK]** — *one sentence overall verdict.*

---

### Portfolio Strengths
- **[metric]**: specific number + why it matters
- **[metric]**: specific number + why it matters

### Portfolio Risks
- **[risk]**: specific number + why it matters
- **[risk]**: specific number + why it matters

---

### Stock Verdicts
| Ticker | Weight | Verdict | Action |
|---|---|---|---|
{chr(10).join(f'| {a["ticker"]} | {a["pct"]}% | [Bull/Bear/Neutral] | [Hold/Trim/Add] |' for a in sorted(allocation, key=lambda x: -x["pct"]))}

---

### Top Recommendation
*One specific, actionable change to improve this portfolio right now.*

Rules: use only numbers from the data. Be decisive. No hedging."""

    try:
        return _groq_post(api_key, [{"role": "user", "content": prompt}],
                          temperature=0.3, max_tokens=1200)
    except Exception as ex:
        return f"*Portfolio synthesis unavailable: {ex}*"
