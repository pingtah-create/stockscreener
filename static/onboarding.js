(function() {
  'use strict';

  if (!window.driver || !window.driver.js) return;

  var createDriver = window.driver.js.driver;
  var USER = window.CURRENT_USER || 'default';
  var KEY = 'stockdash_onboarding_v2_' + USER;
  var PATH = window.location.pathname;

  // ─── Which page are we on? ────────────────────

  function page() {
    if (PATH === '/') return 'chat';
    if (PATH === '/dashboard') return 'dashboard';
    if (PATH.startsWith('/stock/')) return 'stock';
    if (PATH === '/portfolio') return 'portfolio';
    return null;
  }

  // ─── Step definitions per page ─────────────────

  var STEPS = {

    chat: [
      { popover: { title: 'Welcome to Stockdash!', description: "Let's take a 2-minute tour of everything you can do. We'll walk through all four pages — starting right here with the AI Chat." } },
      { element: '#chSnapshot', popover: { title: 'Market Snapshot', description: 'Live market overview — S&P 500, NASDAQ, VIX, and a Fear & Greed score. This updates automatically every time you open the app.', side: 'bottom', align: 'center' } },
      { element: '.ch-skills-grid', popover: { title: 'AI Research Skills', description: 'Six pre-built analysis modes: fundamentals, entry/exit timing, swing trades, earnings preview, peer comparison, and market overview. Click any card, enter a ticker, and the AI runs the full analysis.', side: 'bottom', align: 'center' } },
      { element: '#chTrending', popover: { title: 'Trending Stocks', description: "Today's most active US stocks ranked by price change × volume. Click any ticker to start a conversation about it.", side: 'top', align: 'center' } },
      { element: '#chInput', popover: { title: 'Ask Anything', description: 'Type any stock question — "Is NVDA overvalued?", "Compare AAPL vs MSFT", or "Screen for high-growth tech under $50". The AI has 14 research tools at its disposal.', side: 'top', align: 'center' } },
      { element: '#historyBtn', popover: { title: 'Session History', description: 'All your past conversations are saved locally. Click here to revisit any previous analysis.', side: 'bottom', align: 'start' } }
    ],

    dashboard: [
      { popover: { title: 'Dashboard', description: "This is your market command center — live indices, a full heatmap of 193 stocks, and your personal watchlist." } },
      { element: '.db-indices', popover: { title: 'Live Market Indices', description: 'S&P 500, NASDAQ, DOW, Russell 2000, VIX, and 10Y Treasury — all color-coded green/red. Refreshes every 60 seconds.', side: 'bottom', align: 'center' } },
      { element: '#marketStatus', popover: { title: 'Market Status', description: 'Shows whether the market is open, pre-market, or closed — with a countdown to the next state change.', side: 'bottom', align: 'center' } },
      { element: '#stockMap', popover: { title: 'Market Heatmap', description: 'Every stock sized by market cap, colored by daily change. Green = up, red = down. Click any tile to jump to its interactive chart.', side: 'left', align: 'center' } },
      { element: '#stockmapSector', popover: { title: 'Sector Filter', description: 'Filter the heatmap by sector — Technology, Healthcare, Financials, Taiwan, and more. Great for spotting sector-wide moves.', side: 'bottom', align: 'start' } },
      { element: '#searchInput', popover: { title: 'Quick Search', description: 'Find any stock instantly by ticker or company name. Pro tip: press Ctrl+K from anywhere on this page.', side: 'bottom', align: 'center' } },
      { element: '#dbSidebar', popover: { title: 'Your Watchlist', description: 'Personal watchlist with live prices and sparkline mini-charts. Click any stock to open its chart. Syncs across devices when Supabase is connected.', side: 'left', align: 'center' } },
      { element: '#watchlistAddBtn', popover: { title: 'Add to Watchlist', description: 'Click + to add tickers. You can add multiple at once separated by commas — "AAPL, MSFT, 2330.TW".', side: 'left', align: 'start' } }
    ],

    stock: [
      { popover: { title: 'Stock Chart Page', description: "Full interactive charting with technical analysis, AI insights, drawing tools, and six research tabs. Let's look at each feature." } },
      { element: '.stock-header', popover: { title: 'Stock Header', description: 'Ticker, company name, current price, and daily change — updates every 30 seconds.', side: 'bottom', align: 'start' } },
      { element: '#watchStar', popover: { title: 'Watchlist Star', description: 'Star a stock to add it to your Dashboard watchlist for quick access. Click again to remove.', side: 'bottom', align: 'center' } },
      { element: '#alertBell', popover: { title: 'Price Alerts', description: 'Set "above" or "below" price targets. You\'ll get a browser notification when your target is hit.', side: 'bottom', align: 'center' } },
      { element: '.period-btns', popover: { title: 'Timeframes', description: 'Switch between 1-week and 2-year views. All indicators, volume, and oscillators adjust automatically.', side: 'bottom', align: 'center' } },
      { element: '.chart-type-btns', popover: { title: 'Chart Types', description: 'Three modes: Candlestick for detail, Line for clean trends, and Heikin-Ashi for smoothed momentum signals.', side: 'bottom', align: 'start' } },
      { element: '.ind-btns', popover: { title: 'Technical Indicators', description: 'Toggle overlays: Bollinger Bands, SMA (20/50/200), EMA (9/20), VWAP, and Volume Profile. Click each to turn on/off. Preferences are saved.', side: 'bottom', align: 'center' } },
      { element: '#autoTaBtn', popover: { title: 'Auto Technical Analysis', description: 'One-click full TA — analyzes trend, MACD, RSI, Bollinger Bands, SMA alignment, volume, ATR, and support/resistance. Shows a bull/bear score with entry targets and stop-loss.', side: 'bottom', align: 'center' } },
      { element: '#patternBtn', popover: { title: 'Pattern Detection', description: 'Scans for candlestick patterns like engulfing, hammer, shooting star, and doji. Marks them directly on the chart with arrows.', side: 'bottom', align: 'center' } },
      { element: '#drawToggleBtn', popover: { title: 'Drawing Tools', description: 'Opens a toolbar with trend lines, horizontal lines, rays, rectangles, and Fibonacci retracements. Pick a color, draw on the chart. Ctrl+Z to undo.', side: 'bottom', align: 'center' } },
      { element: '.compare-wrap', popover: { title: 'Compare Stocks', description: 'Type tickers in the "vs" box (e.g. SPY, QQQ) to overlay multiple stocks on the same chart for relative performance analysis.', side: 'bottom', align: 'center' } },
      { element: '.osc-controls', popover: { title: 'Oscillators', description: 'Switch between RSI, MACD, Stochastic, CCI, and Williams %R in the bottom panel. Each shows momentum and overbought/oversold signals.', side: 'top', align: 'start' } },
      { element: '.sidebar-tabs', popover: { title: 'Research Sidebar', description: 'Six research tabs — Fundamentals (P/E, strategy scores, 52-week range), News, Insider trades, AI Intel overview, Swing trade setups, and SEC Filings summary. Click each tab to explore.', side: 'left', align: 'center' } }
    ],

    portfolio: [
      { popover: { title: 'Portfolio Tracker', description: 'Track your holdings, see performance vs the S&P 500, and run AI-powered portfolio analysis.' } },
      { element: '.port-perf-card', popover: { title: 'Performance Chart', description: "Your portfolio's total value and returns over time, benchmarked against the S&P 500. Updates as you add or remove holdings.", side: 'bottom', align: 'center' } },
      { element: '.port-period-btns', popover: { title: 'Time Period', description: 'Switch between 1-day and 1-year views to see how your portfolio performed over different periods.', side: 'bottom', align: 'center' } },
      { element: '.port-holdings-card', popover: { title: 'Your Holdings', description: 'All your stocks with live prices, cost basis, gain/loss, and portfolio weight. Click any ticker to open its chart. Auto-refreshes every 60 seconds.', side: 'top', align: 'center' } },
      { element: '#addToggleBtn', popover: { title: 'Add Holdings', description: 'Click + Add to enter a ticker, number of shares, and average cost. You can also import from a CSV or JSON file.', side: 'bottom', align: 'start' } },
      { element: '#analyzeBtn', popover: { title: 'AI Portfolio Analysis', description: 'Run a full AI review — allocation donut chart, risk assessment, diversification analysis, and actionable rebalancing suggestions.', side: 'top', align: 'center' } },
      { popover: { title: "You're All Set!", description: "That covers everything! Click the ? button in any page's nav bar to replay the tour anytime. Happy investing!" } }
    ]

  };

  // ─── Flow order: chat → dashboard → stock → portfolio ──

  var FLOW = ['chat', 'dashboard', 'stock', 'portfolio'];
  var NEXT_URL = { chat: '/dashboard', dashboard: '/stock/AAPL', stock: '/portfolio' };

  function getState() { return localStorage.getItem(KEY) || ''; }
  function setState(v) { localStorage.setItem(KEY, v); }

  function filterVisible(steps) {
    return steps.filter(function(s) {
      if (!s.element) return true;
      var el = document.querySelector(s.element);
      return el && el.offsetParent !== null;
    });
  }

  function runTour(steps, onFinish) {
    var filtered = filterVisible(steps);
    if (!filtered.length) { if (onFinish) onFinish(); return; }

    var closedEarly = false;

    var d = createDriver({
      showProgress: true,
      showButtons: ['next', 'previous', 'close'],
      animate: true,
      stagePadding: 32,
      stageRadius: 12,
      popoverOffset: 14,
      smoothScroll: true,
      overlayOpacity: 0.18,
      progressText: '{{current}} / {{total}}',
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: onFinish ? "Let's go →" : 'Done',
      onCloseClick: function() {
        closedEarly = true;
        setState('complete');
        d.destroy();
      },
      onDestroyStarted: function() {
        if (!closedEarly) {
          if (onFinish) onFinish();
          else setState('complete');
        }
        d.destroy();
      },
      steps: filtered
    });
    d.drive();
  }

  // ─── Init ──────────────────────────────────────

  function init() {
    var p = page();
    if (!p) return;

    // Wire up ? button for manual replay (current page only)
    var helpBtn = document.getElementById('tourHelpBtn');
    if (helpBtn) {
      helpBtn.addEventListener('click', function() {
        var steps = STEPS[p];
        if (steps) runTour(steps, null);
      });
    }

    // Multi-page auto-start logic
    var state = getState();
    if (state === 'complete') return;

    var shouldStart = false;
    if (state === '' && p === 'chat') shouldStart = true;
    if (state === p) shouldStart = true;

    if (shouldStart) {
      var idx = FLOW.indexOf(p);
      var nextPage = (idx < FLOW.length - 1) ? FLOW[idx + 1] : null;
      var nextUrl = NEXT_URL[p] || null;

      setTimeout(function() {
        runTour(STEPS[p], nextUrl ? function() {
          setState(nextPage);
          window.location.href = nextUrl;
        } : null);
      }, 1500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
