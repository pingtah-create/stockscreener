/* chart.js — TradingView-style full-page chart with drawing tools
   Uses TradingView Lightweight Charts v4 (LightweightCharts global)
------------------------------------------------------------------ */

const LC = LightweightCharts;

// ── Theme ──────────────────────────────────────────────────────────
const CHART_OPT = {
  autoSize: true,
  layout: { background: { color: '#090e1a' }, textColor: '#8899aa', fontSize: 11 },
  grid:    { vertLines: { color: '#1a2540' }, horzLines: { color: '#1a2540' } },
  crosshair: {
    mode: 1,
    vertLine: { color: 'rgba(136,153,170,0.35)', width: 1, style: 1, labelBackgroundColor: '#1a2540' },
    horzLine: { color: 'rgba(136,153,170,0.35)', width: 1, style: 1, labelBackgroundColor: '#1a2540' },
  },
  rightPriceScale: { borderColor: '#1a2540', scaleMargins: { top: 0.08, bottom: 0.08 } },
  timeScale: { borderColor: '#1a2540', timeVisible: true, secondsVisible: false, rightOffset: 5 },
  handleScroll: true,
  handleScale:  true,
};

// ── State ──────────────────────────────────────────────────────────
let priceChart, volChart, oscChart;
let candleSeries, linePriceSeries;
let volSeries;
let oscSeriesList = [];
const overlayMap = {};   // key → LC series

let chartData    = null;
let currentOsc   = 'rsi';
let currentType  = 'candle';
let _syncingRange = false;

// ── Period auto-extend ────────────────────────────────────────────
const PERIOD_ORDER = ['5d','1mo','3mo','6mo','1y','2y','5y'];
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

// ── Indicator defaults ─────────────────────────────────────────────
const IND_ON = { bb: true, sma20: true, sma50: false, sma200: false, ema9: false, ema20: false, vwap: false };

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
  loadData('3mo');
  loadFundamentals();
  setupPeriodBtns();
  setupDrawingCanvas();
  startRenderLoop();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoDrawing(); }
    if (e.key === 'Escape') { setDrawTool('none'); closeChartSearch(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); document.getElementById('chartSearchInput')?.focus(); }
  });

  setupChartSearch();

  // Update color swatch CSS var
  updateDrawColor(drawColor);
});

// ── Create charts ──────────────────────────────────────────────────
function initCharts() {
  const volPanel = document.getElementById('volPanel');
  const oscPanel = document.getElementById('oscPanel');

  priceChart = LC.createChart(pricePanel, {
    ...CHART_OPT,
    rightPriceScale: { ...CHART_OPT.rightPriceScale },
  });

  volChart = LC.createChart(volPanel, {
    ...CHART_OPT,
    crosshair: { ...CHART_OPT.crosshair },
    rightPriceScale: { ...CHART_OPT.rightPriceScale, scaleMargins: { top: 0.1, bottom: 0 } },
    timeScale: { ...CHART_OPT.timeScale, visible: false },
  });

  oscChart = LC.createChart(oscPanel, {
    ...CHART_OPT,
    rightPriceScale: { ...CHART_OPT.rightPriceScale, scaleMargins: { top: 0.1, bottom: 0.1 } },
    timeScale: { ...CHART_OPT.timeScale, visible: false },
  });

  buildPriceSeries();
  buildVolSeries();
  buildOscSeries('rsi');

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
  priceChart.timeScale().subscribeVisibleLogicalRangeChange(makeSyncListener(priceChart, [volChart, oscChart]));
  volChart.timeScale().subscribeVisibleLogicalRangeChange(makeSyncListener(volChart, [priceChart, oscChart]));
  oscChart.timeScale().subscribeVisibleLogicalRangeChange(makeSyncListener(oscChart, [priceChart, volChart]));

  // Crosshair sync: overlay lines on vol + osc panels
  const volLine = createSyncLine(volPanel);
  const oscLine = createSyncLine(oscPanel);
  const priLine = createSyncLine(pricePanel);

  priceChart.subscribeCrosshairMove(p => {
    updateOHLCV(p);
    syncLine(volChart,  volLine,  p.time);
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
  volChart.subscribeCrosshairMove(p => {
    syncLine(priceChart, priLine, p.time);
    syncLine(oscChart,   oscLine, p.time);
  });
  oscChart.subscribeCrosshairMove(p => {
    syncLine(priceChart, priLine, p.time);
    syncLine(volChart,   volLine, p.time);
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
    upColor: '#00e676', downColor: '#ff4f4f',
    borderUpColor: '#00e676', borderDownColor: '#ff4f4f',
    wickUpColor: '#00e676', wickDownColor: '#ff4f4f',
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

// ── Volume series ──────────────────────────────────────────────────
function buildVolSeries() {
  volSeries = volChart.addHistogramSeries({
    color: '#26a69a',
    priceFormat: { type: 'volume' },
    priceScaleId: '',
  });
  volChart.priceScale('').applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
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
    const res = await fetch(`/api/chart/${TICKER}?period=${period}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    chartData = await res.json();
    if (!chartData?.ohlcv?.length) {
      const apiErr = chartData?.error || 'No data returned for this ticker.';
      showChartError(`Could not load chart data.<br><span style="color:#4a5568;font-size:11px">${apiErr}</span>`);
      return;
    }
    hideChartOverlay();
    applyAllData();
    await loadNewsMarkers();
    loadInsider();
    if (autoTAOn) applyAutoTA();
  } catch (e) {
    showChartError(`Failed to load chart.<br><span style="color:#4a5568;font-size:11px">${e.message}</span>`);
  }
}

// ── News markers ────────────────────────────────────────────────────
async function loadNewsMarkers() {
  if (!chartData?.ohlcv?.length) return;
  try {
    const items = await fetch(`/api/news/${TICKER}`).then(r => r.json());

    // Clear previous
    for (const k in newsData) delete newsData[k];

    const chartDates = chartData.ohlcv.map(x => x.date);
    const lastDate   = chartDates[chartDates.length - 1];

    for (const item of items) {
      if (!item.date) continue;
      const nearest = findNearestDate(item.date, chartDates);
      if (!nearest) continue;
      if (!newsData[nearest]) newsData[nearest] = [];
      newsData[nearest].push(item);
    }

    // One marker per date that has news — show all within the chart range
    const allDates = Object.keys(newsData).sort();
    _newsMarkers = allDates.map(date => ({
      time:     date,
      position: 'belowBar',
      color:    '#ff6b00',
      shape:    'circle',
      text:     newsData[date].length > 1 ? `${newsData[date].length}` : '',
      size:     0.8,
    }));
    flushMarkers();

    renderSidebarNews(items);
  } catch (e) {}
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

function renderSidebarNews(items) {
  const feed = document.getElementById('sidebarNewsFeed');
  if (!feed) return;
  if (!items.length) { feed.innerHTML = '<div class="fund-loading">No news found</div>'; return; }
  feed.innerHTML = items.slice(0, 15).map(n => {
    const age = n.age_min == null ? '' :
      n.age_min < 60   ? `${n.age_min}m ago` :
      n.age_min < 1440 ? `${Math.floor(n.age_min / 60)}h ago` :
      `${Math.floor(n.age_min / 1440)}d ago`;
    return `<a class="snews-item" href="${n.link}" target="_blank" rel="noopener noreferrer">
      <div class="snews-title">${n.title}</div>
      <div class="snews-meta">
        <span class="snews-pub">${n.publisher || ''}</span>
        ${age ? `<span>·</span><span>${age}</span>` : ''}
      </div>
    </a>`;
  }).join('');
}

let _lastNewsDate = null;

function showNewsTooltip(date) {
  const tooltip = document.getElementById('newsMarkerTooltip');
  if (!tooltip) return;
  const items = newsData[date];
  if (!items?.length) { hideNewsTooltip(); return; }

  // Don't re-render if already showing this date — prevents jumping
  if (_lastNewsDate === date && tooltip.style.display === 'block') return;
  _lastNewsDate = date;

  tooltip.innerHTML = `
    <div class="nmt-header">📰 News · ${date}</div>
    ${items.map(n => {
      const age = n.age_min == null ? '' :
        n.age_min < 60   ? `${n.age_min}m ago` :
        n.age_min < 1440 ? `${Math.floor(n.age_min / 60)}h ago` :
        `${Math.floor(n.age_min / 1440)}d ago`;
      return `<div class="nmt-item" onclick="window.open('${n.link}','_blank')">
        <div class="nmt-title">${n.title}</div>
        <div class="nmt-meta">
          <span class="nmt-pub">${n.publisher || ''}</span>
          ${age ? `<span class="nmt-age">· ${age}</span>` : ''}
        </div>
      </div>`;
    }).join('')}`;

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

  candleSeries.setData(ohlcv.map(x => ({ time: x.date, open: x.open, high: x.high, low: x.low, close: x.close })));
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

  const green = '#00e676', red = '#ff4f4f';
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
}

// ── Oscillator switch ──────────────────────────────────────────────
function setOsc(osc, btn) {
  document.querySelectorAll('.osc-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentOsc = osc;
  buildOscSeries(osc);
}

// ── Chart type switch ──────────────────────────────────────────────
function setChartType(type) {
  currentType = type;
  document.getElementById('btnCandle').classList.toggle('active', type === 'candle');
  document.getElementById('btnLine')  .classList.toggle('active', type === 'line');
  candleSeries   .applyOptions({ visible: type === 'candle' });
  linePriceSeries.applyOptions({ visible: type === 'line' });
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

async function loadFundamentals() {
  const res = await fetch(`/api/stock/${TICKER}`);
  const s   = await res.json();

  // Top bar
  const price = s.currentPrice || s.previousClose;
  const chg   = s.regularMarketChangePercent || 0;
  document.getElementById('stockName') .textContent = s.shortName || s.longName || '';
  document.getElementById('stockPrice').textContent = price ? '$' + price.toFixed(2) : '—';
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
    return `
      <div class="score-row">
        <div class="score-row-top">
          <span class="score-name">${name}</span>
          <span class="score-num">${sc}</span>
        </div>
        <div class="score-bar-bg">
          <div class="score-bar-fill" style="width:${sc}%"></div>
        </div>
      </div>`;
  }).join('');

  // 52-week range
  const lo  = s.fiftyTwoWeekLow;
  const hi  = s.fiftyTwoWeekHigh;
  const pos = s.fiftyTwoWeekPosition;
  document.getElementById('week52Lo').textContent = lo ? '$' + lo.toFixed(2) : '—';
  document.getElementById('week52Hi').textContent = hi ? '$' + hi.toFixed(2) : '—';
  if (pos !== null && pos !== undefined) {
    document.getElementById('week52Fill') .style.width = pos + '%';
    document.getElementById('week52Thumb').style.left  = pos + '%';
  }
}

// ── Merge all markers onto the price series ───────────────────────
function flushMarkers() {
  if (!candleSeries) return;
  const all = [..._newsMarkers, ..._insiderMarkers, ..._autoTAMarkers]
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  candleSeries.setMarkers(all);
}

// ── Auto TA ───────────────────────────────────────────────────────
function toggleAutoTA(btn) {
  autoTAOn = !autoTAOn;
  btn.classList.toggle('active', autoTAOn);
  if (autoTAOn) applyAutoTA();
  else          clearAutoTA();
}

function clearAutoTA() {
  // Remove auto-TA drawings
  for (let i = drawings.length - 1; i >= 0; i--) {
    if (drawings[i]._autoTA) drawings.splice(i, 1);
  }
  _autoTAMarkers = [];
  flushMarkers();
  markRender();
}

function applyAutoTA() {
  if (!chartData?.ohlcv?.length) return;
  clearAutoTA();

  // 1. Force-enable BB + SMA20 + SMA50
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

  // 2. Trend line — find 2 recent rising pivot lows (uptrend) or falling pivot highs (downtrend)
  const ohlcv = chartData.ohlcv;
  const W = 3;
  const recent = ohlcv.slice(-Math.min(80, ohlcv.length));
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

  let trendDrawn = false;
  // Try uptrend: two consecutive rising lows
  for (let i = lows.length - 1; i >= 1 && !trendDrawn; i--) {
    if (lows[i].price > lows[i-1].price) {
      drawings.push({ type: 'trendline', points: [lows[i-1], lows[i]], color: '#00e676', _autoTA: true });
      trendDrawn = true;
    }
  }
  // Fallback: downtrend — two consecutive falling highs
  if (!trendDrawn) {
    for (let i = highs.length - 1; i >= 1; i--) {
      if (highs[i].price < highs[i-1].price) {
        drawings.push({ type: 'trendline', points: [highs[i-1], highs[i]], color: '#ff4f4f', _autoTA: true });
        break;
      }
    }
  }

  // 3. MACD crossover buy/sell signals only
  const t = chartData.technicals;
  const dates = ohlcv.map(x => x.date);
  if (t.macd && t.macd_signal) {
    for (let i = 1; i < t.macd.length; i++) {
      const m0 = t.macd[i-1], s0 = t.macd_signal[i-1];
      const m1 = t.macd[i],   s1 = t.macd_signal[i];
      if (m0 == null || s0 == null || m1 == null || s1 == null) continue;
      if (m0 < s0 && m1 >= s1)
        _autoTAMarkers.push({ time: dates[i], position: 'belowBar', color: '#00e676', shape: 'arrowUp',   text: 'Buy',  size: 1 });
      else if (m0 > s0 && m1 <= s1)
        _autoTAMarkers.push({ time: dates[i], position: 'aboveBar', color: '#ff4f4f', shape: 'arrowDown', text: 'Sell', size: 1 });
    }
  }

  flushMarkers();
  markRender();
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
      if (counts.buy)  _insiderMarkers.push({ time: date, position: 'belowBar', color: '#00e676', shape: 'arrowUp',   text: counts.buy  > 1 ? `B×${counts.buy}`  : 'B', size: 1 });
      if (counts.sell) _insiderMarkers.push({ time: date, position: 'aboveBar', color: '#ff4f4f', shape: 'arrowDown', text: counts.sell > 1 ? `S×${counts.sell}` : 'S', size: 1 });
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
  if (v >= 1e12) return '$'+(v/1e12).toFixed(2)+'T';
  if (v >= 1e9)  return '$'+(v/1e9) .toFixed(1)+'B';
  if (v >= 1e6)  return '$'+(v/1e6) .toFixed(1)+'M';
  return '$'+v;
}
