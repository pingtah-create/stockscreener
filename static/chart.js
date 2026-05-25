/* chart.js — TradingView-style full-page chart with drawing tools
   Uses TradingView Lightweight Charts v4 (LightweightCharts global)
------------------------------------------------------------------ */

const LC = LightweightCharts;

// ── Theme ──────────────────────────────────────────────────────────
// Pull live colors from the CSS design tokens so the chart follows
// the dark/light theme.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function chartTheme() {
  return {
    bg:     cssVar('--bg2', '#131722'),
    text:   cssVar('--text2', '#a9b1bc'),
    grid:   cssVar('--border', '#232838'),
    border: cssVar('--border', '#232838'),
  };
}
const _ct = chartTheme();
const CHART_OPT = {
  autoSize: true,
  layout: { background: { color: _ct.bg }, textColor: _ct.text, fontSize: 11 },
  grid:    { vertLines: { color: _ct.grid }, horzLines: { color: _ct.grid } },
  crosshair: {
    mode: 1,
    vertLine: { color: 'rgba(136,153,170,0.35)', width: 1, style: 1, labelBackgroundColor: _ct.border },
    horzLine: { color: 'rgba(136,153,170,0.35)', width: 1, style: 1, labelBackgroundColor: _ct.border },
  },
  rightPriceScale: { borderColor: _ct.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
  timeScale: { borderColor: _ct.border, timeVisible: true, secondsVisible: false, rightOffset: 5 },
  handleScroll: true,
  handleScale:  true,
};

// Re-apply theme colors to both chart canvases (called on themechange).
function applyChartTheme() {
  const t = chartTheme();
  const opts = {
    layout: { background: { color: t.bg }, textColor: t.text },
    grid:   { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    crosshair: {
      vertLine: { labelBackgroundColor: t.border },
      horzLine: { labelBackgroundColor: t.border },
    },
    rightPriceScale: { borderColor: t.border },
    timeScale: { borderColor: t.border },
  };
  if (priceChart) priceChart.applyOptions(opts);
  if (oscChart)   oscChart.applyOptions(opts);
}

// ── State ──────────────────────────────────────────────────────────
let priceChart, oscChart;
let candleSeries, linePriceSeries;
let volSeries;
let oscSeriesList = [];
const overlayMap = {};   // key → LC series

let chartData    = null;
let currentOsc   = localStorage.getItem('chartOsc')  || 'rsi';
let currentType  = localStorage.getItem('chartType') || 'candle';
let _syncingRange = false;

// ── Period auto-extend ────────────────────────────────────────────
const PERIOD_ORDER = ['1d','5d','1mo','3mo','6mo','1y','2y','5y'];
let currentPeriod = '3mo';
let _autoLoading  = false;

// ── News state ──────────────────────────────────────────────────────
const newsData = {};      // date string → [{title, publisher, link, age_min}]
let   _newsHideTimer = null;
let   _newsMarkers    = [];
let   _insiderMarkers = [];

// ── Auto TA state ─────────────────────────────────────────────────
let autoTAOn       = false;
let _autoTAMarkers = [];
let _srPriceLines  = [];
let _earningsMarkers = [];

// ── Pattern state ─────────────────────────────────────────────────
let patternOn      = false;
let _patternMarkers = [];

// ── Volume Profile state ──────────────────────────────────────────
let volProfileOn   = false;

// ── Comparison overlay state ──────────────────────────────────────
const compMap = {};  // ticker → { series, bars, color }
const COMP_COLORS = ['#ab47bc', '#ff9800', '#00bcd4', '#f44336', '#4caf50'];

// ── Indicator defaults (loaded from localStorage if present) ──────
const IND_DEFAULT = { bb: true, sma20: true, sma50: false, sma200: false, ema9: false, ema20: false, vwap: false };
const IND_ON = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('chartIndOn') || 'null');
    if (saved && typeof saved === 'object') return { ...IND_DEFAULT, ...saved };
  } catch {}
  return { ...IND_DEFAULT };
})();
const _savedOsc  = localStorage.getItem('chartOsc');
const _savedType = localStorage.getItem('chartType');
function saveChartPrefs() {
  try {
    localStorage.setItem('chartIndOn', JSON.stringify(IND_ON));
    localStorage.setItem('chartOsc',   currentOsc);
    localStorage.setItem('chartType',  currentType);
  } catch {}
}

// ── Customizable indicator periods ─────────────────────────────────
const IND_CFG_DEFAULT = {
  sma1: 20, sma2: 50, sma3: 200, ema1: 9, ema2: 20,
  rsi: 14, bb: 20, bbstd: 2, macdf: 12, macds: 26, macdsig: 9,
};
const IND_CFG = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('chartIndCfg') || 'null');
    if (saved && typeof saved === 'object') return { ...IND_CFG_DEFAULT, ...saved };
  } catch {}
  return { ...IND_CFG_DEFAULT };
})();
// Build the ?sma1=..&rsi=.. query string for /api/chart
function indCfgQuery() {
  return Object.entries(IND_CFG).map(([k, v]) => `${k}=${v}`).join('&');
}
function toggleIndSettings() {
  const panel = document.getElementById('indSettingsPanel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  if (!open) {
    // Sync inputs from current config
    for (const k of Object.keys(IND_CFG)) {
      const el = document.getElementById('cfg' + k.charAt(0).toUpperCase() + k.slice(1));
      if (el) el.value = IND_CFG[k];
    }
  }
  panel.style.display = open ? 'none' : 'block';
}
function applyIndSettings() {
  for (const k of Object.keys(IND_CFG)) {
    const el = document.getElementById('cfg' + k.charAt(0).toUpperCase() + k.slice(1));
    if (!el) continue;
    const v = parseFloat(el.value);
    if (!isNaN(v) && v > 0) IND_CFG[k] = v;
  }
  try { localStorage.setItem('chartIndCfg', JSON.stringify(IND_CFG)); } catch {}
  document.getElementById('indSettingsPanel').style.display = 'none';
  loadData(currentPeriod);   // recompute with new periods
}
function resetIndSettings() {
  Object.assign(IND_CFG, IND_CFG_DEFAULT);
  try { localStorage.setItem('chartIndCfg', JSON.stringify(IND_CFG)); } catch {}
  for (const k of Object.keys(IND_CFG)) {
    const el = document.getElementById('cfg' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.value = IND_CFG[k];
  }
  loadData(currentPeriod);
}

// ── Drawing state ──────────────────────────────────────────────────
const drawings     = [];   // committed drawings
let   activeDrawing = null; // drawing in progress
let   drawTool     = 'none';
let   drawColor    = '#ffeb3b';
let   hoverPt      = null;  // {x, y} on canvas while hovering
let   drawCanvas, drawCtx, pricePanel;
let   rafId        = null;
let   needRender   = true;

// ── Init ───────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  pricePanel   = document.getElementById('pricePanel');
  drawCanvas   = document.getElementById('drawingCanvas');
  drawCtx      = drawCanvas.getContext('2d');

  initCharts();
  applySavedPrefsToUI();
  if (currentType === 'line') setChartType('line');
  else if (currentType === 'ha') setChartType('ha');
  loadData('3mo');
  loadFundamentals();
  startLivePricePolling();
  setupPeriodBtns();
  setupDrawingCanvas();
  setupPriceAlerts();
  loadAlertsFromServer();
  updateWatchStarUI();
  setupCompare();
  loadTickerNote();
  startRenderLoop();
  document.addEventListener('currencychange', () => pollLivePrice());

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoDrawing(); }
    if (e.key === 'Escape') { setDrawTool('none'); closeChartSearch(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); document.getElementById('chartSearchInput')?.focus(); }
  });

  setupChartSearch();
  setupChartSidebarResize();

  // Update color swatch CSS var
  updateDrawColor(drawColor);
});

// ── Create charts ──────────────────────────────────────────────────
function initCharts() {
  const oscPanel = document.getElementById('oscPanel');

  priceChart = LC.createChart(pricePanel, {
    ...CHART_OPT,
    rightPriceScale: { ...CHART_OPT.rightPriceScale, scaleMargins: { top: 0.06, bottom: 0.22 } },
  });

  oscChart = LC.createChart(oscPanel, {
    ...CHART_OPT,
    rightPriceScale: { ...CHART_OPT.rightPriceScale, scaleMargins: { top: 0.1, bottom: 0.1 } },
    timeScale: { ...CHART_OPT.timeScale, visible: false },
  });

  buildPriceSeries();
  buildVolSeries();
  buildOscSeries(currentOsc);

  // Recolor the chart canvas when the dark/light theme is toggled.
  window.addEventListener('themechange', applyChartTheme);

  // Sync time-scale scroll/zoom across all three charts (bidirectional)
  function hideTooltips() {
    const tip = document.getElementById('candleTooltip');
    if (tip) tip.style.display = 'none';
    const nmTip = document.getElementById('newsMarkerTooltip');
    if (nmTip) nmTip.style.display = 'none';
  }
  function makeSyncListener(srcChart, otherCharts) {
    return range => {
      if (_syncingRange || !range) return;
      _syncingRange = true;
      otherCharts.forEach(c => c.timeScale().setVisibleLogicalRange(range));
      _syncingRange = false;
      markRender();
      hideTooltips();

      // Auto-extend: if user scrolled past the left edge, load next longer period
      if (!_autoLoading && range.from < 2) {
        const idx = PERIOD_ORDER.indexOf(currentPeriod);
        if (idx >= 0 && idx < PERIOD_ORDER.length - 1) {
          const nextPeriod = PERIOD_ORDER[idx + 1];
          _autoLoading = true;
          // Update active period button
          document.querySelectorAll('.period-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.period === nextPeriod);
          });
          loadData(nextPeriod).finally(() => { _autoLoading = false; });
        }
      }
    };
  }
  priceChart.timeScale().subscribeVisibleLogicalRangeChange(makeSyncListener(priceChart, [oscChart]));
  oscChart.timeScale().subscribeVisibleLogicalRangeChange(makeSyncListener(oscChart, [priceChart]));

  // Crosshair sync: overlay line on osc panel
  const oscLine = createSyncLine(oscPanel);
  const priLine = createSyncLine(pricePanel);

  priceChart.subscribeCrosshairMove(p => {
    updateOHLCV(p);
    syncLine(oscChart,  oscLine,  p.time);
    markRender();
    if (p.time && newsData[String(p.time)]) showNewsTooltip(String(p.time));
    else hideNewsTooltip();
  });

  // Hide candle tooltip when mouse leaves the price panel
  pricePanel.addEventListener('mouseleave', () => {
    const tip = document.getElementById('candleTooltip');
    if (tip) tip.style.display = 'none';
  });

  // Keep news tooltip open while hovered so user can click headlines
  const nmTip = document.getElementById('newsMarkerTooltip');
  if (nmTip) {
    nmTip.addEventListener('mouseenter', () => {
      _newsTipHovered = true;
      if (_newsHideTimer) { clearTimeout(_newsHideTimer); _newsHideTimer = null; }
    });
    nmTip.addEventListener('mouseleave', () => {
      _newsTipHovered = false;
      hideNewsTooltip();
    });
  }
  oscChart.subscribeCrosshairMove(p => {
    syncLine(priceChart, priLine, p.time);
  });
}

function createSyncLine(panel) {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:rgba(200,220,255,.2);pointer-events:none;display:none;z-index:15;';
  panel.style.position = 'relative';
  panel.appendChild(el);
  return el;
}
function syncLine(chart, el, time) {
  if (!time) { el.style.display = 'none'; return; }
  const x = chart.timeScale().timeToCoordinate(time);
  if (x !== null && x >= 0) { el.style.left = Math.round(x) + 'px'; el.style.display = 'block'; }
  else { el.style.display = 'none'; }
}

// ── Build price series ─────────────────────────────────────────────
function buildPriceSeries() {
  candleSeries = priceChart.addCandlestickSeries({
    upColor: '#26a69a', downColor: '#ef5350',
    borderUpColor: '#26a69a', borderDownColor: '#ef5350',
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  });

  linePriceSeries = priceChart.addLineSeries({
    color: '#4fc3f7', lineWidth: 2, visible: false,
    priceLineVisible: false, lastValueVisible: false,
  });

  function addLine(color, style, visible, key) {
    const s = priceChart.addLineSeries({
      color, lineWidth: 1, lineStyle: style, visible,
      priceLineVisible: false, lastValueVisible: false,
    });
    overlayMap[key] = s;
    return s;
  }

  addLine('rgba(14,132,255,.65)', 2 /*dashed*/,   IND_ON.bb,    'bb_upper');
  addLine('rgba(14,132,255,.35)', 0 /*solid*/,    IND_ON.bb,    'bb_mid');
  addLine('rgba(14,132,255,.65)', 2 /*dashed*/,   IND_ON.bb,    'bb_lower');
  addLine('#00bcd4', 0, IND_ON.sma20,  'sma20');
  addLine('#ff9800', 0, IND_ON.sma50,  'sma50');
  addLine('#f44336', 0, IND_ON.sma200, 'sma200');
  addLine('#ab47bc', 1 /*dotted*/, IND_ON.ema9,  'ema9');
  addLine('#26c6da', 1 /*dotted*/, IND_ON.ema20, 'ema20');
  addLine('#ffd54f', 3 /*large-dashed*/, IND_ON.vwap, 'vwap');
}

// ── Volume series (overlay at bottom of price chart) ───────────────
function buildVolSeries() {
  volSeries = priceChart.addHistogramSeries({
    color: '#26a69a',
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  priceChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
}

// ── Oscillator series ──────────────────────────────────────────────
function buildOscSeries(osc) {
  oscSeriesList.forEach(s => { try { oscChart.removeSeries(s); } catch(_) {} });
  oscSeriesList = [];

  const ref = (series, price, color) =>
    series.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });

  if (osc === 'rsi') {
    const s = oscChart.addLineSeries({ color: '#e040fb', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    ref(s, 70, 'rgba(255,79,79,.5)');
    ref(s, 50, 'rgba(136,153,170,.3)');
    ref(s, 30, 'rgba(0,230,118,.5)');
    oscSeriesList.push(s);

  } else if (osc === 'macd') {
    const hist = oscChart.addHistogramSeries({ color: '#26a69a', priceLineVisible: false });
    const ml   = oscChart.addLineSeries({ color: '#2196f3', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const sl   = oscChart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    oscSeriesList.push(hist, ml, sl);

  } else if (osc === 'stoch') {
    const k = oscChart.addLineSeries({ color: '#00bcd4', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    const d = oscChart.addLineSeries({ color: '#ff9800', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    ref(k, 80, 'rgba(255,79,79,.5)');
    ref(k, 20, 'rgba(0,230,118,.5)');
    oscSeriesList.push(k, d);

  } else if (osc === 'cci') {
    const s = oscChart.addLineSeries({ color: '#ffb300', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    ref(s,  100, 'rgba(255,79,79,.5)');
    ref(s,    0, 'rgba(136,153,170,.3)');
    ref(s, -100, 'rgba(0,230,118,.5)');
    oscSeriesList.push(s);

  } else if (osc === 'willr') {
    const s = oscChart.addLineSeries({ color: '#4db6ac', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    ref(s,  -20, 'rgba(255,79,79,.5)');
    ref(s,  -80, 'rgba(0,230,118,.5)');
    oscSeriesList.push(s);
  }

  if (chartData) applyOscData(osc);
}

// ── Load & apply data ──────────────────────────────────────────────
function showChartLoading() {
  const o = document.getElementById('chartOverlay');
  const s = document.getElementById('chartOverlaySpinner');
  const m = document.getElementById('chartOverlayMsg');
  if (!o) return;
  o.classList.remove('hidden');
  s.style.display = 'block';
  m.style.display = 'none';
}
function showChartError(msg) {
  const o = document.getElementById('chartOverlay');
  const s = document.getElementById('chartOverlaySpinner');
  const m = document.getElementById('chartOverlayMsg');
  if (!o) return;
  o.classList.remove('hidden');
  s.style.display = 'none';
  m.style.display  = 'block';
  m.innerHTML = `${msg}<br><button class="retry-btn" onclick="loadData('${currentPeriod}')">↻ Retry</button>`;
}
function hideChartOverlay() {
  document.getElementById('chartOverlay')?.classList.add('hidden');
}

async function loadData(period) {
  currentPeriod = period;
  showChartLoading();
  try {
    const res = await fetch(`/api/chart/${TICKER}?period=${period}&${indCfgQuery()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    chartData = await res.json();
    if (!chartData?.ohlcv?.length) {
      const apiErr = chartData?.error || 'No data returned for this ticker.';
      showChartError(`Could not load chart data.<br><span style="color:#4a5568;font-size:11px">${apiErr}</span>`);
      return;
    }
    hideChartOverlay();
    applyAllData();
    syncHeaderFromChart();
    await loadNewsMarkers();
    loadInsider();
    if (autoTAOn) applyAutoTA();
    if (patternOn) {
      const btn = document.getElementById('patternBtn');
      if (btn) { patternOn = false; togglePatterns(btn); }
    }
    // Reload all compare tickers for the new period
    if (Object.keys(compMap).length) {
      const prevTickers = Object.keys(compMap).join(',');
      for (const { series } of Object.values(compMap)) { try { priceChart.removeSeries(series); } catch {} }
      for (const k of Object.keys(compMap)) delete compMap[k];
      loadCompareData(prevTickers);
    } else {
      const _compInput = document.getElementById('compareInput');
      if (_compInput && _compInput.value.trim()) loadCompareData(_compInput.value.trim());
    }
  } catch (e) {
    showChartError(`Failed to load chart.<br><span style="color:#4a5568;font-size:11px">${e.message}</span>`);
  }
}

// ── Sync header price from the chart's latest candle ───────────────
// Guarantees the header price always matches what's drawn on the chart,
// regardless of what /api/stock returned.
function syncHeaderFromChart() {
  const bars = chartData?.ohlcv;
  if (!bars || !bars.length) return;
  const last = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  const cur  = last.close;
  const chg  = prev && prev.close ? (cur - prev.close) / prev.close * 100 : 0;
  const priceEl = document.getElementById('stockPrice');
  const chgEl   = document.getElementById('stockChg');
  if (priceEl) priceEl.textContent = window.Currency ? window.Currency.formatPrice(cur) : '$' + cur.toFixed(2);
  if (chgEl)   {
    chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
    chgEl.className   = 'stock-chg ' + (chg >= 0 ? 'chg-up' : 'chg-down');
  }
  checkAlerts(TICKER, cur);
}

// ══════════════════════════════════════════════════════════════════
//  PRICE ALERTS
// ══════════════════════════════════════════════════════════════════
const ALERTS_KEY = 'priceAlerts';

function getAllAlerts() {
  try { return JSON.parse(localStorage.getItem(ALERTS_KEY) || '{}'); }
  catch { return {}; }
}
function saveAllAlerts(all) {
  localStorage.setItem(ALERTS_KEY, JSON.stringify(all));
}
function getAlerts(ticker) {
  return getAllAlerts()[ticker] || [];
}
function setAlerts(ticker, list) {
  const all = getAllAlerts();
  if (list.length) all[ticker] = list;
  else delete all[ticker];
  saveAllAlerts(all);
  syncAlertsToServer();
}

// Flatten the per-ticker map to the server schema and POST.
function syncAlertsToServer() {
  const all = getAllAlerts();
  const flat = [];
  for (const [t, list] of Object.entries(all)) {
    for (const a of list) {
      flat.push({
        id:        `${t}-${a.dir}-${a.price}`,
        ticker:    t,
        direction: a.dir,
        target:    Number(a.price),
        created_at: a.created ? new Date(a.created).toISOString() : null,
      });
    }
  }
  fetch('/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flat),
  }).catch(() => {});
}

// Pull server alerts on page load and merge into localStorage.
async function loadAlertsFromServer() {
  try {
    const r = await fetch('/api/alerts');
    if (!r.ok) return;
    const list = await r.json();
    if (!Array.isArray(list)) return;
    const grouped = {};
    for (const a of list) {
      if (!a.ticker || !a.target) continue;
      (grouped[a.ticker] ||= []).push({
        price:   Number(a.target),
        dir:     a.direction,
        created: a.created_at ? Date.parse(a.created_at) : Date.now(),
      });
    }
    saveAllAlerts(grouped);
    renderAlertPopup();
    updateAlertBadge();
  } catch {}
}

function addAlertFromInput(dir) {
  const inp = document.getElementById('alertPopupInput');
  const target = parseFloat(inp.value);
  if (!target || target <= 0) return;
  const list = getAlerts(TICKER);
  list.push({ price: target, dir, created: Date.now() });
  setAlerts(TICKER, list);
  inp.value = '';
  renderAlertPopup();
  updateAlertBadge();
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function removeAlert(idx) {
  const list = getAlerts(TICKER);
  list.splice(idx, 1);
  setAlerts(TICKER, list);
  renderAlertPopup();
  updateAlertBadge();
}

function renderAlertPopup() {
  const el = document.getElementById('alertPopupList');
  if (!el) return;
  const list = getAlerts(TICKER);
  if (!list.length) {
    el.innerHTML = '<div class="alert-popup-empty">No alerts set.</div>';
    return;
  }
  el.innerHTML = list.map((a, i) => {
    const arrow = a.dir === 'above' ? '▲' : '▼';
    const cls   = a.dir === 'above' ? 'above' : 'below';
    return `<div class="alert-popup-row">
      <span class="alert-popup-arrow ${cls}">${arrow}</span>
      <span class="alert-popup-price">$${a.price.toFixed(2)}</span>
      <span class="alert-popup-x" onclick="removeAlert(${i})" title="Remove">×</span>
    </div>`;
  }).join('');
}

function updateAlertBadge() {
  const badge = document.getElementById('alertBellBadge');
  const count = getAlerts(TICKER).length;
  if (!badge) return;
  if (count > 0) { badge.textContent = count; badge.style.display = 'flex'; }
  else           { badge.style.display = 'none'; }
}

// ── Watchlist toggle (shared key with dashboard) ───────────────────
const WATCHLIST_KEY = 'watchlist';
function getWatchlist() {
  try { return JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]'); }
  catch { return []; }
}
function isInWatchlist(t) { return getWatchlist().includes(t); }
function toggleWatchlistTicker() {
  const list = getWatchlist();
  const i = list.indexOf(TICKER);
  if (i >= 0) { list.splice(i, 1); showAlertToast(`${TICKER} removed from watchlist`); }
  else        { list.push(TICKER);  showAlertToast(`${TICKER} added to watchlist`); }
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
  updateWatchStarUI();
}
function updateWatchStarUI() {
  const btn = document.getElementById('watchStar');
  if (!btn) return;
  const inList = isInWatchlist(TICKER);
  btn.classList.toggle('active', inList);
  btn.title = inList ? 'Remove from watchlist' : 'Add to watchlist';
}

function setupPriceAlerts() {
  const bell = document.getElementById('alertBell');
  const pop  = document.getElementById('alertPopup');
  const inp  = document.getElementById('alertPopupInput');
  if (!bell || !pop) return;
  bell.addEventListener('click', e => {
    e.stopPropagation();
    const open = pop.style.display !== 'none';
    pop.style.display = open ? 'none' : 'block';
    if (!open) { renderAlertPopup(); inp?.focus(); refreshAlertEmailUI(); }
  });
  document.addEventListener('click', e => {
    if (!pop.contains(e.target) && !bell.contains(e.target)) pop.style.display = 'none';
  });
  inp?.addEventListener('keydown', e => {
    if (e.key === 'Enter') addAlertFromInput('above');
    if (e.key === 'Escape') pop.style.display = 'none';
  });
  updateAlertBadge();
}

async function refreshAlertEmailUI() {
  const wrap = document.getElementById('alertPopupEmailWrap');
  const inp  = document.getElementById('alertPopupEmail');
  if (!wrap || !inp) return;
  try {
    const r = await fetch('/api/account/email');
    if (!r.ok) return;
    const d = await r.json();
    inp.value = d.email || '';
    // Show the email setter only if user has alerts but no email saved
    const hasAlerts = getAlerts(TICKER).length > 0;
    wrap.style.display = (hasAlerts && !d.email) ? 'flex' : (d.email ? 'none' : 'flex');
  } catch {}
}

async function saveAlertEmail() {
  const inp = document.getElementById('alertPopupEmail');
  if (!inp) return;
  const email = inp.value.trim();
  if (!email) return;
  try {
    const r = await fetch('/api/account/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (r.ok) {
      const wrap = document.getElementById('alertPopupEmailWrap');
      if (wrap) wrap.style.display = 'none';
      showAlertToast('Email saved · alerts will be sent here');
    } else {
      showAlertToast('Invalid email');
    }
  } catch { showAlertToast('Could not save email'); }
}

// Check current price against saved alerts. Fires browser notification +
// in-page toast for any that triggered, then removes them (one-shot).
function checkAlerts(ticker, currentPrice) {
  if (!ticker || !currentPrice) return;
  const list = getAlerts(ticker);
  if (!list.length) return;
  const remaining = [];
  const fired     = [];
  for (const a of list) {
    const trigger = (a.dir === 'above' && currentPrice >= a.price) ||
                    (a.dir === 'below' && currentPrice <= a.price);
    if (trigger) fired.push(a);
    else         remaining.push(a);
  }
  if (!fired.length) return;
  setAlerts(ticker, remaining);
  if (ticker === (typeof TICKER !== 'undefined' ? TICKER : null)) {
    renderAlertPopup();
    updateAlertBadge();
  }
  for (const a of fired) {
    const msg = `${ticker} ${a.dir === 'above' ? 'rose to' : 'dropped to'} $${currentPrice.toFixed(2)} (alert: ${a.dir} $${a.price.toFixed(2)})`;
    fireAlertNotification(ticker, msg);
  }
}

function fireAlertNotification(ticker, msg) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(`📢 ${ticker} price alert`, { body: msg, tag: `alert-${ticker}-${Date.now()}` });
      n.onclick = () => { window.focus(); window.location.href = `/stock/${ticker}`; };
    } catch {}
  }
  showAlertToast(msg);
}

function showAlertToast(msg) {
  const t = document.createElement('div');
  t.className = 'alert-toast';
  t.textContent = '📢 ' + msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

// ── News events (AI-analyzed key price movers) ──────────────────────
async function loadNewsMarkers() {
  if (!chartData?.ohlcv?.length) return;

  // Show loading state in sidebar
  const feed = document.getElementById('sidebarNewsFeed');
  if (feed) feed.innerHTML = '<div class="fund-loading">Analysing key events…</div>';

  try {
    const events = await fetch(`/api/news-events/${TICKER}`).then(r => r.json());

    for (const k in newsData) delete newsData[k];

    if (events.error || !Array.isArray(events) || !events.length) {
      renderNewsEvents([]);
      return;
    }

    const chartDates = chartData.ohlcv.map(x => x.date);
    _newsMarkers = [];

    for (const ev of events) {
      if (!ev.date) continue;
      const nearest = findNearestDate(ev.date, chartDates);
      if (!nearest) continue;

      newsData[nearest] = [{ title: ev.headline, publisher: '', link: ev.url || '', summary: ev.summary, pct: ev.pct }];

      const isUp = ev.direction === 'up';
      _newsMarkers.push({
        time:     nearest,
        position: isUp ? 'belowBar' : 'aboveBar',
        color:    isUp ? '#3d9e6e' : '#b84444',
        shape:    isUp ? 'arrowUp' : 'arrowDown',
        text:     (ev.pct > 0 ? '+' : '') + (ev.pct || 0).toFixed(1) + '%',
        size:     1,
      });
    }

    flushMarkers();
    renderNewsEvents(events);
  } catch (e) {
    renderNewsEvents([]);
  }
}

function renderNewsEvents(events) {
  const feed = document.getElementById('sidebarNewsFeed');
  if (!feed) return;

  if (!events || !events.length) {
    feed.innerHTML = '<div class="fund-loading">No key events found</div>';
    return;
  }

  feed.innerHTML = events.map(ev => {
    const pct    = ev.pct || 0;
    const pctStr = (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
    const isUp   = ev.direction === 'up';
    return `<div class="nevent-item ${isUp ? 'nevent-up' : 'nevent-down'}"
         onclick="scrollChartToDate('${ev.date}')">
      <div class="nevent-top">
        <span class="nevent-date">${ev.date || ''}</span>
        <span class="nevent-pct ${isUp ? 'nevent-pct-up' : 'nevent-pct-dn'}">${pctStr}</span>
      </div>
      <div class="nevent-headline">${ev.headline || ''}</div>
      <div class="nevent-summary">${ev.summary || ''}</div>
      ${ev.url ? `<a class="nevent-link" href="${ev.url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Read more →</a>` : ''}
    </div>`;
  }).join('');
}

function scrollChartToDate(dateStr) {
  if (!chart || !chartData?.ohlcv?.length) return;
  const idx = chartData.ohlcv.findIndex(b => b.date === dateStr);
  if (idx < 0) return;
  const barsFromEnd = chartData.ohlcv.length - 1 - idx;
  priceChart.timeScale().scrollToPosition(-barsFromEnd + 10, true);
}

function findNearestDate(target, chartDates) {
  const t     = new Date(target).getTime();
  const first = new Date(chartDates[0]).getTime();
  const last  = new Date(chartDates[chartDates.length - 1]).getTime();
  if (t < first || t > last + 86400000 * 2) return null;
  let best = null, bestDiff = Infinity;
  for (const d of chartDates) {
    const diff = Math.abs(new Date(d).getTime() - t);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  return bestDiff < 86400000 * 7 ? best : null;  // up to 7 days gap (handles long holidays)
}


let _lastNewsDate = null;
let _newsTipHovered = false;

function showNewsTooltip(date) {
  const tooltip = document.getElementById('newsMarkerTooltip');
  if (!tooltip) return;
  // Lock content while user is hovering the tooltip (so they can click)
  if (_newsTipHovered) return;
  const items = newsData[date];
  if (!items?.length) { hideNewsTooltip(); return; }

  // Don't re-render if already showing this date — prevents jumping
  if (_lastNewsDate === date && tooltip.style.display === 'block') return;
  _lastNewsDate = date;

  const ev = items[0];
  const pct = ev.pct != null ? ((ev.pct > 0 ? '+' : '') + ev.pct.toFixed(1) + '%') : '';
  tooltip.innerHTML = `
    <div class="nmt-header">${pct ? `<span style="color:${ev.pct>0?'var(--green)':'var(--red)'}; margin-right:5px">${pct}</span>` : ''}${date}</div>
    <div class="nmt-item" ${ev.link ? `onclick="window.open('${ev.link}','_blank')"` : ''} style="${ev.link ? 'cursor:pointer' : ''}">
      <div class="nmt-title">${ev.title || ''}</div>
      ${ev.summary ? `<div class="nmt-meta" style="margin-top:3px;color:var(--text2);font-size:10px;line-height:1.4">${ev.summary}</div>` : ''}
    </div>`;

  // Fixed position — top-left of the price panel, never moves
  tooltip.style.left = '60px';
  tooltip.style.top  = '8px';
  tooltip.style.display = 'block';

  if (_newsHideTimer) { clearTimeout(_newsHideTimer); _newsHideTimer = null; }
}

function hideNewsTooltip() {
  _newsHideTimer = setTimeout(() => {
    const tooltip = document.getElementById('newsMarkerTooltip');
    if (tooltip) { tooltip.style.display = 'none'; _lastNewsDate = null; }
  }, 300);
}

function toSeries(dates, vals) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] !== null && vals[i] !== undefined && isFinite(vals[i]))
      out.push({ time: dates[i], value: vals[i] });
  }
  return out;
}

function applyAllData() {
  if (!chartData?.ohlcv?.length) return;
  const ohlcv = chartData.ohlcv;
  const t     = chartData.technicals;
  const dates = ohlcv.map(x => x.date);

  const displayOhlcv = currentType === 'ha' ? haTransform(ohlcv) : ohlcv;
  candleSeries.setData(displayOhlcv.map(x => ({ time: x.date, open: x.open, high: x.high, low: x.low, close: x.close })));
  linePriceSeries.setData(ohlcv.map(x => ({ time: x.date, value: x.close })));

  overlayMap.bb_upper.setData(toSeries(dates, t.bb_upper));
  overlayMap.bb_mid  .setData(toSeries(dates, t.bb_mid));
  overlayMap.bb_lower.setData(toSeries(dates, t.bb_lower));
  overlayMap.sma20   .setData(toSeries(dates, t.sma20));
  overlayMap.sma50   .setData(toSeries(dates, t.sma50));
  overlayMap.sma200  .setData(toSeries(dates, t.sma200));
  overlayMap.ema9    .setData(toSeries(dates, t.ema9));
  overlayMap.ema20   .setData(toSeries(dates, t.ema20));
  overlayMap.vwap    .setData(toSeries(dates, t.vwap));

  volSeries.setData(ohlcv.map(x => ({
    time: x.date, value: x.volume,
    color: x.up ? 'rgba(0,230,118,.5)' : 'rgba(255,79,79,.5)',
  })));

  applyOscData(currentOsc);
  requestAnimationFrame(() => {
    priceChart.timeScale().fitContent();
    markRender();
  });
}

function applyOscData(osc) {
  if (!chartData?.ohlcv?.length || !oscSeriesList.length) return;
  const dates = chartData.ohlcv.map(x => x.date);
  const t     = chartData.technicals;

  if (osc === 'rsi') {
    oscSeriesList[0].setData(toSeries(dates, t.rsi));
  } else if (osc === 'macd') {
    oscSeriesList[0].setData(toSeries(dates, t.macd_hist).map(p => ({
      ...p, color: p.value >= 0 ? 'rgba(0,230,118,.7)' : 'rgba(255,79,79,.7)',
    })));
    oscSeriesList[1].setData(toSeries(dates, t.macd));
    oscSeriesList[2].setData(toSeries(dates, t.macd_signal));
  } else if (osc === 'stoch') {
    oscSeriesList[0].setData(toSeries(dates, t.stoch_k));
    oscSeriesList[1].setData(toSeries(dates, t.stoch_d));
  } else if (osc === 'cci') {
    oscSeriesList[0].setData(toSeries(dates, t.cci));
  } else if (osc === 'willr') {
    oscSeriesList[0].setData(toSeries(dates, t.will_r));
  }
}

// ── Candle tooltip (floating box) ─────────────────────────────────
function updateOHLCV(param) {
  const tip = document.getElementById('candleTooltip');
  if (!tip) return;
  if (!param?.time || !chartData) { tip.style.display = 'none'; return; }

  const dateStr = String(param.time);
  const idx     = chartData.ohlcv.findIndex(x => x.date === dateStr);
  if (idx < 0) { tip.style.display = 'none'; return; }

  const bar   = chartData.ohlcv[idx];
  const prev  = idx > 0 ? chartData.ohlcv[idx - 1] : null;
  const chgPct = prev ? ((bar.close - prev.close) / prev.close * 100) : null;
  const chgAbs = prev ? (bar.close - prev.close) : null;
  const t      = chartData.technicals;

  const green = '#26a69a', red = '#ef5350';
  const clr   = bar.up ? green : red;
  const sign  = chgPct >= 0 ? '+' : '';

  // Format date nicely
  const d    = new Date(dateStr + 'T00:00:00');
  const dStr = d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });

  // Indicator values at this index
  const rsiVal   = t.rsi?.[idx];
  const macdVal  = t.macd?.[idx];
  const sma20Val = t.sma20?.[idx];
  const sma50Val = t.sma50?.[idx];
  const bbUpper  = t.bb_upper?.[idx];
  const bbLower  = t.bb_lower?.[idx];
  const bbMid    = t.bb_mid?.[idx];
  const vwapVal  = t.vwap?.[idx];
  const atrVal   = t.atr?.[idx];

  // BB %B position (0=at lower, 1=at upper)
  const bbPct = (bbUpper && bbLower && bbUpper !== bbLower)
    ? ((bar.close - bbLower) / (bbUpper - bbLower) * 100).toFixed(0)
    : null;

  function iv(v, dec = 2) { return (v != null && isFinite(v)) ? v.toFixed(dec) : '—'; }
  function rsiColor(v) {
    if (!v || !isFinite(v)) return '#8899aa';
    return v >= 70 ? red : v <= 30 ? green : '#e8edf5';
  }

  tip.innerHTML = `
    <div class="ct-header">
      <span class="ct-date">${dStr}</span>
      ${chgPct != null ? `<span class="ct-chg" style="color:${clr}">${sign}${chgPct.toFixed(2)}%  ${sign}${chgAbs >= 0 ? chgAbs.toFixed(2) : chgAbs.toFixed(2)}</span>` : ''}
    </div>
    <div class="ct-prices">
      <div class="ct-row"><span class="ct-label">Open</span><span class="ct-val">$${bar.open.toFixed(2)}</span></div>
      <div class="ct-row"><span class="ct-label">High</span><span class="ct-val" style="color:${green}">$${bar.high.toFixed(2)}</span></div>
      <div class="ct-row"><span class="ct-label">Low</span><span class="ct-val" style="color:${red}">$${bar.low.toFixed(2)}</span></div>
      <div class="ct-row"><span class="ct-label">Close</span><span class="ct-val" style="color:${clr};font-weight:800">$${bar.close.toFixed(2)}</span></div>
      <div class="ct-row"><span class="ct-label">Volume</span><span class="ct-val">${fmtVol(bar.volume)}</span></div>
      <div class="ct-row"><span class="ct-label">Range</span><span class="ct-val">$${(bar.high - bar.low).toFixed(2)}</span></div>
    </div>
    <div class="ct-divider"></div>
    <div class="ct-inds">
      ${rsiVal != null ? `<div class="ct-ind-row"><span class="ct-ind-lbl">RSI 14</span><span class="ct-ind-val" style="color:${rsiColor(rsiVal)}">${iv(rsiVal, 1)}</span></div>` : ''}
      ${macdVal != null ? `<div class="ct-ind-row"><span class="ct-ind-lbl">MACD</span><span class="ct-ind-val">${iv(macdVal, 3)}</span></div>` : ''}
      ${sma20Val != null ? `<div class="ct-ind-row"><span class="ct-ind-lbl">SMA 20</span><span class="ct-ind-val">$${iv(sma20Val)}</span></div>` : ''}
      ${sma50Val != null ? `<div class="ct-ind-row"><span class="ct-ind-lbl">SMA 50</span><span class="ct-ind-val">$${iv(sma50Val)}</span></div>` : ''}
      ${vwapVal != null ? `<div class="ct-ind-row"><span class="ct-ind-lbl">VWAP</span><span class="ct-ind-val">$${iv(vwapVal)}</span></div>` : ''}
      ${bbPct != null ? `<div class="ct-ind-row"><span class="ct-ind-lbl">BB %B</span><span class="ct-ind-val">${bbPct}%</span></div>` : ''}
      ${atrVal != null ? `<div class="ct-ind-row"><span class="ct-ind-lbl">ATR 14</span><span class="ct-ind-val">$${iv(atrVal)}</span></div>` : ''}
    </div>`;

  // Position the tooltip next to the crosshair, stay within panel
  const panel  = document.getElementById('pricePanel');
  const panelW = panel ? panel.getBoundingClientRect().width  : 600;
  const panelH = panel ? panel.getBoundingClientRect().height : 400;
  const tipW = 190, tipH = 280;

  let x = (param.point?.x ?? 0) + 14;
  let y = (param.point?.y ?? 0) - tipH / 2;

  if (x + tipW > panelW - 8) x = (param.point?.x ?? 0) - tipW - 14;
  if (y < 8) y = 8;
  if (y + tipH > panelH - 8) y = panelH - tipH - 8;

  tip.style.left    = x + 'px';
  tip.style.top     = y + 'px';
  tip.style.display = 'block';
  tip.style.borderColor = clr;
}

// ── Period buttons ─────────────────────────────────────────────────
function setupPeriodBtns() {
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadData(btn.dataset.period);
    });
  });
}

// ── Indicator toggles ──────────────────────────────────────────────
function toggleInd(key, btn) {
  IND_ON[key] = !IND_ON[key];
  btn.classList.toggle('active', IND_ON[key]);
  const v = IND_ON[key];

  if (key === 'bb') {
    overlayMap.bb_upper?.applyOptions({ visible: v });
    overlayMap.bb_mid  ?.applyOptions({ visible: v });
    overlayMap.bb_lower?.applyOptions({ visible: v });
  } else if (overlayMap[key]) {
    overlayMap[key].applyOptions({ visible: v });
  }
  saveChartPrefs();
}

// ── Oscillator switch ──────────────────────────────────────────────
function setOsc(osc, btn) {
  document.querySelectorAll('.osc-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  currentOsc = osc;
  buildOscSeries(osc);
  saveChartPrefs();
}

// ── Heikin-Ashi transform ──────────────────────────────────────────
function haTransform(ohlcv) {
  const out = [];
  let prevHaOpen  = ohlcv[0].open;
  let prevHaClose = (ohlcv[0].open + ohlcv[0].high + ohlcv[0].low + ohlcv[0].close) / 4;
  for (const b of ohlcv) {
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen  = (prevHaOpen + prevHaClose) / 2;
    const haHigh  = Math.max(b.high, haOpen, haClose);
    const haLow   = Math.min(b.low,  haOpen, haClose);
    out.push({ date: b.date, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: b.volume });
    prevHaOpen  = haOpen;
    prevHaClose = haClose;
  }
  return out;
}

// ── Chart type switch ──────────────────────────────────────────────
function setChartType(type) {
  currentType = type;
  document.getElementById('btnCandle')?.classList.toggle('active', type === 'candle');
  document.getElementById('btnLine')  ?.classList.toggle('active', type === 'line');
  document.getElementById('btnHA')    ?.classList.toggle('active', type === 'ha');
  candleSeries   .applyOptions({ visible: type !== 'line' });
  linePriceSeries.applyOptions({ visible: type === 'line' });
  if (chartData?.ohlcv?.length) applyAllData();
  saveChartPrefs();
}

// ── Apply saved chart prefs to UI buttons ─────────────────────────
function applySavedPrefsToUI() {
  // Indicator buttons
  document.querySelectorAll('.ind-btn[data-ind]').forEach(btn => {
    const key = btn.dataset.ind;
    btn.classList.toggle('active', !!IND_ON[key]);
  });
  // Oscillator buttons — match by visible label text (lowercased)
  document.querySelectorAll('.osc-btn').forEach(b => {
    const label = b.textContent.trim().toLowerCase().replace('willr', 'willr');
    const key = label === 'willr' ? 'willr' : label;
    b.classList.toggle('active', key === currentOsc);
  });
  // Chart type
  document.getElementById('btnCandle')?.classList.toggle('active', currentType === 'candle');
  document.getElementById('btnLine')  ?.classList.toggle('active', currentType === 'line');
  document.getElementById('btnHA')    ?.classList.toggle('active', currentType === 'ha');
}

// ── Chart page search ──────────────────────────────────────────────
let _chartSearchPool = [];
let _chartSearchDebounce;

async function setupChartSearch() {
  const input    = document.getElementById('chartSearchInput');
  const dropdown = document.getElementById('chartSearchDropdown');
  if (!input) return;

  // Pre-load pool
  try {
    const res  = await fetch('/api/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: {}, sort_by: 'marketCap', sort_dir: 'desc', page: 1, per_page: 200 }),
    });
    const data = await res.json();
    _chartSearchPool = data.results || [];
  } catch (e) {}

  input.addEventListener('input', () => {
    clearTimeout(_chartSearchDebounce);
    const q = input.value.trim().toUpperCase();
    if (!q) { closeChartSearch(); return; }
    _chartSearchDebounce = setTimeout(() => renderChartSearchResults(q), 150);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = dropdown.querySelector('.chart-search-result');
      if (first) first.click();
    }
  });

  document.addEventListener('click', e => {
    if (!document.getElementById('chartSearchWrap')?.contains(e.target)) closeChartSearch();
  });
}

function renderChartSearchResults(q) {
  const dropdown = document.getElementById('chartSearchDropdown');
  const found = _chartSearchPool.filter(s =>
    s.symbol?.toUpperCase().startsWith(q) ||
    s.symbol?.toUpperCase().includes(q) ||
    (s.shortName || '').toUpperCase().includes(q)
  ).slice(0, 7);

  // Always append a direct-lookup option so any ticker (e.g. 2330.TW) can be navigated to
  const directLink = `<a class="chart-search-result" href="/stock/${q}" style="border-top:1px solid #1a2540;opacity:.7">
    <span class="csr-ticker">${q}</span>
    <span class="csr-name" style="color:#8899aa">Go to chart →</span>
  </a>`;

  if (!found.length) {
    dropdown.innerHTML = directLink;
  } else {
    dropdown.innerHTML = found.map(s => `
      <a class="chart-search-result" href="/stock/${s.symbol}">
        <span class="csr-ticker">${s.symbol}</span>
        <span class="csr-name">${s.shortName || s.longName || ''}</span>
      </a>`).join('') + directLink;
  }
  dropdown.classList.add('open');
}

function closeChartSearch() {
  document.getElementById('chartSearchDropdown')?.classList.remove('open');
}

// ══════════════════════════════════════════════════════════════════
//  DRAWING ENGINE
// ══════════════════════════════════════════════════════════════════

// ── Coordinate helpers ─────────────────────────────────────────────
function canvasXtoPrice(y) {
  try { return candleSeries.coordinateToPrice(y); } catch(_) { return null; }
}
function priceToY(price) {
  try { return candleSeries.priceToCoordinate(price); } catch(_) { return null; }
}
function canvasXtoTime(x) {
  try {
    const logical = priceChart.timeScale().coordinateToLogical(x);
    if (logical === null || !chartData?.ohlcv) return null;
    const idx = Math.max(0, Math.min(chartData.ohlcv.length - 1, Math.round(logical)));
    return chartData.ohlcv[idx]?.date || null;
  } catch(_) { return null; }
}
function timeToX(time) {
  try { return priceChart.timeScale().timeToCoordinate(time); } catch(_) { return null; }
}

// Convert a {time, price} stored point → current canvas {x,y}
function ptToXY(p) {
  const x = timeToX(p.time);
  const y = priceToY(p.price);
  if (x === null || y === null) return null;
  return { x, y };
}

// ── Tool select ────────────────────────────────────────────────────
function setDrawTool(tool) {
  drawTool    = tool;
  activeDrawing = null;
  hoverPt     = null;

  // Update toolbar button active state
  document.querySelectorAll('.dtool').forEach(b => b.classList.remove('active'));
  const activeEl = document.getElementById('dtool-' + tool);
  if (activeEl) activeEl.classList.add('active');
  else document.getElementById('dtool-none')?.classList.add('active');

  // Canvas pointer events: only active when a drawing tool is selected
  const drawing = tool !== 'none';
  drawCanvas.style.pointerEvents = drawing ? 'auto' : 'none';
  drawCanvas.style.cursor = drawing ? 'crosshair' : 'default';

  // Disable chart's own crosshair interaction when drawing
  priceChart.applyOptions({
    handleScroll: !drawing,
    handleScale:  !drawing,
  });

  showHint(tool);
  markRender();
}

function showHint(tool) {
  let hint = document.querySelector('.draw-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'draw-hint';
    pricePanel.appendChild(hint);
  }
  const msgs = {
    trendline:  'Click two points to draw trend line — Esc to cancel',
    hline:      'Click to place horizontal line — Esc to cancel',
    ray:        'Click two points to draw a ray — Esc to cancel',
    rectangle:  'Click two corners to draw rectangle — Esc to cancel',
    fibonacci:  'Click high then low (or low then high) — Esc to cancel',
  };
  if (msgs[tool]) { hint.textContent = msgs[tool]; hint.style.display = 'block'; }
  else            { hint.style.display = 'none'; }
}

function updateDrawColor(color) {
  drawColor = color;
  document.querySelector('.drawing-toolbar')?.style.setProperty('--draw-color', color);
}

// ── Canvas mouse events ────────────────────────────────────────────
function setupDrawingCanvas() {
  // Resize canvas to match its CSS size
  const resizeCanvas = () => {
    const rect = pricePanel.getBoundingClientRect();
    if (drawCanvas.width  !== rect.width)  drawCanvas.width  = rect.width;
    if (drawCanvas.height !== rect.height) drawCanvas.height = rect.height;
    markRender();
  };
  new ResizeObserver(resizeCanvas).observe(pricePanel);
  resizeCanvas();

  drawCanvas.addEventListener('mousemove', onCanvasMove);
  drawCanvas.addEventListener('click',     onCanvasClick);
  drawCanvas.addEventListener('mouseleave', () => { hoverPt = null; markRender(); });
  drawCanvas.addEventListener('contextmenu', e => { e.preventDefault(); cancelActiveDrawing(); });

}

function onCanvasMove(e) {
  const r = drawCanvas.getBoundingClientRect();
  hoverPt = { x: e.clientX - r.left, y: e.clientY - r.top };
  markRender();
}

function onCanvasClick(e) {
  const r    = drawCanvas.getBoundingClientRect();
  const cx   = e.clientX - r.left;
  const cy   = e.clientY - r.top;
  const time  = canvasXtoTime(cx);
  const price = canvasXtoPrice(cy);
  if (time === null || price === null) return;

  const pt = { time, price };

  if (drawTool === 'hline') {
    // Single-click tool
    drawings.push({ type: 'hline', points: [pt], color: drawColor });
    markRender();
    return;
  }

  // Two-click tools
  if (!activeDrawing) {
    activeDrawing = { type: drawTool, points: [pt], color: drawColor };
  } else {
    activeDrawing.points.push(pt);
    if (activeDrawing.points.length >= 2) {
      drawings.push({ ...activeDrawing });
      activeDrawing = null;
    }
  }
  markRender();
}

function cancelActiveDrawing() {
  activeDrawing = null;
  markRender();
}

// ── Undo / Clear ───────────────────────────────────────────────────
function undoDrawing() {
  if (activeDrawing) { activeDrawing = null; }
  else               { drawings.pop(); }
  markRender();
}
function clearDrawings() {
  drawings.length = 0;
  activeDrawing   = null;
  markRender();
}

// ── Volume Profile ─────────────────────────────────────────────────
function toggleVolProfile(btn) {
  volProfileOn = !volProfileOn;
  btn.classList.toggle('active', volProfileOn);
  markRender();
}

function computeVolumeProfile(ohlcv, numBuckets = 30) {
  let minP = Infinity, maxP = -Infinity;
  for (const b of ohlcv) { if (b.low < minP) minP = b.low; if (b.high > maxP) maxP = b.high; }
  if (maxP <= minP) return [];
  const step = (maxP - minP) / numBuckets;
  const vol  = new Array(numBuckets).fill(0);
  for (const b of ohlcv) {
    const idx = Math.min(Math.floor((b.close - minP) / step), numBuckets - 1);
    if (idx >= 0) vol[idx] += b.volume || 0;
  }
  const maxVol = Math.max(...vol);
  return vol.map((v, i) => ({
    priceTop: minP + (i + 1) * step,
    priceMid: minP + (i + 0.5) * step,
    priceBot: minP + i * step,
    volume: v,
    pct: maxVol > 0 ? v / maxVol : 0,
  }));
}

function renderVolumeProfile(ctx, W, H) {
  if (!chartData?.ohlcv?.length) return;
  const profile = computeVolumeProfile(chartData.ohlcv, 30);
  if (!profile.length) return;

  const maxBarW = Math.min(W * 0.1, 72);
  const maxPct  = Math.max(...profile.map(r => r.pct));

  ctx.save();
  for (const row of profile) {
    const yTop = priceToY(row.priceTop);
    const yBot = priceToY(row.priceBot);
    if (yTop === null || yBot === null) continue;
    const barH = Math.abs(yBot - yTop);
    if (barH < 0.5) continue;
    const barW = row.pct * maxBarW;
    const y    = Math.min(yTop, yBot);
    const isPOC = row.pct === maxPct;
    ctx.fillStyle = isPOC ? 'rgba(255,213,79,0.55)' : 'rgba(77,182,172,0.28)';
    ctx.fillRect(W - barW - 1, y, barW, Math.max(barH - 1, 1));
  }

  // POC label
  const poc = profile.find(r => r.pct === maxPct);
  if (poc) {
    const yMid = priceToY(poc.priceMid);
    if (yMid !== null) {
      ctx.font      = '9px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,213,79,0.9)';
      ctx.textAlign = 'right';
      ctx.fillText(`POC $${poc.priceMid.toFixed(2)}`, W - 4, yMid - 2);
    }
  }
  ctx.restore();
}

// ── RAF render loop ────────────────────────────────────────────────
function markRender() { needRender = true; }

function startRenderLoop() {
  function loop() {
    // Always redraw so drawings follow the chart during scroll/zoom
    renderDrawings();
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}

// ── Render all drawings ────────────────────────────────────────────
function renderDrawings() {
  if (!drawCtx) return;
  const W = drawCanvas.width, H = drawCanvas.height;
  drawCtx.clearRect(0, 0, W, H);

  // Volume Profile (drawn first, behind everything)
  if (volProfileOn) renderVolumeProfile(drawCtx, W, H);

  // Draw hover cross when tool is active
  if (drawTool !== 'none' && hoverPt) drawCursorCross(hoverPt, W, H);

  // Draw committed shapes
  drawings.forEach(d => renderShape(d, W, H));

  // Draw in-progress shape preview
  if (activeDrawing) {
    const preview = { ...activeDrawing, points: [...activeDrawing.points] };
    if (hoverPt) {
      const time  = canvasXtoTime(hoverPt.x);
      const price = canvasXtoPrice(hoverPt.y);
      if (time && price) preview.points.push({ time, price });
    }
    renderShape(preview, W, H, true);
  }
}

function drawCursorCross(pt, W, H) {
  const ctx = drawCtx;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.4)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pt.x, 0); ctx.lineTo(pt.x, H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, pt.y); ctx.lineTo(W, pt.y); ctx.stroke();
  ctx.restore();
}

function renderShape(d, W, H, preview = false) {
  const ctx   = drawCtx;
  const color = d.color || '#ffeb3b';
  const pts   = d.points.map(ptToXY).filter(Boolean);
  if (!pts.length) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = preview ? 1.5 : 2;
  if (preview) ctx.globalAlpha = 0.7;

  switch (d.type) {
    case 'trendline': drawTrendLine(ctx, pts, W, H, false); break;
    case 'ray':       drawTrendLine(ctx, pts, W, H, true);  break;
    case 'hline':     drawHLine(ctx, pts[0], W);            break;
    case 'rectangle': drawRect(ctx, pts, color);            break;
    case 'fibonacci': drawFib(ctx, pts, W);                 break;
  }
  ctx.restore();
}

// ── Shape renderers ────────────────────────────────────────────────

function drawTrendLine(ctx, pts, W, H, rayOnly) {
  if (pts.length < 2) {
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 3, 0, Math.PI*2); ctx.fill(); }
    return;
  }
  const p1 = pts[0], p2 = pts[1];
  const dx = p2.x - p1.x, dy = p2.y - p1.y;

  ctx.beginPath();
  // Extend the line to canvas edges
  if (Math.abs(dx) < 0.0001) {
    // Vertical line
    ctx.moveTo(p1.x, 0); ctx.lineTo(p1.x, H);
  } else {
    const slope = dy / dx;
    const b     = p1.y - slope * p1.x;

    let x0, x1;
    if (rayOnly) {
      // Ray: start at p1, extend right
      x0 = p1.x; x1 = W;
    } else {
      // Full line: extend both ways
      x0 = 0; x1 = W;
    }
    ctx.moveTo(x0, slope * x0 + b);
    ctx.lineTo(x1, slope * x1 + b);
  }
  ctx.stroke();

  // Endpoint dots
  drawDot(ctx, p1); drawDot(ctx, p2);
}

function drawHLine(ctx, p, W) {
  ctx.setLineDash([6, 3]);
  ctx.beginPath();
  ctx.moveTo(0, p.y);
  ctx.lineTo(W, p.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Price label on right
  const price = canvasXtoPrice(p.y);
  if (price !== null) {
    ctx.font      = '11px Inter, system-ui, sans-serif';
    ctx.fillStyle = ctx.strokeStyle;
    const label   = price.toFixed(2);
    const tw      = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(9,14,26,.85)';
    ctx.fillRect(W - tw - 10, p.y - 8, tw + 8, 16);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(label, W - tw - 6, p.y + 4);
  }
}

function drawRect(ctx, pts, color) {
  if (pts.length < 2) {
    if (pts.length === 1) { drawDot(ctx, pts[0]); }
    return;
  }
  const p1 = pts[0], p2 = pts[1];
  const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);

  // Fill
  ctx.fillStyle = hexToRgba(color, .1);
  ctx.fillRect(x, y, w, h);

  // Border
  ctx.strokeStyle = color;
  ctx.strokeRect(x, y, w, h);

  drawDot(ctx, p1); drawDot(ctx, p2);
}

const FIB_LEVELS = [
  { r: 0,     label: '0%'    },
  { r: 0.236, label: '23.6%' },
  { r: 0.382, label: '38.2%' },
  { r: 0.500, label: '50%'   },
  { r: 0.618, label: '61.8%' },
  { r: 0.786, label: '78.6%' },
  { r: 1,     label: '100%'  },
];
const FIB_COLORS = ['#f44336','#ff9800','#ffeb3b','#4caf50','#2196f3','#9c27b0','#607d8b'];

function drawFib(ctx, pts, W) {
  if (pts.length < 2) {
    if (pts.length === 1) drawDot(ctx, pts[0]);
    return;
  }
  const y0 = pts[0].y, y1 = pts[1].y;
  ctx.font = '10px Inter, system-ui, sans-serif';

  FIB_LEVELS.forEach(({ r, label }, i) => {
    const y = y0 + (y1 - y0) * r;
    ctx.strokeStyle = FIB_COLORS[i] || '#888';
    ctx.fillStyle   = FIB_COLORS[i] || '#888';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Level label on right
    const price = canvasXtoPrice(y);
    const text  = price !== null ? `${label}  ${price.toFixed(2)}` : label;
    ctx.fillStyle = 'rgba(9,14,26,.75)';
    const tw = ctx.measureText(text).width;
    ctx.fillRect(W - tw - 10, y - 7, tw + 8, 14);
    ctx.fillStyle = FIB_COLORS[i] || '#888';
    ctx.fillText(text, W - tw - 6, y + 4);
  });

  drawDot(ctx, pts[0]); drawDot(ctx, pts[1]);
}

function drawDot(ctx, p) {
  ctx.save();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ══════════════════════════════════════════════════════════════════
//  FUNDAMENTALS SIDEBAR
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
//  COMPANY INTEL (Gemini AI)
// ══════════════════════════════════════════════════════════════════

function openIntelPanel(btn) {
  switchSidebarTab('intel', btn);
  const body = document.getElementById('intelBody');
  if (body && !body.dataset.loaded) {
    body.dataset.loaded = '1';
    loadIntel();
  }
}

async function loadIntel() {
  const body = document.getElementById('intelBody');
  if (!body) return;
  body.innerHTML = '<div class="intel-loading">Generating analysis…<span class="intel-dots"></span></div>';
  try {
    const res = await fetch(`/api/intel/${TICKER}`, { cache: 'no-store' });
    const text = await res.text();
    let d;
    try { d = JSON.parse(text); } catch { body.innerHTML = `<div class="intel-error">⚠ Server error:<br><small>${text.slice(0,200)}</small></div>`; return; }
    if (d.error) { body.innerHTML = `<div class="intel-error">⚠ ${d.error}</div>`; return; }
    body.innerHTML = renderIntel(d);
  } catch (e) {
    body.innerHTML = `<div class="intel-error">⚠ ${e.message}</div>`;
  }
}

function renderIntel(d) {
  const sw = `
    <div class="intel-sw">
      <div>
        <div class="intel-sw-col-title green">Strengths</div>
        ${(d.strengths || []).map(s => `<div class="intel-sw-item s">${s}</div>`).join('')}
      </div>
      <div>
        <div class="intel-sw-col-title red">Weaknesses</div>
        ${(d.weaknesses || []).map(w => `<div class="intel-sw-item w">${w}</div>`).join('')}
      </div>
    </div>`;

  const comps = (d.competitors || []).map(c => `
    <div class="intel-comp-row">
      <div class="intel-comp-ticker" onclick="location.href='/stock/${c.ticker}'">${c.ticker}</div>
      <div class="intel-comp-info">
        <div class="intel-comp-name">${c.name}</div>
        <div class="intel-comp-note">${c.note}</div>
      </div>
    </div>`).join('');

  return `
    <div class="intel-section">
      <div class="intel-section-title">Business Overview</div>
      <div class="intel-text">${d.overview || '—'}</div>
    </div>
    <div class="intel-section">
      <div class="intel-section-title">Macro Exposure</div>
      <div class="intel-text">${d.macro || '—'}</div>
    </div>
    <div class="intel-section">
      <div class="intel-section-title">Strengths &amp; Weaknesses</div>
      ${sw}
    </div>
    <div class="intel-section">
      <div class="intel-section-title">Key Competitors</div>
      ${comps}
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
//  AI SWING SETUP
// ══════════════════════════════════════════════════════════════════

function openSwingPanel(btn) {
  switchSidebarTab('swing', btn);
  const body = document.getElementById('swingBody');
  if (body && !body.dataset.loaded) {
    body.dataset.loaded = '1';
    loadSwing();
  }
}

async function loadSwing() {
  const body = document.getElementById('swingBody');
  if (!body) return;
  body.innerHTML = '<div class="intel-loading">Generating setup…<span class="intel-dots"></span></div>';
  try {
    const res  = await fetch(`/api/swing/${TICKER}`, { cache: 'no-store' });
    const text = await res.text();
    let d;
    try { d = JSON.parse(text); } catch { body.innerHTML = `<div class="intel-error">⚠ ${text.slice(0,200)}</div>`; return; }
    if (d.error) { body.innerHTML = `<div class="intel-error">⚠ ${d.error}</div>`; return; }
    body.innerHTML = renderSwing(d);
  } catch (e) {
    body.innerHTML = `<div class="intel-error">⚠ ${e.message}</div>`;
  }
}

function renderSwing(d) {
  const sigColor = d.signal === 'Bullish' ? 'var(--green)' : d.signal === 'Bearish' ? 'var(--red)' : 'var(--text2)';
  const confColor = d.confidence === 'High' ? 'var(--green)' : d.confidence === 'Medium' ? '#ff9800' : 'var(--red)';
  const fmt = v => v != null ? (window.Currency ? window.Currency.formatPrice(Number(v)) : '$' + Number(v).toFixed(2)) : '—';
  const rr = d.stop_loss && d.entry_low && d.target_1
    ? ((d.target_1 - d.entry_high) / (d.entry_low - d.stop_loss)).toFixed(1)
    : null;

  return `
    <div class="swing-header-row">
      <span class="swing-signal" style="color:${sigColor}">● ${d.signal || '—'}</span>
      <span class="swing-setup-type">${d.setup_type || ''}</span>
      <span class="swing-conf" style="color:${confColor}">${d.confidence || ''}</span>
    </div>
    <div class="swing-grid">
      <div class="swing-box entry">
        <div class="swing-box-label">Entry Zone</div>
        <div class="swing-box-val">${fmt(d.entry_low)} – ${fmt(d.entry_high)}</div>
      </div>
      <div class="swing-box stop">
        <div class="swing-box-label">Stop Loss</div>
        <div class="swing-box-val">${fmt(d.stop_loss)}</div>
      </div>
      <div class="swing-box t1">
        <div class="swing-box-label">Target 1</div>
        <div class="swing-box-val">${fmt(d.target_1)}</div>
      </div>
      <div class="swing-box t2">
        <div class="swing-box-label">Target 2</div>
        <div class="swing-box-val">${fmt(d.target_2)}</div>
      </div>
      <div class="swing-box rr">
        <div class="swing-box-label">R:R Ratio</div>
        <div class="swing-box-val">${rr ? rr + ':1' : '—'}</div>
      </div>
      <div class="swing-box tf">
        <div class="swing-box-label">Timeframe</div>
        <div class="swing-box-val">${d.timeframe || '—'}</div>
      </div>
    </div>
    <div class="intel-section">
      <div class="intel-section-title">Thesis</div>
      <div class="intel-text">${d.thesis || '—'}</div>
    </div>
    <div class="intel-section">
      <div class="intel-section-title" style="color:var(--red)">Risk Factors</div>
      <div class="intel-text" style="color:var(--text2)">${d.risk_factors || '—'}</div>
    </div>`;
}

// ── Live price polling via /api/quote (Finnhub → yfinance) ────────
let _livePriceTimer = null;

async function pollLivePrice() {
  try {
    const res = await fetch(`/api/quote/${TICKER}`, { cache: 'no-store' });
    if (!res.ok) return;
    const q = await res.json();
    if (!q.price) return;
    const priceEl = document.getElementById('stockPrice');
    const chgEl   = document.getElementById('stockChg');
    if (priceEl) priceEl.textContent = window.Currency ? window.Currency.formatPrice(q.price) : '$' + q.price.toFixed(2);
    if (chgEl) {
      const chg = q.change_pct || 0;
      chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
      chgEl.className   = 'stock-chg ' + (chg >= 0 ? 'chg-up' : 'chg-down');
    }
    // Extended-hours (pre-/after-market) quote, if the API returned one
    let extEl = document.getElementById('stockPostMarket');
    if (q.post_market_price != null) {
      if (!extEl) {
        extEl = document.createElement('span');
        extEl.id = 'stockPostMarket';
        extEl.className = 'stock-postmarket';
        (chgEl || priceEl)?.insertAdjacentElement('afterend', extEl);
      }
      const pc = q.post_market_change_pct || 0;
      const postFmt = window.Currency ? window.Currency.formatPrice(q.post_market_price) : '$' + q.post_market_price.toFixed(2);
      extEl.textContent =
        `· Post ${postFmt} (${pc >= 0 ? '+' : ''}${pc.toFixed(2)}%)`;
      extEl.className = 'stock-postmarket ' + (pc >= 0 ? 'chg-up' : 'chg-down');
      extEl.style.display = '';
    } else if (extEl) {
      extEl.style.display = 'none';
    }
    checkAlerts(TICKER, q.price);
  } catch {}
}

function startLivePricePolling() {
  clearInterval(_livePriceTimer);
  pollLivePrice();
  _livePriceTimer = setInterval(pollLivePrice, 30000);
}

async function loadFundamentals() {
  const res = await fetch(`/api/stock/${TICKER}`, { cache: "no-store" });
  const s   = await res.json();
  loadEarnings();

  // Top bar
  const price = s.currentPrice || s.previousClose;
  const chg   = s.regularMarketChangePercent || 0;
  document.getElementById('stockName') .textContent = s.shortName || s.longName || '';
  document.getElementById('stockPrice').textContent = price
    ? (window.Currency ? window.Currency.formatPrice(price) : '$' + price.toFixed(2))
    : '—';
  const chgEl = document.getElementById('stockChg');
  chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
  chgEl.className   = 'stock-chg ' + (chg >= 0 ? 'chg-up' : 'chg-down');

  // Fundamentals grid
  const rows = [
    ['P/E (TTM)',  fmt1(s.trailingPE)],
    ['Fwd P/E',   fmt1(s.forwardPE)],
    ['P/B',       fmt2(s.priceToBook)],
    ['PEG',       fmt2(s.pegRatio)],
    ['EV/EBITDA', fmt1(s.enterpriseToEbitda)],
    ['ROE',       fmtPct(s.returnOnEquity)],
    ['ROA',       fmtPct(s.returnOnAssets)],
    ['Rev Growth', fmtPct(s.revenueGrowth)],
    ['EPS Growth', fmtPct(s.earningsGrowth)],
    ['Op Margin',  fmtPct(s.operatingMargins)],
    ['Net Margin', fmtPct(s.profitMargins)],
    ['D/E Ratio',  fmt2(s.debtToEquity)],
    ['Curr Ratio', fmt2(s.currentRatio)],
    ['Div Yield',  fmtPct(s.dividendYield)],
    ['Beta',       fmt2(s.beta)],
    ['Mkt Cap',    fmtMCap(s.marketCap)],
  ];

  document.getElementById('fundGrid').innerHTML = rows.map(([k, v]) => `
    <div class="fund-item">
      <div class="fund-key">${k}</div>
      <div class="fund-val">${v}</div>
    </div>`).join('');

  // Strategy scores
  const scores = s.scores || {};
  const NAMES  = { value:'Value', growth:'Growth', momentum:'Momentum', quality:'Quality', dividend:'Dividend', deepvalue:'Deep Value' };
  document.getElementById('scoresList').innerHTML = Object.entries(NAMES).map(([k, name]) => {
    const sc = scores[k] ?? 0;
    return `<div class="score-row">
      <span class="score-name">${name}</span>
      <div class="score-bar-bg"><div class="score-bar-fill" style="width:${sc}%"></div></div>
      <span class="score-num">${sc}</span>
    </div>`;
  }).join('');

  // 52-week range
  const lo  = s.fiftyTwoWeekLow;
  const hi  = s.fiftyTwoWeekHigh;
  const pos = s.fiftyTwoWeekPosition;
  document.getElementById('week52Lo').textContent = lo ? (window.Currency ? window.Currency.formatPrice(lo) : '$' + lo.toFixed(2)) : '—';
  document.getElementById('week52Hi').textContent = hi ? (window.Currency ? window.Currency.formatPrice(hi) : '$' + hi.toFixed(2)) : '—';
  if (pos !== null && pos !== undefined) {
    document.getElementById('week52Fill') .style.width = pos + '%';
    document.getElementById('week52Thumb').style.left  = pos + '%';
  }
}

// ── Merge all markers onto the price series ───────────────────────
function flushMarkers() {
  if (!candleSeries) return;
  const all = [..._newsMarkers, ..._insiderMarkers, ..._autoTAMarkers, ..._earningsMarkers, ..._patternMarkers]
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  candleSeries.setMarkers(all);
}

// ── Candlestick pattern recognition ──────────────────────────────
function detectPatterns(ohlcv) {
  const results = [];
  for (let i = 2; i < ohlcv.length; i++) {
    const c  = ohlcv[i],   p1 = ohlcv[i-1], p2 = ohlcv[i-2];
    const body    = Math.abs(c.close - c.open);
    const range   = c.high - c.low;
    const lowerW  = Math.min(c.open, c.close) - c.low;
    const upperW  = c.high - Math.max(c.open, c.close);
    const isBull  = c.close > c.open;
    const isBear  = c.close < c.open;
    const p1Bull  = p1.close > p1.open;
    const p1Bear  = p1.close < p1.open;
    const p2Bull  = p2.close > p2.open;
    const p2Bear  = p2.close < p2.open;
    const p1Body  = Math.abs(p1.close - p1.open);
    const p1Range = p1.high - p1.low;
    const p2Body  = Math.abs(p2.close - p2.open);

    if (range < 0.001 * c.close) continue; // skip tiny bars

    // Doji — tiny body relative to range
    if (body / range < 0.08) {
      results.push({ time: c.date, name: 'Doji', bull: null });
      continue; // one pattern per bar
    }

    // Hammer (bullish reversal) — small body at top, long lower wick ≥2× body
    if (lowerW >= 2 * body && upperW <= 0.4 * body && body / range < 0.35) {
      results.push({ time: c.date, name: 'Hammer', bull: true });
      continue;
    }

    // Shooting Star (bearish reversal) — small body at bottom, long upper wick
    if (upperW >= 2 * body && lowerW <= 0.4 * body && body / range < 0.35) {
      results.push({ time: c.date, name: 'Shooting Star', bull: false });
      continue;
    }

    // Bullish Engulfing
    if (p1Bear && isBull &&
        c.open  <  p1.close && c.close > p1.open &&
        body > p1Body) {
      results.push({ time: c.date, name: 'Bullish Engulfing', bull: true });
      continue;
    }

    // Bearish Engulfing
    if (p1Bull && isBear &&
        c.open  >  p1.close && c.close < p1.open &&
        body > p1Body) {
      results.push({ time: c.date, name: 'Bearish Engulfing', bull: false });
      continue;
    }

    // Morning Star (bullish 3-bar) — bearish + small body + bullish recovering past midpoint
    if (p2Bear && p1Range > 0 && p1Body / p1Range < 0.3 && isBull &&
        c.close > (p2.open + p2.close) / 2) {
      results.push({ time: c.date, name: 'Morning Star', bull: true });
      continue;
    }

    // Evening Star (bearish 3-bar) — bullish + small body + bearish recovering past midpoint
    if (p2Bull && p1Range > 0 && p1Body / p1Range < 0.3 && isBear &&
        c.close < (p2.open + p2.close) / 2) {
      results.push({ time: c.date, name: 'Evening Star', bull: false });
      continue;
    }

    // Marubozu (strong trend candle, no wicks)
    if (body / range > 0.9 && body > 0.01 * c.close) {
      results.push({ time: c.date, name: isBull ? 'Bullish Marubozu' : 'Bearish Marubozu', bull: isBull });
    }
  }
  return results;
}

function togglePatterns(btn) {
  patternOn = !patternOn;
  btn.classList.toggle('active', patternOn);
  if (patternOn && chartData?.ohlcv?.length) {
    const patterns = detectPatterns(chartData.ohlcv);
    _patternMarkers = patterns.map(p => ({
      time:     p.time,
      position: p.bull === true ? 'belowBar' : p.bull === false ? 'aboveBar' : 'belowBar',
      color:    p.bull === true ? '#26a69a'  : p.bull === false ? '#ef5350'  : '#ffd54f',
      shape:    p.bull === true ? 'arrowUp'  : p.bull === false ? 'arrowDown': 'circle',
      text:     p.name.split(' ').map(w => w[0]).join(''),
      size: 1,
    }));
  } else {
    _patternMarkers = [];
  }
  flushMarkers();
}

// ── Auto TA ───────────────────────────────────────────────────────
function toggleAutoTA(btn) {
  autoTAOn = !autoTAOn;
  btn.classList.toggle('active', autoTAOn);
  if (autoTAOn) applyAutoTA();
  else          clearAutoTA();
}

function clearSRLines() {
  for (const pl of _srPriceLines) {
    try { candleSeries.removePriceLine(pl); } catch {}
  }
  _srPriceLines = [];
}

function clearAutoTA() {
  for (let i = drawings.length - 1; i >= 0; i--) {
    if (drawings[i]._autoTA) drawings.splice(i, 1);
  }
  _autoTAMarkers = [];
  clearSRLines();
  flushMarkers();
  markRender();
  const panel = document.getElementById('autoTAPanel');
  if (panel) panel.style.display = 'none';
}

function applyAutoTA() {
  if (!chartData?.ohlcv?.length) return;
  clearAutoTA();

  // Force-enable BB + SMA20 + SMA50 overlays
  ['bb', 'sma20', 'sma50'].forEach(key => {
    if (!IND_ON[key]) {
      IND_ON[key] = true;
      document.querySelector(`.ind-btn[data-ind="${key}"]`)?.classList.add('active');
      if (key === 'bb') {
        overlayMap.bb_upper?.applyOptions({ visible: true });
        overlayMap.bb_mid  ?.applyOptions({ visible: true });
        overlayMap.bb_lower?.applyOptions({ visible: true });
      } else {
        overlayMap[key]?.applyOptions({ visible: true });
      }
    }
  });

  const ohlcv = chartData.ohlcv;
  const t     = chartData.technicals;
  const n     = ohlcv.length;
  const dates = ohlcv.map(x => x.date);

  // Pivot lows/highs for trendline + trend finding
  const W = 3;
  const recent = ohlcv.slice(-Math.min(80, n));
  const rn = recent.length;
  const lows = [], highs = [];
  for (let i = W; i < rn - W; i++) {
    let isLow = true, isHigh = true;
    for (let d = 1; d <= W; d++) {
      if (recent[i-d].low  <= recent[i].low  || recent[i+d].low  <= recent[i].low)  isLow  = false;
      if (recent[i-d].high >= recent[i].high || recent[i+d].high >= recent[i].high) isHigh = false;
    }
    if (isLow)  lows .push({ price: recent[i].low,  date: recent[i].date });
    if (isHigh) highs.push({ price: recent[i].high, date: recent[i].date });
  }

  // Draw trendline on chart
  let trendDrawn = false;
  for (let i = lows.length - 1; i >= 1 && !trendDrawn; i--) {
    if (lows[i].price > lows[i-1].price) {
      drawings.push({ type: 'trendline', points: [lows[i-1], lows[i]], color: '#26a69a', _autoTA: true });
      trendDrawn = true;
    }
  }
  if (!trendDrawn) {
    for (let i = highs.length - 1; i >= 1; i--) {
      if (highs[i].price < highs[i-1].price) {
        drawings.push({ type: 'trendline', points: [highs[i-1], highs[i]], color: '#ef5350', _autoTA: true });
        break;
      }
    }
  }

  // MACD crossover markers on chart
  if (t.macd && t.macd_signal) {
    for (let i = 1; i < t.macd.length; i++) {
      const m0 = t.macd[i-1], s0 = t.macd_signal[i-1];
      const m1 = t.macd[i],   s1 = t.macd_signal[i];
      if (m0 == null || s0 == null || m1 == null || s1 == null) continue;
      if (m0 < s0 && m1 >= s1)
        _autoTAMarkers.push({ time: dates[i], position: 'belowBar', color: '#26a69a', shape: 'arrowUp',   text: '▲', size: 1 });
      else if (m0 > s0 && m1 <= s1)
        _autoTAMarkers.push({ time: dates[i], position: 'aboveBar', color: '#ef5350', shape: 'arrowDown', text: '▼', size: 1 });
    }
  }

  // Draw S/R levels
  const srLevels = computeSRClusters([...lows.map(p => p.price), ...highs.map(p => p.price)]);
  drawSRLines(srLevels, ohlcv[n - 1].close);

  flushMarkers();
  markRender();
  renderAutoTAPanel(ohlcv, t, lows, highs, srLevels);
}

function computeSRClusters(prices, tol = 0.015) {
  if (!prices.length) return [];
  const sorted = [...prices].sort((a, b) => a - b);
  const clusters = [];
  let cluster = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] - cluster[0]) / cluster[0] <= tol) {
      cluster.push(sorted[i]);
    } else {
      clusters.push(cluster);
      cluster = [sorted[i]];
    }
  }
  clusters.push(cluster);
  return clusters
    .map(c => ({ price: c.reduce((s, v) => s + v, 0) / c.length, touches: c.length }))
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 6);
}

function drawSRLines(levels, currentPrice) {
  clearSRLines();
  if (!candleSeries) return;
  for (const lvl of levels) {
    if (lvl.touches < 2) continue;
    const isSupport = lvl.price < currentPrice;
    const pl = candleSeries.createPriceLine({
      price: lvl.price,
      color: isSupport ? 'rgba(0,230,118,0.5)' : 'rgba(255,79,79,0.5)',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `S/R ×${lvl.touches}`,
    });
    _srPriceLines.push(pl);
  }
}

function renderAutoTAPanel(ohlcv, t, lows, highs, srLevels) {
  const panel = document.getElementById('autoTAPanel');
  if (!panel) return;

  const n     = ohlcv.length;
  const close = ohlcv[n-1].close;
  const high  = ohlcv[n-1].high;
  const low   = ohlcv[n-1].low;
  const findings = [];
  let bull = 0, bear = 0;

  // 1. Trend
  let trendFinding = null;
  for (let i = lows.length - 1; i >= 1; i--) {
    if (lows[i].price > lows[i-1].price) {
      trendFinding = { icon: '↗', lbl: 'TREND', val: `Uptrend — lows rising $${lows[i-1].price.toFixed(2)} → $${lows[i].price.toFixed(2)}`, color: '#26a69a' };
      bull++;
      break;
    }
  }
  if (!trendFinding) {
    for (let i = highs.length - 1; i >= 1; i--) {
      if (highs[i].price < highs[i-1].price) {
        trendFinding = { icon: '↘', lbl: 'TREND', val: `Downtrend — highs falling $${highs[i-1].price.toFixed(2)} → $${highs[i].price.toFixed(2)}`, color: '#ef5350' };
        bear++;
        break;
      }
    }
  }
  findings.push(trendFinding || { icon: '→', lbl: 'TREND', val: 'Range-bound — no clear direction in recent pivots', color: 'var(--text2)' });

  // 2. MACD — most recent crossover within last 40 bars, or current stance
  let macdFinding = null;
  if (t.macd && t.macd_signal) {
    let cross = null;
    const lookback = Math.min(40, n - 1);
    for (let i = n - lookback; i < n; i++) {
      const m0 = t.macd[i-1], s0 = t.macd_signal[i-1];
      const m1 = t.macd[i],   s1 = t.macd_signal[i];
      if (m0 == null || s0 == null || m1 == null || s1 == null) continue;
      if (m0 < s0 && m1 >= s1) cross = { dir: 'bull', daysAgo: n - 1 - i };
      else if (m0 > s0 && m1 <= s1) cross = { dir: 'bear', daysAgo: n - 1 - i };
    }
    if (cross) {
      const ago = cross.daysAgo === 0 ? 'today' : `${cross.daysAgo}d ago`;
      if (cross.dir === 'bull') {
        macdFinding = { icon: '⚡', lbl: 'MACD', val: `Bullish crossover ${ago} — momentum shifting up`, color: '#26a69a' };
        bull++;
      } else {
        macdFinding = { icon: '⚡', lbl: 'MACD', val: `Bearish crossover ${ago} — momentum shifting down`, color: '#ef5350' };
        bear++;
      }
    } else {
      const mLast = t.macd[n-1], sLast = t.macd_signal[n-1];
      if (mLast != null && sLast != null) {
        const aboveSig = mLast > sLast;
        const gap = Math.abs(mLast - sLast).toFixed(3);
        macdFinding = { icon: '⚡', lbl: 'MACD', val: aboveSig ? `Above signal line (gap ${gap}) — bullish momentum` : `Below signal line (gap ${gap}) — bearish momentum`, color: aboveSig ? '#26a69a' : '#ef5350' };
        if (aboveSig) bull += 0.5; else bear += 0.5;
      }
    }
  }
  if (macdFinding) findings.push(macdFinding);

  // 3. RSI
  const rsiVal = t.rsi?.[n-1];
  if (rsiVal != null) {
    if (rsiVal >= 70) {
      findings.push({ icon: '⚠', lbl: 'RSI', val: `${rsiVal.toFixed(1)} — overbought territory, pullback risk elevated`, color: '#ff9800' });
      bear += 0.5;
    } else if (rsiVal <= 30) {
      findings.push({ icon: '⚠', lbl: 'RSI', val: `${rsiVal.toFixed(1)} — oversold territory, mean-reversion bounce possible`, color: '#00bcd4' });
      bull += 0.5;
    } else if (rsiVal >= 55) {
      findings.push({ icon: '○', lbl: 'RSI', val: `${rsiVal.toFixed(1)} — upper neutral, bullish bias`, color: '#a5d6a7' });
      bull += 0.25;
    } else if (rsiVal <= 45) {
      findings.push({ icon: '○', lbl: 'RSI', val: `${rsiVal.toFixed(1)} — lower neutral, bearish bias`, color: '#ef9a9a' });
      bear += 0.25;
    } else {
      findings.push({ icon: '○', lbl: 'RSI', val: `${rsiVal.toFixed(1)} — mid neutral, no directional edge`, color: 'var(--text2)' });
    }
  }

  // 4. Bollinger Bands — where is price within the band?
  const bbU = t.bb_upper?.[n-1], bbL = t.bb_lower?.[n-1], bbM = t.bb_mid?.[n-1] || t.sma20?.[n-1];
  if (bbU != null && bbL != null) {
    const bbRange = bbU - bbL;
    const bbPct   = bbRange > 0 ? (close - bbL) / bbRange : 0.5;
    const bw = bbRange > 0 && close > 0 ? (bbRange / close * 100).toFixed(1) : null;
    const bwNote = bw ? ` · bandwidth ${bw}%` : '';
    if (bbPct >= 0.85) {
      findings.push({ icon: '⬆', lbl: 'BB', val: `Near upper band $${bbU.toFixed(2)}${bwNote} — price stretched, expect mean reversion toward $${bbM ? bbM.toFixed(2) : 'mid'}`, color: '#ff9800' });
      bear += 0.5;
    } else if (bbPct <= 0.15) {
      findings.push({ icon: '⬇', lbl: 'BB', val: `Near lower band $${bbL.toFixed(2)}${bwNote} — testing support, watch for bounce toward $${bbM ? bbM.toFixed(2) : 'mid'}`, color: '#00bcd4' });
      bull += 0.5;
    } else {
      const pctStr = (bbPct * 100).toFixed(0);
      findings.push({ icon: '◯', lbl: 'BB', val: `${pctStr}% of band range${bwNote} — mid-band, no squeeze or breakout signal`, color: 'var(--text2)' });
    }
  }

  // 5. SMA structure — price vs SMA20/50 + golden/death cross
  const sma20v = t.sma20?.[n-1], sma50v = t.sma50?.[n-1], sma200v = t.sma200?.[n-1];
  if (sma20v != null && sma50v != null) {
    const aboveBoth = close > sma20v && close > sma50v;
    const belowBoth = close < sma20v && close < sma50v;
    const dist20 = ((close - sma20v) / sma20v * 100).toFixed(1);
    const dist50 = ((close - sma50v) / sma50v * 100).toFixed(1);
    if (aboveBoth && sma20v > sma50v) {
      findings.push({ icon: '✓', lbl: 'SMA', val: `Above SMA20 (+${dist20}%) & SMA50 (+${dist50}%) — bullish alignment; golden structure`, color: '#26a69a' });
      bull++;
    } else if (belowBoth && sma20v < sma50v) {
      findings.push({ icon: '✗', lbl: 'SMA', val: `Below SMA20 (${dist20}%) & SMA50 (${dist50}%) — bearish alignment; death cross structure`, color: '#ef5350' });
      bear++;
    } else if (close > sma20v && close < sma50v) {
      findings.push({ icon: '~', lbl: 'SMA', val: `Above SMA20 (+${dist20}%) but below SMA50 — recovery attempt, $${sma50v.toFixed(2)} is resistance`, color: '#ffd54f' });
    } else {
      findings.push({ icon: '~', lbl: 'SMA', val: `Below SMA20 (${dist20}%) but above SMA50 — caution, watch SMA20 at $${sma20v.toFixed(2)} as resistance`, color: '#ffd54f' });
    }
    if (sma200v != null) {
      const dist200 = ((close - sma200v) / sma200v * 100).toFixed(1);
      const above200 = close > sma200v;
      findings.push({ icon: above200 ? '✓' : '✗', lbl: 'SMA200', val: `${above200 ? 'Above' : 'Below'} long-term average $${sma200v.toFixed(2)} (${dist200}%) — ${above200 ? 'secular uptrend intact' : 'secular downtrend, caution'}`, color: above200 ? '#a5d6a7' : '#ef9a9a' });
      if (above200) bull += 0.5; else bear += 0.5;
    }
  }

  // 6. Volume analysis
  const volumes = ohlcv.map(b => b.volume).filter(v => v != null && v > 0);
  if (volumes.length >= 10) {
    const lastVol   = volumes[volumes.length - 1];
    const avg20     = volumes.slice(-Math.min(20, volumes.length - 1)).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length - 1);
    const volRatio  = lastVol / avg20;
    const priceUp   = ohlcv[n-1].close >= ohlcv[n-2]?.close;
    const volFmtK   = v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v.toFixed(0);
    if (volRatio >= 1.5) {
      const dir = priceUp ? 'up on heavy volume — institutional buying likely' : 'down on heavy volume — distribution pressure';
      findings.push({ icon: '📊', lbl: 'VOL', val: `${volRatio.toFixed(1)}× avg (${volFmtK(lastVol)}) — ${dir}`, color: priceUp ? '#26a69a' : '#ef5350' });
      if (priceUp) bull += 0.5; else bear += 0.5;
    } else if (volRatio <= 0.5) {
      findings.push({ icon: '📊', lbl: 'VOL', val: `${volRatio.toFixed(1)}× avg (${volFmtK(lastVol)}) — low conviction, move may not sustain`, color: 'var(--text2)' });
    } else {
      findings.push({ icon: '📊', lbl: 'VOL', val: `${volRatio.toFixed(1)}× avg (${volFmtK(lastVol)}) — normal activity, no surge or exhaustion`, color: 'var(--text2)' });
    }
  }

  // 7. ATR / Volatility
  const atrArr = t.atr?.filter(v => v != null);
  let atrVal = null;
  if (atrArr && atrArr.length >= 5) {
    atrVal = atrArr[atrArr.length - 1];
    const atrAvg = atrArr.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, atrArr.length);
    const atrPct = (atrVal / close * 100).toFixed(2);
    if (atrVal > atrAvg * 1.2) {
      findings.push({ icon: '〰', lbl: 'ATR', val: `$${atrVal.toFixed(2)} daily range (${atrPct}%) — volatility expanding, widen stops`, color: '#ffd54f' });
    } else if (atrVal < atrAvg * 0.8) {
      findings.push({ icon: '〰', lbl: 'ATR', val: `$${atrVal.toFixed(2)} daily range (${atrPct}%) — volatility contracting, potential breakout building`, color: '#00bcd4' });
    }
  }

  // 8. S/R levels
  let nearestSupport = null, nearestResist = null;
  if (srLevels && srLevels.length) {
    const sig = srLevels.filter(l => l.touches >= 2);
    const supports    = sig.filter(l => l.price < close).sort((a, b) => b.price - a.price);
    const resistances = sig.filter(l => l.price >= close).sort((a, b) => a.price - b.price);
    nearestSupport = supports[0] || null;
    nearestResist  = resistances[0] || null;
    const parts = [];
    if (nearestSupport)  parts.push(`support $${nearestSupport.price.toFixed(2)} (tested ×${nearestSupport.touches})`);
    if (nearestResist)   parts.push(`resistance $${nearestResist.price.toFixed(2)} (tested ×${nearestResist.touches})`);
    if (parts.length)
      findings.push({ icon: '⊟', lbl: 'S/R', val: parts.join(' · '), color: 'var(--text)' });
  }

  // ── Outlook / Watch section ───────────────────────────────────────
  const bias = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
  const biasColor = bias === 'bullish' ? '#26a69a' : bias === 'bearish' ? '#ef5350' : '#ffd54f';
  const totalPts = bull + bear;
  const scoreLabel = `${bull % 1 === 0 ? bull.toFixed(0) : bull.toFixed(1)} bull / ${bear % 1 === 0 ? bear.toFixed(0) : bear.toFixed(1)} bear`;

  // Target and stop logic
  const targetPrice  = nearestResist?.price  || (close * 1.05);
  const stopPrice    = nearestSupport?.price || (sma20v ? sma20v : close * 0.97);
  const targetPct    = ((targetPrice - close) / close * 100).toFixed(1);
  const stopPct      = ((close - stopPrice) / close * 100).toFixed(1);
  const riskReward   = stopPct > 0 ? (parseFloat(targetPct) / parseFloat(stopPct)).toFixed(1) : null;

  let watchLines = [];
  if (bias === 'bullish') {
    let line1 = `Bias bullish (${scoreLabel}). `;
    if (rsiVal >= 70) line1 += `RSI at ${rsiVal.toFixed(0)} is overbought — high risk of a brief consolidation or pullback before any continuation.`;
    else if (bbU && close / bbU > 0.97) line1 += `Price is pressing the upper Bollinger Band — expect a short pause or minor dip before bulls re-test the highs.`;
    else line1 += `Multiple indicators align bullish with no immediate warning signals.`;
    watchLines.push(line1);

    let line2 = `Watch for a break above $${high.toFixed(2)} to confirm next leg up toward ${nearestResist ? `$${nearestResist.price.toFixed(2)}` : `$${targetPrice.toFixed(2)}`}`;
    if (sma20v) line2 += `. Dips to SMA20 ($${sma20v.toFixed(2)}) would be a low-risk entry zone.`;
    else line2 += '.';
    watchLines.push(line2);

    let line3 = `Suggested stop below $${stopPrice.toFixed(2)} (${stopPct}% risk)`;
    if (riskReward) line3 += `, targeting $${targetPrice.toFixed(2)} — implied R/R ${riskReward}:1.`;
    else line3 += '.';
    watchLines.push(line3);

  } else if (bias === 'bearish') {
    let line1 = `Bias bearish (${scoreLabel}). `;
    if (rsiVal <= 30) line1 += `RSI at ${rsiVal.toFixed(0)} is oversold — bears dominate but a technical bounce is possible near key support.`;
    else line1 += `Downside pressure is building across multiple timeframes.`;
    watchLines.push(line1);

    const keySupport = nearestSupport ? `$${nearestSupport.price.toFixed(2)}` : (sma50v ? `SMA50 $${sma50v.toFixed(2)}` : `$${low.toFixed(2)}`);
    watchLines.push(`Key support to watch: ${keySupport}. A close below that level opens further downside toward $${(stopPrice * 0.97).toFixed(2)}.`);
    watchLines.push(`Resistance overhead at ${nearestResist ? `$${nearestResist.price.toFixed(2)}` : `$${high.toFixed(2)}`} — bulls need a clear close above that to invalidate the bearish setup.`);

  } else {
    watchLines.push(`Mixed signals (${scoreLabel}) — neither bulls nor bears have conviction.`);
    watchLines.push(`Bulls need a break above $${high.toFixed(2)}${nearestResist ? ` / $${nearestResist.price.toFixed(2)} resistance` : ''} to take control. Bears need a break below $${low.toFixed(2)}${nearestSupport ? ` / $${nearestSupport.price.toFixed(2)} support` : ''}.`);
    watchLines.push(`Watch volume on the next directional move — the side with higher volume wins.`);
  }

  // ── Score bar ────────────────────────────────────────────────────
  const barBullPct = totalPts > 0 ? Math.round(bull / totalPts * 100) : 50;
  const barBearPct = 100 - barBullPct;

  // Render
  panel.innerHTML =
    `<div class="autota-score-row">
       <span class="autota-score-lbl" style="color:${biasColor}">${bias.toUpperCase()}</span>
       <div class="autota-score-bar">
         <div class="autota-score-bull" style="width:${barBullPct}%"></div>
         <div class="autota-score-bear" style="width:${barBearPct}%"></div>
       </div>
       <span class="autota-score-pts">${scoreLabel}</span>
     </div>
     <div class="autota-findings-grid">` +
    findings.map(f =>
      `<div class="autota-finding">
        <span class="autota-icon">${f.icon}</span>
        <span class="autota-lbl">${f.lbl}</span>
        <span class="autota-val" style="color:${f.color}">${f.val}</span>
      </div>`
    ).join('') +
    `</div>
     <div class="autota-outlook">
       <div class="autota-outlook-title" style="color:${biasColor}">OUTLOOK</div>
       ${watchLines.map(l => `<div class="autota-outlook-line">${l}</div>`).join('')}
     </div>`;
  panel.style.display = 'block';
}

// ── Insider transactions ───────────────────────────────────────────
async function loadInsider() {
  const el = document.getElementById('insiderFeed');
  if (!el) return;
  try {
    const rows = await fetch(`/api/insider/${TICKER}`).then(r => r.json());
    if (!rows.length) { el.innerHTML = '<div class="fund-loading">No data</div>'; return; }

    // Render sidebar list
    el.innerHTML = rows.slice(0, 15).map(r => {
      const cls  = r.type.toLowerCase();
      const val  = r.value ? ' · <span class="insider-val">$' + fmtMCapRaw(r.value) + '</span>' : '';
      const shrs = r.shares ? r.shares.toLocaleString() + ' shares' : '';
      return `<div class="insider-row ${cls}">
        <span class="insider-name">${r.name}</span>
        <span class="insider-badge ${cls}">${r.type}</span>
        <span class="insider-meta">${r.position} · ${r.date}${val ? ' · ' : ''}${val}${shrs ? ' · ' + shrs : ''}</span>
      </div>`;
    }).join('');

    // Add markers to price chart
    if (!candleSeries || !chartData?.ohlcv?.length) return;
    const chartDates = chartData.ohlcv.map(x => x.date);
    const insiderMap = {};
    for (const r of rows) {
      if (r.type !== 'Buy' && r.type !== 'Sell') continue;
      const nearest = findNearestDate(r.date, chartDates);
      if (!nearest) continue;
      if (!insiderMap[nearest]) insiderMap[nearest] = { buy: 0, sell: 0 };
      if (r.type === 'Buy')  insiderMap[nearest].buy++;
      if (r.type === 'Sell') insiderMap[nearest].sell++;
    }
    _insiderMarkers = [];
    for (const [date, counts] of Object.entries(insiderMap)) {
      if (counts.buy)  _insiderMarkers.push({ time: date, position: 'belowBar', color: '#26a69a', shape: 'arrowUp',   text: counts.buy  > 1 ? `B×${counts.buy}`  : 'B', size: 1 });
      if (counts.sell) _insiderMarkers.push({ time: date, position: 'aboveBar', color: '#ef5350', shape: 'arrowDown', text: counts.sell > 1 ? `S×${counts.sell}` : 'S', size: 1 });
    }
    flushMarkers();
  } catch (e) {
    if (el) el.innerHTML = '<div class="fund-loading">Failed to load</div>';
  }
}

function fmtMCapRaw(v) {
  if (v >= 1e9) return (v/1e9).toFixed(1)+'B';
  if (v >= 1e6) return (v/1e6).toFixed(1)+'M';
  if (v >= 1e3) return (v/1e3).toFixed(0)+'K';
  return v.toFixed(0);
}

// ── Earnings date ─────────────────────────────────────────────────
async function loadEarnings() {
  try {
    const res = await fetch(`/api/earnings/${TICKER}`);
    const data = await res.json();
    const dateStr = data.next_earnings;
    if (!dateStr) return;

    const badge = document.getElementById('earningsBadge');
    if (badge) {
      const earDate = new Date(dateStr);
      const today   = new Date(); today.setHours(0, 0, 0, 0);
      const diffMs  = earDate - today;
      const diffD   = Math.round(diffMs / 86400000);
      const when = diffD === 0 ? 'today' : diffD === 1 ? 'tomorrow' :
                   diffD > 0  ? `in ${diffD}d` : `${-diffD}d ago`;
      badge.innerHTML = `📅 Next earnings: <strong>${dateStr}</strong> &nbsp;(${when})`;
      badge.style.display = 'flex';
    }

    // Add marker if the date falls within the chart's range
    if (!chartData?.ohlcv?.length) return;
    const chartDates = chartData.ohlcv.map(x => x.date);
    const nearest = findNearestDate(dateStr, chartDates);
    if (nearest) {
      _earningsMarkers = [{
        time: nearest, position: 'aboveBar',
        color: '#ab47bc', shape: 'circle', text: 'E', size: 1,
      }];
      flushMarkers();
    }
  } catch {}
}

// ── Per-ticker notes ──────────────────────────────────────────────
function loadTickerNote() {
  const ta = document.getElementById('tickerNote');
  if (!ta) return;
  ta.value = localStorage.getItem(`note_${TICKER}`) || '';
  ta.addEventListener('input', () => {
    const v = ta.value.trim();
    if (v) localStorage.setItem(`note_${TICKER}`, ta.value);
    else   localStorage.removeItem(`note_${TICKER}`);
  });
}

// ── Comparison overlay ────────────────────────────────────────────
let _compareUniverse = [];
(async () => {
  try {
    const r = await fetch('/api/screen', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({filters:{}, sort_by:'marketCap', sort_dir:'desc', page:1, per_page:600}),
    });
    _compareUniverse = (await r.json()).results || [];
  } catch {}
})();

function setupCompare() {
  const input = document.getElementById('compareInput');
  const dd    = document.getElementById('compareDropdown');
  if (!input) return;

  let debounce;
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase();
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) { dd.classList.remove('open'); return; }
    debounce = setTimeout(() => {
      const found = _compareUniverse.filter(s =>
        s.symbol?.toUpperCase().startsWith(q) ||
        (s.shortName||'').toUpperCase().includes(q)
      ).slice(0, 6);
      if (!found.length) { dd.classList.remove('open'); return; }
      dd.innerHTML = found.map(s => `
        <div class="search-result-item" data-symbol="${s.symbol}">
          <span class="search-ticker">${s.symbol}</span>
          <span class="search-name">${s.shortName||''}</span>
        </div>`).join('');
      dd.querySelectorAll('.search-result-item').forEach(el => {
        el.addEventListener('mousedown', e => {
          e.preventDefault();
          _addCompareTicker(el.dataset.symbol);
          input.value = '';
          dd.classList.remove('open');
        });
      });
      dd.classList.add('open');
    }, 150);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const t = input.value.trim().toUpperCase();
      if (t) { _addCompareTicker(t); input.value = ''; dd.classList.remove('open'); }
    }
    if (e.key === 'Escape') { dd.classList.remove('open'); input.value = ''; }
  });

  document.addEventListener('click', ev => {
    if (!input.closest('.compare-input-wrap')?.contains(ev.target)) dd.classList.remove('open');
  });
}

function _addCompareTicker(ticker) {
  ticker = ticker.replace(/[^A-Z0-9.]/g, '');
  if (!ticker || ticker === TICKER || compMap[ticker]) return;
  loadCompareData(ticker);
}

async function loadCompareData(input) {
  if (!chartData?.ohlcv?.length) return;

  const newTickers = (input || '').toUpperCase()
    .split(/[\s,]+/)
    .map(t => t.replace(/[^A-Z0-9.]/g, ''))
    .filter(t => t && t !== TICKER)
    .slice(0, 8);

  if (!newTickers.length) { _updateCompareResult(); return; }

  // Load each new ticker (skip ones already loaded for this period)
  const toLoad = newTickers.filter(t => !compMap[t]);
  await Promise.all(toLoad.map(async (ticker) => {
    const colorIdx = Object.keys(compMap).length % COMP_COLORS.length;
    const color = COMP_COLORS[colorIdx];
    try {
      const res = await fetch(`/api/chart/${ticker}?period=${currentPeriod}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (!data?.ohlcv?.length) throw new Error();

      const mainBars  = chartData.ohlcv;
      const mainStart = mainBars[0].date;
      const compBars  = data.ohlcv.filter(b => b.date >= mainStart);
      if (!compBars.length) throw new Error();

      const mainBase = mainBars[0].close;
      const compBase = compBars[0].close;
      const normalized = compBars.map(b => ({
        time: b.date,
        value: (b.close / compBase) * mainBase,
      }));

      const series = priceChart.addLineSeries({
        color, lineWidth: 1.5,
        priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerVisible: false, title: ticker,
      });
      series.setData(normalized);
      compMap[ticker] = { series, bars: compBars, color };
    } catch {
      // flash input red briefly on error
      const inputEl = document.getElementById('compareInput');
      if (inputEl) { inputEl.style.borderColor='#ef5350'; setTimeout(()=>{ inputEl.style.borderColor=''; },1500); }
    }
  }));

  _updateCompareResult();
}

function _updateCompareResult() {
  const chipsEl  = document.getElementById('compareChips');
  const resultEl = document.getElementById('compareResult');
  if (!chipsEl) return;

  const tickers = Object.keys(compMap);

  // Render chips
  chipsEl.innerHTML = tickers.map(t => {
    const { color } = compMap[t];
    return `<span class="comp-chip" style="border-color:${color};color:${color}" data-ticker="${t}">
      ${t} <span class="comp-chip-x" data-ticker="${t}">×</span>
    </span>`;
  }).join('');
  chipsEl.querySelectorAll('.comp-chip-x').forEach(x => {
    x.addEventListener('click', e => { e.stopPropagation(); removeCompareTicker(x.dataset.ticker); });
  });

  // Performance summary
  if (!tickers.length || !chartData?.ohlcv?.length) {
    if (resultEl) resultEl.style.display = 'none';
    return;
  }
  const mainBars = chartData.ohlcv;
  const mainBase = mainBars[0].close;
  const mainPct  = ((mainBars[mainBars.length-1].close / mainBase - 1) * 100).toFixed(1);
  const parts = [
    `<span style="color:#8899aa">${TICKER}</span> <span style="color:${+mainPct>=0?'#26a69a':'#ef5350'}">${+mainPct>=0?'+':''}${mainPct}%</span>`,
  ];
  for (const [t, {bars, color}] of Object.entries(compMap)) {
    const pct = ((bars[bars.length-1].close / bars[0].close - 1) * 100).toFixed(1);
    parts.push(`<span style="color:${color}">${t}</span> <span style="color:${+pct>=0?'#26a69a':'#ef5350'}">${+pct>=0?'+':''}${pct}%</span>`);
  }
  if (resultEl) { resultEl.innerHTML = parts.join(' <span style="color:#555">|</span> '); resultEl.style.display = ''; }
}

function removeCompareTicker(ticker) {
  if (!compMap[ticker]) return;
  try { priceChart.removeSeries(compMap[ticker].series); } catch {}
  delete compMap[ticker];
  _updateCompareResult();
}

function clearCompare() {
  for (const {series} of Object.values(compMap)) { try { priceChart.removeSeries(series); } catch {} }
  for (const k of Object.keys(compMap)) delete compMap[k];
  const input = document.getElementById('compareInput');
  if (input) input.value = '';
  _updateCompareResult();
}

// ── SEC Filings ────────────────────────────────────────────────────
function openFilingsPanel(btn) {
  switchSidebarTab('filings', btn);
  const body = document.getElementById('filingsBody');
  if (body && !body.dataset.loaded) {
    body.dataset.loaded = '1';
    loadFilings();
  }
}

function _mdSimple(text) {
  if (!text) return '';
  let s = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  s = s.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
  return `<p>${s}</p>`;
}

async function loadFilings() {
  const body = document.getElementById('filingsBody');
  if (!body) return;
  body.innerHTML = '<div class="intel-loading">Analysing SEC filings…<span class="intel-dots"></span></div>';
  try {
    const d = await fetch(`/api/filings-summary/${TICKER}`).then(r => r.json());
    if (d.error) {
      body.innerHTML = `<div class="intel-error">⚠ ${d.message || d.error}</div>`;
      return;
    }
    body.innerHTML = `
      <div class="filings-company">${d.company || TICKER} · ${d.filing_count || ''} recent filings</div>
      <div class="filings-ai-summary">${_mdSimple(d.summary)}</div>`;
  } catch (e) {
    body.innerHTML = `<div class="intel-error">⚠ ${e.message}</div>`;
  }
}

// ── Sidebar tabs ───────────────────────────────────────────────────
const _SIDEBAR_TABS = ['fund', 'news', 'insider', 'intel', 'swing', 'filings'];

function switchSidebarTab(name, btn) {
  _SIDEBAR_TABS.forEach(t => {
    const pane = document.getElementById('stab-' + t);
    const b    = document.querySelector(`.stab[data-tab="${t}"]`);
    if (pane) pane.style.display = t === name ? '' : 'none';
    if (b)    b.classList.toggle('active', t === name);
  });
}

// ── Drawing toolbar toggle ─────────────────────────────────────────
function toggleDrawToolbar(btn) {
  const tb = document.getElementById('drawingToolbar');
  if (!tb) return;
  const hidden = tb.style.display === 'none';
  tb.style.display = hidden ? 'flex' : 'none';
  btn.classList.toggle('active', hidden);
  if (!hidden) setDrawTool('none');
}

// ── Floating chart overlay panels (legacy kept for compat) ─────────
function toggleChartPanel(panelId, btn) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  btn?.classList.toggle('active', !isOpen);
}

// ── Format helpers ─────────────────────────────────────────────────
function fmt1(v)  { return v != null ? v.toFixed(1)            : '—'; }
function fmt2(v)  { return v != null ? v.toFixed(2)            : '—'; }
function fmtPct(v){ return v != null ? (v*100).toFixed(1) + '%': '—'; }
function fmtVol(v){
  if (v >= 1e9) return (v/1e9).toFixed(1)+'B';
  if (v >= 1e6) return (v/1e6).toFixed(1)+'M';
  if (v >= 1e3) return (v/1e3).toFixed(0)+'K';
  return String(v);
}
function fmtMCap(v) {
  if (!v) return '—';
  if (window.Currency) return window.Currency.formatLarge(v);
  if (v >= 1e12) return '$'+(v/1e12).toFixed(2)+'T';
  if (v >= 1e9)  return '$'+(v/1e9) .toFixed(1)+'B';
  if (v >= 1e6)  return '$'+(v/1e6) .toFixed(1)+'M';
  return '$'+v;
}

function setupChartSidebarResize() {
  const sidebar = document.getElementById('chartSidebar');
  const resizer = document.getElementById('sidebarResizer');
  if (!sidebar || !resizer) return;

  const STORE_KEY = 'chart_sidebar_width';
  const MIN = 140, MAX = 520;

  const saved = parseInt(localStorage.getItem(STORE_KEY), 10);
  if (saved >= MIN && saved <= MAX) sidebar.style.width = saved + 'px';

  let startX, startW;

  resizer.addEventListener('mousedown', e => {
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const delta = startX - e.clientX;
      const w = Math.min(MAX, Math.max(MIN, startW + delta));
      sidebar.style.width = w + 'px';
      if (priceChart) priceChart.timeScale().fitContent();
    }
    function onUp() {
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(STORE_KEY, parseInt(sidebar.style.width, 10));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Journal modal (from chart page) ──────────────────────────────────────────

function _jfSeg(groupId, val) {
  document.querySelectorAll(`#${groupId} .jnl-seg-btn`).forEach(b => {
    b.classList.toggle('active', b.dataset.val === val);
  });
}
function _jfGetSeg(groupId) {
  return document.querySelector(`#${groupId} .jnl-seg-btn.active`)?.dataset.val || '';
}

document.querySelectorAll('#jfDirection .jnl-seg-btn, #jfStatus .jnl-seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _jfSeg(btn.closest('.jnl-seg').id, btn.dataset.val);
  });
});

function openJournalModal() {
  const overlay = document.getElementById('jnlModalOverlay');
  if (!overlay) return;
  document.getElementById('jnlModalTicker').textContent = TICKER;
  // Pre-fill entry price from current displayed price
  const priceEl = document.getElementById('stockPrice');
  const price = priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '')) : '';
  document.getElementById('jfEntry').value  = price || '';
  document.getElementById('jfTarget').value = '';
  document.getElementById('jfStop').value   = '';
  document.getElementById('jfNotes').value  = '';
  _jfSeg('jfDirection', 'Long');
  _jfSeg('jfStatus', 'Idea');
  overlay.style.display = 'flex';
  document.getElementById('jfNotes').focus();
}

function closeJournalModal() {
  const overlay = document.getElementById('jnlModalOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function saveJournalEntry() {
  const body = {
    ticker:      TICKER,
    direction:   _jfGetSeg('jfDirection'),
    status:      _jfGetSeg('jfStatus'),
    entry_price: document.getElementById('jfEntry').value  || null,
    target:      document.getElementById('jfTarget').value || null,
    stop:        document.getElementById('jfStop').value   || null,
    notes:       document.getElementById('jfNotes').value.trim(),
    date_opened: new Date().toISOString().split('T')[0],
  };
  try {
    const r = await fetch('/api/journal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    closeJournalModal();
    // Brief flash on button
    const btn = document.getElementById('jnlLogBtn');
    if (btn) { btn.textContent = '✓ Saved'; setTimeout(() => { btn.textContent = '📓 Log'; }, 2000); }
  } catch (err) {
    alert('Failed to save: ' + err.message);
  }
}

// ── Journal sidebar tab ───────────────────────────────────────────────────────

let _cjnlEntries = null; // null = not loaded yet

// Wire up segmented controls in journal tab
document.querySelectorAll('#cjfDirection .jnl-seg-btn, #cjfStatus .jnl-seg-btn').forEach(btn => {
  btn.addEventListener('click', () => _jfSeg(btn.closest('.jnl-seg').id, btn.dataset.val));
});

async function openJournalTab(tabBtn) {
  switchSidebarTab('journal', tabBtn);
  if (_cjnlEntries === null) await cjnlLoad();
}

async function cjnlLoad() {
  try {
    const r = await fetch('/api/journal');
    if (!r.ok) throw new Error();
    const all = await r.json();
    _cjnlEntries = all.filter(e => e.ticker === TICKER);
  } catch {
    _cjnlEntries = [];
  }
  // Pre-fill entry price
  const priceEl = document.getElementById('stockPrice');
  const price = priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '')) : '';
  if (price && document.getElementById('cjfEntry')) document.getElementById('cjfEntry').value = price;
  cjnlRender();
}

function cjnlRender() {
  const container = document.getElementById('cjnlEntries');
  const empty     = document.getElementById('cjnlEmpty');
  if (!container) return;
  if (!_cjnlEntries?.length) { empty.style.display = ''; container.innerHTML = ''; container.appendChild(empty); return; }
  empty.style.display = 'none';
  container.innerHTML = _cjnlEntries.map(e => {
    const pnl = cjnlCalcPnl(e);
    const pnlHtml = pnl !== null ? `<span class="cjnl-pnl ${pnl >= 0 ? 'green' : 'red'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%</span>` : '';
    const statusClass = { Idea: 'idea', Open: 'open', Closed: 'closed' }[e.status] || '';
    return `
    <div class="cjnl-entry" data-id="${e.id}">
      <div class="cjnl-entry-top">
        <span class="jnl-dir ${e.direction === 'Short' ? 'short' : 'long'}">${e.direction}</span>
        <span class="jnl-status ${statusClass}">${e.status}</span>
        ${pnlHtml}
        <span class="cjnl-date">${e.date_opened || ''}</span>
        <button class="cjnl-del" data-id="${e.id}" title="Delete">✕</button>
      </div>
      ${e.entry_price ? `<div class="cjnl-prices">Entry $${e.entry_price}${e.target ? ` → $${e.target}` : ''}${e.stop ? ` | Stop $${e.stop}` : ''}</div>` : ''}
      ${e.notes ? `<div class="cjnl-entry-notes">${e.notes.replace(/\n/g,'<br>')}</div>` : ''}
    </div>`;
  }).join('');
  container.querySelectorAll('.cjnl-del').forEach(btn => {
    btn.addEventListener('click', () => cjnlDelete(btn.dataset.id));
  });
}

function cjnlCalcPnl(e) {
  if (e.status !== 'Closed' || !e.entry_price || !e.close_price) return null;
  const ep = parseFloat(e.entry_price), cp = parseFloat(e.close_price);
  return e.direction === 'Short' ? (ep - cp) / ep * 100 : (cp - ep) / ep * 100;
}

async function cjnlSave() {
  const notes = document.getElementById('cjfNotes')?.value.trim();
  const body = {
    ticker:      TICKER,
    direction:   _jfGetSeg('cjfDirection'),
    status:      _jfGetSeg('cjfStatus'),
    entry_price: document.getElementById('cjfEntry')?.value  || null,
    target:      document.getElementById('cjfTarget')?.value || null,
    stop:        document.getElementById('cjfStop')?.value   || null,
    notes,
    date_opened: new Date().toISOString().split('T')[0],
  };
  const saveBtn = document.querySelector('.cjnl-save-btn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const r = await fetch('/api/journal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const created = await r.json();
    if (_cjnlEntries === null) _cjnlEntries = [];
    _cjnlEntries.unshift(created);
    // Reset form
    if (document.getElementById('cjfNotes'))  document.getElementById('cjfNotes').value  = '';
    if (document.getElementById('cjfTarget')) document.getElementById('cjfTarget').value = '';
    if (document.getElementById('cjfStop'))   document.getElementById('cjfStop').value   = '';
    _jfSeg('cjfDirection', 'Long');
    _jfSeg('cjfStatus', 'Idea');
    cjnlRender();
  } catch (err) {
    alert('Failed to save: ' + err.message);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function cjnlDelete(id) {
  if (!confirm('Delete this entry?')) return;
  await fetch(`/api/journal/${id}`, { method: 'DELETE' });
  _cjnlEntries = _cjnlEntries.filter(e => e.id !== id);
  cjnlRender();
}

