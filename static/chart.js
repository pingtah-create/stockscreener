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
    if (e.key === 'Escape') setDrawTool('none');
  });

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

  // Sync time-scale scroll/zoom across all three charts
  priceChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (_syncingRange || !range) return;
    _syncingRange = true;
    volChart.timeScale().setVisibleLogicalRange(range);
    oscChart.timeScale().setVisibleLogicalRange(range);
    _syncingRange = false;
    markRender();
  });

  // Crosshair sync: overlay lines on vol + osc panels
  const volLine = createSyncLine(volPanel);
  const oscLine = createSyncLine(oscPanel);
  const priLine = createSyncLine(pricePanel);

  priceChart.subscribeCrosshairMove(p => {
    updateOHLCV(p);
    syncLine(volChart,  volLine,  p.time);
    syncLine(oscChart,  oscLine,  p.time);
    markRender();
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
async function loadData(period) {
  const res  = await fetch(`/api/chart/${TICKER}?period=${period}`);
  chartData  = await res.json();
  applyAllData();
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
  priceChart.timeScale().fitContent();
  markRender();
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

// ── OHLCV tooltip ──────────────────────────────────────────────────
function updateOHLCV(param) {
  if (!param?.time || !chartData) { return; }
  const bar = chartData.ohlcv.find(x => x.date === String(param.time));
  if (!bar) return;

  document.getElementById('ohlcvDate').textContent = bar.date;
  document.getElementById('ohlcvO').textContent    = bar.open.toFixed(2);
  document.getElementById('ohlcvH').textContent    = bar.high.toFixed(2);
  document.getElementById('ohlcvL').textContent    = bar.low.toFixed(2);
  const c = document.getElementById('ohlcvC');
  c.textContent  = bar.close.toFixed(2);
  c.style.color  = bar.up ? 'var(--green)' : 'var(--red)';
  document.getElementById('ohlcvV').textContent = fmtVol(bar.volume);
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
    if (needRender) { renderDrawings(); needRender = false; }
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
