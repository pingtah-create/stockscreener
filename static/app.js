/* =====================================================
   US Stock Screener — Enhanced Frontend
   ===================================================== */

let currentPage = 1;
let totalResults = 0;
let sortDir = "desc";
let activePreset = null;
let allResults = [];
let presets = {};
let watchlist = JSON.parse(localStorage.getItem("wl") || "[]");
let compareSet = new Set();
let activeChartPeriod = "6mo";
let activeChartInstance = null;

// ── TA Chart State ────────────────────────────────────
let taCharts = {};            // { price, volume, osc }
let taData = null;            // last fetched chart data
let taActiveTicker = null;
let taActiveOsc = "rsi";      // rsi | macd | stoch | cci
let taIndicators = {          // which overlays are on
  sma20: true, sma50: true, sma200: false,
  ema9: false, ema20: false,
  bb: false, vwap: false,
};

const IND_COLORS = {
  price:      "#e2eaf6",
  sma20:      "#00bcd4",
  sma50:      "#ff9800",
  sma200:     "#f44336",
  ema9:       "#4caf50",
  ema20:      "#ce93d8",
  bb_upper:   "#ab47bc",
  bb_mid:     "#7b1fa2",
  bb_lower:   "#ab47bc",
  vwap:       "#ffeb3b",
  vol_up:     "rgba(0,230,118,0.55)",
  vol_dn:     "rgba(255,79,79,0.55)",
  vol_ma:     "rgba(255,235,59,0.7)",
  rsi:        "#ff9800",
  rsi_ob:     "rgba(255,79,79,0.15)",
  rsi_os:     "rgba(0,230,118,0.15)",
  macd:       "#4fc3f7",
  macd_sig:   "#ff4081",
  macd_hist_up:"rgba(0,230,118,0.7)",
  macd_hist_dn:"rgba(255,79,79,0.7)",
  stoch_k:    "#f06292",
  stoch_d:    "#ffab40",
  cci:        "#81d4fa",
};

const PER_PAGE = 50;

const SECTOR_COLORS = {
  "Technology": "#4fc3f7",
  "Healthcare": "#a5d6a7",
  "Financial Services": "#ffcc80",
  "Consumer Cyclical": "#f48fb1",
  "Consumer Defensive": "#c5e1a5",
  "Industrials": "#b0bec5",
  "Energy": "#ffe082",
  "Utilities": "#80deea",
  "Real Estate": "#ce93d8",
  "Materials": "#ef9a9a",
  "Communication Services": "#80cbc4",
};

// ── INIT ──────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  setupSearch();
  setupKeyboardShortcuts();
  await Promise.all([loadPresets(), loadIndices(), checkStatus()]);
  renderWatchlist();
  setInterval(checkStatus, 4000);
  setInterval(loadIndices, 60000);
});

// ── KEYBOARD SHORTCUTS ─────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      document.getElementById("searchInput").focus();
    }
    if (e.key === "Escape") {
      closeModal(); closeThesisModal(); closeCompareModal();
      closeSearch();
    }
  });
}

// ── MARKET INDICES ────────────────────────────────────
async function loadIndices() {
  try {
    const res = await fetch("/api/indices");
    const data = await res.json();
    for (const [name, info] of Object.entries(data)) {
      const idMap = { "S&P 500": "SP500", "NASDAQ": "NASDAQ", "DOW": "DOW",
                      "VIX": "VIX", "Russell": "Russell", "10Y": "10Y" };
      const id = idMap[name];
      if (!id || info.price == null) continue;
      const chg = info.change_pct;
      const cls = name === "VIX" ? (chg > 0 ? "down" : "up") : (chg >= 0 ? "up" : "down");
      const sign = chg >= 0 ? "+" : "";
      const priceStr = info.price >= 1000
        ? info.price.toLocaleString("en-US", { maximumFractionDigits: 2 })
        : info.price.toFixed(2);
      for (const suffix of ["", "b"]) {
        const pe = document.getElementById(`tape-${id}${suffix}`);
        const ce = document.getElementById(`tapechg-${id}${suffix}`);
        if (pe) pe.textContent = priceStr;
        if (ce) { ce.textContent = `${sign}${chg.toFixed(2)}%`; ce.className = `tape-chg ${cls}`; }
      }
    }
  } catch (e) {}
}

// ── SEARCH ────────────────────────────────────────────
function setupSearch() {
  const input = document.getElementById("searchInput");
  const dropdown = document.getElementById("searchDropdown");
  let debounce;

  input.addEventListener("input", () => {
    clearTimeout(debounce);
    const q = input.value.trim().toUpperCase();
    if (q.length < 1) { closeSearch(); return; }
    debounce = setTimeout(() => searchStocks(q), 200);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim()) dropdown.classList.add("open");
  });

  document.addEventListener("click", e => {
    if (!document.getElementById("searchWrap").contains(e.target)) closeSearch();
  });
}

function searchStocks(q) {
  const matches = allResults.filter(s =>
    s.symbol?.toUpperCase().includes(q) ||
    (s.shortName || "").toUpperCase().includes(q)
  ).slice(0, 8);

  // If no loaded results yet, search from what we have cached
  const pool = allResults.length ? allResults : [];
  const found = pool.filter(s =>
    s.symbol?.startsWith(q) || (s.shortName || "").toUpperCase().includes(q)
  ).slice(0, 8);

  const dropdown = document.getElementById("searchDropdown");
  if (!found.length) { dropdown.innerHTML = `<div style="padding:12px 14px;color:var(--text3);font-size:12px">No matches found</div>`; }
  else {
    dropdown.innerHTML = found.map(s => `
      <div class="search-result-item" onclick="showStockDetail('${s.symbol}');closeSearch()">
        <span class="search-ticker">${s.symbol}</span>
        <span class="search-name">${s.shortName || s.longName || "—"}</span>
        <span class="search-sector">${s.sector || ""}</span>
      </div>`).join("");
  }
  dropdown.classList.add("open");
}

function closeSearch() {
  document.getElementById("searchDropdown").classList.remove("open");
}

// ── PRESETS ────────────────────────────────────────────
async function loadPresets() {
  const res = await fetch("/api/presets");
  presets = await res.json();
  const grid = document.getElementById("presetGrid");
  grid.innerHTML = "";
  for (const [key, p] of Object.entries(presets)) {
    const btn = document.createElement("div");
    btn.className = "preset-btn";
    btn.id = `preset-${key}`;
    btn.innerHTML = `
      <div class="preset-icon">${p.icon}</div>
      <div class="preset-info">
        <span class="preset-name">${p.name}</span>
        <span class="preset-desc">${p.description}</span>
      </div>
      <button class="preset-info-btn" onclick="showThesis('${key}',event)" title="Learn more">ℹ</button>`;
    btn.addEventListener("click", e => {
      if (e.target.classList.contains("preset-info-btn")) return;
      applyPreset(key);
    });
    grid.appendChild(btn);
  }
}

function applyPreset(key) {
  clearFilters(false);
  activePreset = key;
  document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`preset-${key}`)?.classList.add("active");
  const badge = document.getElementById("activePresetBadge");
  badge.textContent = `${presets[key].icon} ${presets[key].name}`;
  badge.style.display = "inline-flex";
  runScreen();
}

function clearFilters(resetPreset = true) {
  if (resetPreset) {
    activePreset = null;
    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
    document.getElementById("activePresetBadge").style.display = "none";
  }
  ["filterPEMax","filterPEMin","filterPBMax","filterROEMin","filterRevGrowthMin",
   "filterEPSGrowthMin","filterDivYieldMin","filterDEMax","filterOPMMin","filterPEGMax"]
    .forEach(id => { document.getElementById(id).value = ""; });
  document.getElementById("filterSector").value = "";
  document.getElementById("filterMarketCap").value = "";
  document.getElementById("filterTrend").value = "";
}

// ── STATUS ────────────────────────────────────────────
async function checkStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    document.getElementById("cacheCount").textContent = `${data.cached_stocks} stocks`;
    const dot  = document.getElementById("statusDot");
    const mini = document.getElementById("refreshMini");
    const fill = document.getElementById("refreshMiniFill");
    const btn  = document.getElementById("btnRefresh");
    const prog = data.refresh;
    if (prog.running) {
      dot.className = "status-dot syncing";
      mini.style.display = "block";
      const pct = prog.total > 0 ? prog.done / prog.total * 100 : 0;
      fill.style.width = pct.toFixed(1) + "%";
      document.getElementById("cacheCount").textContent = `Fetching ${prog.done}/${prog.total}`;
      btn.disabled = true;
    } else {
      dot.className = "status-dot";
      mini.style.display = "none";
      btn.disabled = false;
    }
  } catch (e) {}
}

async function startRefresh() {
  document.getElementById("btnRefresh").disabled = true;
  await fetch("/api/refresh", { method: "POST" });
  showToast("Data refresh started — may take a few minutes.", "success");
}

// ── BUILD FILTERS ──────────────────────────────────────
function buildFilters() {
  const filters = {};
  if (activePreset && presets[activePreset]) {
    Object.assign(filters, presets[activePreset].filters);
  }
  const peMax = parseFloat(document.getElementById("filterPEMax").value);
  const peMin = parseFloat(document.getElementById("filterPEMin").value);
  if (!isNaN(peMax) || !isNaN(peMin)) {
    filters.trailingPE = {};
    if (!isNaN(peMax)) filters.trailingPE.max = peMax;
    if (!isNaN(peMin)) filters.trailingPE.min = peMin;
  }
  const pbMax = parseFloat(document.getElementById("filterPBMax").value);
  if (!isNaN(pbMax)) filters.priceToBook = { max: pbMax };
  const roeMin = parseFloat(document.getElementById("filterROEMin").value);
  if (!isNaN(roeMin)) filters.returnOnEquity = { min: roeMin / 100 };
  const rgMin = parseFloat(document.getElementById("filterRevGrowthMin").value);
  if (!isNaN(rgMin)) filters.revenueGrowth = { min: rgMin / 100 };
  const egMin = parseFloat(document.getElementById("filterEPSGrowthMin").value);
  if (!isNaN(egMin)) filters.earningsGrowth = { min: egMin / 100 };
  const dyMin = parseFloat(document.getElementById("filterDivYieldMin").value);
  if (!isNaN(dyMin)) filters.dividendYield = { min: dyMin / 100 };
  const deMax = parseFloat(document.getElementById("filterDEMax").value);
  if (!isNaN(deMax)) filters.debtToEquity = { max: deMax };
  const opmMin = parseFloat(document.getElementById("filterOPMMin").value);
  if (!isNaN(opmMin)) filters.operatingMargins = { min: opmMin / 100 };
  const pegMax = parseFloat(document.getElementById("filterPEGMax").value);
  if (!isNaN(pegMax)) filters.pegRatio = { max: pegMax };
  const trend = document.getElementById("filterTrend").value;
  if (trend === "above50") filters.above50dma = { value: true };
  else if (trend === "above200") filters.above200dma = { value: true };
  else if (trend === "both") { filters.above50dma = { value: true }; filters.above200dma = { value: true }; }
  return filters;
}

// ── SCREEN ────────────────────────────────────────────
async function runScreen(resetPage = true) {
  if (resetPage) currentPage = 1;
  const filters = buildFilters();
  const sortBy = document.getElementById("sortBy").value;

  document.getElementById("emptyState").style.display = "none";
  const table = document.getElementById("resultsTable");
  table.style.display = "table";
  document.getElementById("tableBody").innerHTML =
    `<tr class="loading-row"><td colspan="16"><span class="spinner"></span>Screening ${totalResults || "all"} stocks…</td></tr>`;

  try {
    const res = await fetch("/api/screen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters, sort_by: sortBy, sort_dir: sortDir, page: currentPage, per_page: PER_PAGE }),
    });
    const data = await res.json();
    totalResults = data.total;
    allResults = data.results;

    // Client-side sector + market cap filters
    const mcFilter = document.getElementById("filterMarketCap").value;
    const sectorFilter = document.getElementById("filterSector").value;
    let filtered = allResults.filter(s => {
      if (sectorFilter && s.sector !== sectorFilter) return false;
      if (mcFilter) {
        const mc = s.marketCap || 0;
        if (mcFilter === "mega"  && mc < 200e9) return false;
        if (mcFilter === "large" && (mc < 10e9  || mc >= 200e9)) return false;
        if (mcFilter === "mid"   && (mc < 2e9   || mc >= 10e9))  return false;
        if (mcFilter === "small" && mc >= 2e9) return false;
      }
      return true;
    });

    renderTable(filtered);
    renderPagination(totalResults);
    document.getElementById("resultCount").textContent =
      `${filtered.length} stock${filtered.length !== 1 ? "s" : ""} found`;
  } catch (e) {
    document.getElementById("tableBody").innerHTML =
      `<tr class="loading-row"><td colspan="16" style="color:var(--red)">Error — is the server running?</td></tr>`;
  }
}

// ── TABLE ──────────────────────────────────────────────
function renderTable(stocks) {
  const tbody = document.getElementById("tableBody");
  const table = document.getElementById("resultsTable");

  if (!stocks.length) {
    table.style.display = "none";
    document.getElementById("emptyState").style.display = "flex";
    document.getElementById("emptyState").innerHTML = `
      <div class="empty-icon">🔎</div>
      <h3>No stocks matched</h3>
      <p>Try relaxing the filters or switching to a different preset.</p>
      <button class="btn btn-ghost" onclick="clearFilters()">✕ Clear Filters</button>`;
    return;
  }

  table.style.display = "table";
  document.getElementById("emptyState").style.display = "none";

  tbody.innerHTML = stocks.map(s => {
    const score = activePreset && s.scores ? s.scores[activePreset] : null;
    const avgScore = s.scores
      ? Math.round(Object.values(s.scores).reduce((a,b)=>a+b,0) / Object.values(s.scores).length)
      : null;
    const displayScore = score ?? avgScore;
    const starred = watchlist.includes(s.symbol);
    const inCompare = compareSet.has(s.symbol);
    const sectorColor = SECTOR_COLORS[s.sector] || "var(--text3)";
    const price = s.currentPrice || s.previousClose;

    return `<tr data-ticker="${s.symbol}">
      <td onclick="event.stopPropagation()">
        <button class="btn-star ${starred ? "starred" : ""}" onclick="toggleWatchlist('${s.symbol}',event)" title="${starred ? "Remove from watchlist" : "Add to watchlist"}">
          ${starred ? "★" : "☆"}
        </button>
      </td>
      <td onclick="event.stopPropagation()">
        <input type="checkbox" class="compare-check" ${inCompare ? "checked" : ""}
          onchange="toggleCompare('${s.symbol}',this)" title="Compare" />
      </td>
      <td class="td-ticker" onclick="showStockDetail('${s.symbol}')">${s.symbol}</td>
      <td class="td-name" onclick="showStockDetail('${s.symbol}')" title="${s.shortName||""}">${s.shortName || s.longName || "—"}</td>
      <td class="td-sector" onclick="showStockDetail('${s.symbol}')">
        <span class="sector-dot" style="background:${sectorColor}"></span>
        ${s.sector || "—"}
      </td>
      <td onclick="showStockDetail('${s.symbol}')">${fmtPrice(price)}</td>
      <td class="${peClass(s.trailingPE)}" onclick="showStockDetail('${s.symbol}')">${fmtNum(s.trailingPE,1)}</td>
      <td class="${pbClass(s.priceToBook)}" onclick="showStockDetail('${s.symbol}')">${fmtNum(s.priceToBook,2)}</td>
      <td class="${pctClass(s.returnOnEquity)}" onclick="showStockDetail('${s.symbol}')">${fmtPct(s.returnOnEquity)}</td>
      <td class="${pctClass(s.revenueGrowth)}" onclick="showStockDetail('${s.symbol}')">${fmtPct(s.revenueGrowth)}</td>
      <td class="${pctClass(s.operatingMargins)}" onclick="showStockDetail('${s.symbol}')">${fmtPct(s.operatingMargins)}</td>
      <td class="${s.dividendYield ? 'val-good' : 'val-na'}" onclick="showStockDetail('${s.symbol}')">${fmtPct(s.dividendYield)}</td>
      <td class="${chgClass(s.regularMarketChangePercent)}" onclick="showStockDetail('${s.symbol}')">${fmtChg(s.regularMarketChangePercent)}</td>
      <td class="td-sparkline" id="spark-${s.symbol}" onclick="showStockDetail('${s.symbol}')">
        <svg class="sparkline-svg" width="80" height="28"><text x="4" y="18" font-size="9" fill="var(--text3)">…</text></svg>
      </td>
      <td class="val-neutral" onclick="showStockDetail('${s.symbol}')">${fmtMCap(s.marketCap)}</td>
      <td onclick="showStockDetail('${s.symbol}')">${displayScore !== null ? scorePill(displayScore) : '<span class="val-na">—</span>'}</td>
    </tr>`;
  }).join("");

  // Lazy load sparklines
  requestAnimationFrame(() => loadVisibleSparklines(stocks));
}

// ── SPARKLINES ─────────────────────────────────────────
const _sparkCache = {};

async function loadVisibleSparklines(stocks) {
  for (const s of stocks) {
    const cell = document.getElementById(`spark-${s.symbol}`);
    if (!cell) continue;
    fetchAndDrawSparkline(s.symbol, cell);
  }
}

async function fetchAndDrawSparkline(ticker, cell) {
  if (_sparkCache[ticker]) { drawSparkline(cell, _sparkCache[ticker], ticker); return; }
  try {
    const res = await fetch(`/api/sparkline/${ticker}`);
    const data = await res.json();
    if (data.prices?.length > 4) {
      _sparkCache[ticker] = data.prices;
      drawSparkline(cell, data.prices, ticker);
    }
  } catch (e) {}
}

function drawSparkline(cell, prices, ticker) {
  const W = 80, H = 28, PAD = 2;
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? "#00e676" : "#ff4f4f";
  const glowColor = isUp ? "rgba(0,230,118,0.3)" : "rgba(255,79,79,0.3)";

  const xs = prices.map((_, i) => PAD + (i / (prices.length - 1)) * (W - PAD * 2));
  const ys = prices.map(p => H - PAD - ((p - min) / range) * (H - PAD * 2));

  const pathD = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const areaD = pathD + ` L${xs[xs.length-1].toFixed(1)},${H} L${PAD},${H} Z`;

  const gradId = `gr-${ticker}`;
  cell.innerHTML = `
    <svg class="sparkline-svg" width="${W}" height="${H}" style="overflow:visible">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
        <filter id="glow-${ticker}">
          <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
          <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <path d="${areaD}" fill="url(#${gradId})" stroke="none"/>
      <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.5"
            filter="url(#glow-${ticker})" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${xs[xs.length-1].toFixed(1)}" cy="${ys[ys.length-1].toFixed(1)}"
              r="2.5" fill="${color}" filter="url(#glow-${ticker})"/>
    </svg>`;
}

// ── FORMATTING ─────────────────────────────────────────
const fmt = new Intl.NumberFormat("en-US");
function fmtPrice(v) { return v == null ? '<span class="val-na">—</span>' : `$${v.toFixed(2)}`; }
function fmtNum(v, dec = 1) { return (v == null || isNaN(v)) ? '<span class="val-na">—</span>' : v.toFixed(dec); }
function fmtPct(v) { return (v == null || isNaN(v)) ? "—" : (v * 100).toFixed(1) + "%"; }
function fmtChg(v) { return v == null ? '<span class="val-na">—</span>' : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`; }
function fmtMCap(v) {
  if (v == null) return '<span class="val-na">—</span>';
  if (v >= 1e12) return `$${(v/1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v/1e9).toFixed(1)}B`;
  return `$${(v/1e6).toFixed(0)}M`;
}
function peClass(v)  { if (!v) return "val-na"; return v < 15 ? "val-good" : v < 28 ? "val-neutral" : "val-bad"; }
function pbClass(v)  { if (!v) return "val-na"; return v < 2 ? "val-good" : v < 5 ? "val-neutral" : "val-bad"; }
function pctClass(v) { if (v == null) return "val-na"; return v >= 0 ? "val-good" : "val-bad"; }
function chgClass(v) { if (v == null) return "val-na"; return v >= 0 ? "val-good" : "val-bad"; }
function scorePill(s) {
  const cls = s >= 70 ? "score-high" : s >= 40 ? "score-mid" : "score-low";
  return `<span class="score-pill ${cls}">${s}</span>`;
}

// ── WATCHLIST ─────────────────────────────────────────
function toggleWatchlist(ticker, event) {
  event.stopPropagation();
  const idx = watchlist.indexOf(ticker);
  if (idx === -1) watchlist.push(ticker);
  else watchlist.splice(idx, 1);
  localStorage.setItem("wl", JSON.stringify(watchlist));
  // Update star in table
  const row = document.querySelector(`tr[data-ticker="${ticker}"]`);
  if (row) {
    const btn = row.querySelector(".btn-star");
    if (btn) { btn.textContent = watchlist.includes(ticker) ? "★" : "☆"; btn.classList.toggle("starred", watchlist.includes(ticker)); }
  }
  renderWatchlist();
  showToast(watchlist.includes(ticker) ? `${ticker} added to watchlist` : `${ticker} removed`, "");
}

function renderWatchlist() {
  const list = document.getElementById("wlList");
  const countEl = document.getElementById("wlCount");
  countEl.textContent = watchlist.length;
  if (!watchlist.length) {
    list.innerHTML = `<div class="wl-empty">Star ☆ any stock to add it here</div>`;
    return;
  }
  list.innerHTML = watchlist.map(ticker => {
    const s = allResults.find(r => r.symbol === ticker);
    const price = s?.currentPrice || s?.previousClose;
    const chg = s?.regularMarketChangePercent;
    return `<div class="wl-item" onclick="showStockDetail('${ticker}')">
      <div>
        <div class="wl-ticker">${ticker}</div>
        <div class="wl-name">${s?.shortName || ""}</div>
      </div>
      <div class="wl-price">
        <div style="color:var(--text)">${price ? "$" + price.toFixed(2) : "—"}</div>
        <div class="${chgClass(chg)}" style="font-size:10px">${chg != null ? fmtChg(chg) : ""}</div>
      </div>
      <button class="wl-remove" onclick="toggleWatchlist('${ticker}',event)">✕</button>
    </div>`;
  }).join("");
}

function clearWatchlist() {
  watchlist = [];
  localStorage.setItem("wl", "[]");
  renderWatchlist();
  document.querySelectorAll(".btn-star.starred").forEach(b => {
    b.textContent = "☆"; b.classList.remove("starred");
  });
}

// ── COMPARE ───────────────────────────────────────────
function toggleCompare(ticker, checkbox) {
  if (checkbox.checked) {
    if (compareSet.size >= 4) {
      checkbox.checked = false;
      showToast("Max 4 stocks to compare.", "error");
      return;
    }
    compareSet.add(ticker);
  } else {
    compareSet.delete(ticker);
  }
  updateCompareBar();
}

function updateCompareBar() {
  const bar = document.getElementById("compareBar");
  const chips = document.getElementById("compareChips");
  const btn = document.getElementById("btnCompare");
  if (compareSet.size === 0) {
    bar.style.display = "none";
    btn.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  btn.style.display = "inline-flex";
  chips.innerHTML = [...compareSet].map(t => `
    <div class="compare-chip">${t}
      <button onclick="removeCompare('${t}')">✕</button>
    </div>`).join("");
}

function removeCompare(ticker) {
  compareSet.delete(ticker);
  const row = document.querySelector(`tr[data-ticker="${ticker}"]`);
  if (row) { const cb = row.querySelector(".compare-check"); if (cb) cb.checked = false; }
  updateCompareBar();
}

function clearCompare() {
  compareSet.forEach(t => {
    const row = document.querySelector(`tr[data-ticker="${t}"]`);
    if (row) { const cb = row.querySelector(".compare-check"); if (cb) cb.checked = false; }
  });
  compareSet.clear();
  updateCompareBar();
}

async function openCompare() {
  if (compareSet.size < 2) { showToast("Select at least 2 stocks to compare.", "error"); return; }
  const modal = document.getElementById("compareModal");
  const content = document.getElementById("compareContent");
  modal.classList.add("open");
  content.innerHTML = `<div style="padding:32px;text-align:center"><span class="spinner"></span>Loading comparison…</div>`;

  const tickers = [...compareSet];
  const data = await Promise.all(tickers.map(t => fetch(`/api/stock/${t}`).then(r => r.json())));

  const rows = [
    { label: "Price", key: s => s.currentPrice || s.previousClose, fmt: v => v ? `$${v.toFixed(2)}` : "—", good: "high" },
    { label: "Market Cap", key: s => s.marketCap, fmt: fmtMCapRaw, good: "high" },
    { label: "P/E Ratio", key: s => s.trailingPE, fmt: v => v ? v.toFixed(1) : "—", good: "low" },
    { label: "Fwd P/E", key: s => s.forwardPE, fmt: v => v ? v.toFixed(1) : "—", good: "low" },
    { label: "P/B Ratio", key: s => s.priceToBook, fmt: v => v ? v.toFixed(2) : "—", good: "low" },
    { label: "PEG Ratio", key: s => s.pegRatio, fmt: v => v ? v.toFixed(2) : "—", good: "low" },
    { label: "ROE", key: s => s.returnOnEquity, fmt: v => v ? (v*100).toFixed(1)+"%" : "—", good: "high" },
    { label: "Rev Growth", key: s => s.revenueGrowth, fmt: v => v ? (v*100).toFixed(1)+"%" : "—", good: "high" },
    { label: "EPS Growth", key: s => s.earningsGrowth, fmt: v => v ? (v*100).toFixed(1)+"%" : "—", good: "high" },
    { label: "Op Margin", key: s => s.operatingMargins, fmt: v => v ? (v*100).toFixed(1)+"%" : "—", good: "high" },
    { label: "Net Margin", key: s => s.profitMargins, fmt: v => v ? (v*100).toFixed(1)+"%" : "—", good: "high" },
    { label: "Debt/Equity", key: s => s.debtToEquity, fmt: v => v != null ? v.toFixed(2) : "—", good: "low" },
    { label: "Div Yield", key: s => s.dividendYield, fmt: v => v ? (v*100).toFixed(2)+"%" : "—", good: "high" },
    { label: "Beta", key: s => s.beta, fmt: v => v ? v.toFixed(2) : "—", good: null },
    { label: "52W Position", key: s => s.fiftyTwoWeekPosition, fmt: v => v != null ? v.toFixed(0)+"%" : "—", good: "high" },
  ];

  const headerCols = data.map(s => `
    <th class="compare-col-header">
      <span class="compare-col-ticker">${s.symbol}</span>
      <span class="compare-col-name">${(s.shortName||"").slice(0,20)}</span>
    </th>`).join("");

  const bodyRows = rows.map(row => {
    const vals = data.map(s => row.key(s));
    const nums = vals.map(v => typeof v === "number" ? v : null);
    const validNums = nums.filter(v => v !== null);
    const bestVal = validNums.length ? (row.good === "high" ? Math.max(...validNums) : Math.min(...validNums)) : null;

    const cells = vals.map((v, i) => {
      const num = nums[i];
      const isBest = bestVal !== null && num === bestVal && row.good !== null;
      return `<td class="${isBest ? "best" : ""}">${row.fmt(v)}</td>`;
    }).join("");
    return `<tr><td class="compare-row-label">${row.label}</td>${cells}</tr>`;
  }).join("");

  content.innerHTML = `
    <div class="compare-header"><h2>⚖ Side-by-Side Comparison</h2></div>
    <div class="compare-table-wrap">
      <table class="compare-table">
        <thead><tr><th>Metric</th>${headerCols}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <p style="font-size:11px;color:var(--text3);margin-top:12px">🟢 Green = best value for that metric</p>
    </div>`;
}

function fmtMCapRaw(v) {
  if (!v) return "—";
  if (v >= 1e12) return `$${(v/1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v/1e9).toFixed(1)}B`;
  return `$${(v/1e6).toFixed(0)}M`;
}

function closeCompareModal() { document.getElementById("compareModal").classList.remove("open"); }

// ── STOCK DETAIL MODAL ─────────────────────────────────
async function showStockDetail(ticker) {
  window.location.href = `/stock/${ticker}`;
  return;
  const overlay = document.getElementById("modalOverlay");
  const content = document.getElementById("modalContent");
  overlay.classList.add("open");
  content.innerHTML = `<div style="padding:40px;text-align:center"><span class="spinner"></span></div>`;

  try {
    const res = await fetch(`/api/stock/${ticker}`);
    const s = await res.json();
    const price = s.currentPrice || s.previousClose;
    const chg = s.regularMarketChangePercent || 0;
    const chgColor = chg >= 0 ? "var(--green)" : "var(--red)";
    const pos = s.fiftyTwoWeekPosition;
    const starred = watchlist.includes(ticker);

    content.innerHTML = `
      <div class="modal-header">
        <div class="modal-header-top">
          <div>
            <div class="modal-ticker">${s.symbol}</div>
            <div class="modal-name">${s.shortName || s.longName || "—"}</div>
            <div class="modal-meta">
              ${s.sector ? `<span class="sector-dot" style="background:${SECTOR_COLORS[s.sector]||"var(--text3)"}"></span>${s.sector}` : ""}
              ${s.industry ? ` · ${s.industry}` : ""}
              ${s.marketCap ? ` · ${fmtMCapRaw(s.marketCap)}` : ""}
              ${s.recommendationKey ? ` · <strong style="color:var(--blue)">${s.recommendationKey.toUpperCase()}</strong>` : ""}
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn btn-ghost sm ${starred?"btn-danger":""}"
              onclick="toggleWatchlist('${ticker}',event);this.textContent='${starred?"☆ Watch":"★ Watching"}'">
              ${starred ? "★ Watching" : "☆ Watch"}
            </button>
          </div>
        </div>
      </div>

      <div class="modal-body">
        <div class="price-section">
          <span class="price-big" style="color:var(--text)">${price ? "$"+price.toFixed(2) : "—"}</span>
          <span class="price-chg" style="color:${chgColor}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span>
          ${s.analystUpside != null ? `<span class="analyst-target">Target: <strong style="color:${s.analystUpside>0?"var(--green)":"var(--red)"}">${s.analystUpside>0?"+":""}${s.analystUpside.toFixed(1)}% upside</strong></span>` : ""}
        </div>

        ${pos != null ? `
        <div class="range-bar-wrap">
          <div class="range-bar-labels">
            <span>52W Low $${(s.fiftyTwoWeekLow||0).toFixed(2)}</span>
            <span>52W High $${(s.fiftyTwoWeekHigh||0).toFixed(2)}</span>
          </div>
          <div class="range-bar-track">
            <div class="range-bar-fill" style="width:${pos}%"></div>
            <div class="range-bar-dot" style="left:${pos}%"></div>
          </div>
          <div class="range-pos-label">${pos.toFixed(0)}% of 52-week range · ${s.above200dma?"✓ Above 200D MA":"✗ Below 200D MA"}</div>
        </div>` : ""}

        ${buildChartSection(ticker, activeChartPeriod)}

        <div class="metrics-grid">
          ${mc("P/E",    fmtNum(s.trailingPE,1),   peClass(s.trailingPE))}
          ${mc("Fwd P/E",fmtNum(s.forwardPE,1),   peClass(s.forwardPE))}
          ${mc("P/B",    fmtNum(s.priceToBook,2),  pbClass(s.priceToBook))}
          ${mc("PEG",    fmtNum(s.pegRatio,2),     s.pegRatio?(s.pegRatio<2?"val-good":"val-bad"):"val-na")}
          ${mc("EV/EBITDA",fmtNum(s.enterpriseToEbitda,1))}
          ${mc("Beta",   fmtNum(s.beta,2))}
          ${mc("ROE",    fmtPct(s.returnOnEquity), pctClass(s.returnOnEquity))}
          ${mc("ROA",    fmtPct(s.returnOnAssets), pctClass(s.returnOnAssets))}
          ${mc("D/E",    fmtNum(s.debtToEquity,2), s.debtToEquity!=null?(s.debtToEquity<1?"val-good":s.debtToEquity<2?"val-neutral":"val-bad"):"val-na")}
          ${mc("Rev Gr", fmtPct(s.revenueGrowth),  pctClass(s.revenueGrowth))}
          ${mc("EPS Gr", fmtPct(s.earningsGrowth), pctClass(s.earningsGrowth))}
          ${mc("Op Mgn", fmtPct(s.operatingMargins),pctClass(s.operatingMargins))}
          ${mc("Gross Mgn",fmtPct(s.grossMargins), pctClass(s.grossMargins))}
          ${mc("Net Mgn",fmtPct(s.profitMargins),  pctClass(s.profitMargins))}
          ${mc("Div Yield",fmtPct(s.dividendYield),s.dividendYield?"val-good":"val-na")}
          ${mc("Current Ratio",fmtNum(s.currentRatio,2),s.currentRatio?(s.currentRatio>=1.5?"val-good":s.currentRatio>=1?"val-neutral":"val-bad"):"val-na")}
          ${mc("50D MA", s.above50dma?"✓ Above":"✗ Below", s.above50dma?"val-good":"val-bad")}
          ${mc("200D MA",s.above200dma?"✓ Above":"✗ Below",s.above200dma?"val-good":"val-bad")}
        </div>

        ${s.scores ? `
        <div class="scores-section">
          <div class="scores-title">Strategy Fit Scores</div>
          <div class="score-bars">
            ${Object.entries(s.scores).map(([k,v]) => `
              <div class="score-bar-row">
                <span class="score-bar-name">${presets[k]?presets[k].icon+" "+presets[k].name:k}</span>
                <div class="score-bar-track">
                  <div class="score-bar-fill" style="width:${v}%;background:${v>=70?"var(--green)":v>=40?"var(--yellow)":"var(--red)"}"></div>
                </div>
                <span class="score-bar-num" style="color:${v>=70?"var(--green)":v>=40?"var(--yellow)":"var(--red)"}">${v}</span>
              </div>`).join("")}
          </div>
        </div>` : ""}
      </div>`;

    loadChart(ticker, activeChartPeriod);
  } catch (e) {
    content.innerHTML = `<div style="padding:32px;text-align:center;color:var(--red)">Failed to load data for ${ticker}.</div>`;
  }
}

function mc(label, value, colorClass = "") {
  return `<div class="metric-card">
    <div class="metric-label">${label}</div>
    <div class="metric-value ${colorClass}">${value}</div>
  </div>`;
}

// ══════════════════════════════════════════════════════
//  FULL TECHNICAL ANALYSIS CHART ENGINE
// ══════════════════════════════════════════════════════

function buildChartSection(ticker, period) {
  return `
  <div class="ta-chart-section" id="taSection">
    <!-- Controls -->
    <div class="ta-controls">
      <div class="ta-period-group">
        ${["1mo","3mo","6mo","1y","2y"].map(p =>
          `<button class="chart-tab${p===period?" active":""}" onclick="loadChart('${ticker}','${p}')">${p}</button>`
        ).join("")}
      </div>
      <div class="ta-divider"></div>
      <div class="ta-overlay-group">
        <button class="ta-btn${taIndicators.sma20?" on":""}"  data-ind="sma20"  onclick="toggleInd('sma20',  this)">SMA 20</button>
        <button class="ta-btn${taIndicators.sma50?" on":""}"  data-ind="sma50"  onclick="toggleInd('sma50',  this)">SMA 50</button>
        <button class="ta-btn${taIndicators.sma200?" on":""}" data-ind="sma200" onclick="toggleInd('sma200', this)">SMA 200</button>
        <button class="ta-btn${taIndicators.ema9?" on":""}"   data-ind="ema9"   onclick="toggleInd('ema9',   this)">EMA 9</button>
        <button class="ta-btn${taIndicators.ema20?" on":""}"  data-ind="ema20"  onclick="toggleInd('ema20',  this)">EMA 20</button>
        <button class="ta-btn${taIndicators.bb?" on":""}"     data-ind="bb"     onclick="toggleInd('bb',     this)">BB</button>
        <button class="ta-btn${taIndicators.vwap?" on":""}"   data-ind="vwap"   onclick="toggleInd('vwap',   this)">VWAP</button>
      </div>
      <div class="ta-divider"></div>
      <div class="ta-osc-group">
        <button class="ta-btn${taActiveOsc==="rsi"?" on":""}"   data-osc="rsi"   onclick="setOsc('rsi',  this)">RSI</button>
        <button class="ta-btn${taActiveOsc==="macd"?" on":""}"  data-osc="macd"  onclick="setOsc('macd', this)">MACD</button>
        <button class="ta-btn${taActiveOsc==="stoch"?" on":""}" data-osc="stoch" onclick="setOsc('stoch',this)">Stoch</button>
        <button class="ta-btn${taActiveOsc==="cci"?" on":""}"   data-osc="cci"   onclick="setOsc('cci',  this)">CCI</button>
      </div>
    </div>

    <!-- Crosshair tooltip -->
    <div class="ta-crosshair-tooltip" id="taCrosshairTip"></div>

    <!-- Panel 1: Price + Overlays -->
    <div class="ta-panel" id="taPanelPrice" style="height:220px">
      <div class="ta-panel-label">PRICE</div>
      <div class="ta-ohlc-display" id="taOhlcDisplay"></div>
      <canvas id="taChartPrice" height="220"></canvas>
    </div>

    <!-- Panel 2: Volume -->
    <div class="ta-panel" id="taPanelVol" style="height:70px">
      <div class="ta-panel-label">VOL</div>
      <canvas id="taChartVol" height="70"></canvas>
    </div>

    <!-- Panel 3: Oscillator -->
    <div class="ta-panel" id="taPanelOsc" style="height:90px">
      <div class="ta-panel-label" id="taOscLabel">RSI (14)</div>
      <canvas id="taChartOsc" height="90"></canvas>
    </div>

    <!-- Legend -->
    <div class="ta-legend" id="taLegend"></div>
  </div>`;
}

function toggleInd(key, btn) {
  taIndicators[key] = !taIndicators[key];
  btn.classList.toggle("on", taIndicators[key]);
  if (taData) redrawPriceChart(taData);
}

function setOsc(key, btn) {
  taActiveOsc = key;
  document.querySelectorAll(".ta-btn[data-osc]").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
  document.getElementById("taOscLabel").textContent =
    key === "rsi" ? "RSI (14)" : key === "macd" ? "MACD (12,26,9)" :
    key === "stoch" ? "Stochastic (14,3)" : "CCI (20)";
  if (taData) redrawOscChart(taData);
}

async function loadChart(ticker, period) {
  activeChartPeriod = period;
  taActiveTicker = ticker;

  // Update period button states
  document.querySelectorAll(".chart-tab").forEach(t =>
    t.classList.toggle("active", t.textContent === period));

  // Destroy old instances
  Object.values(taCharts).forEach(c => c?.destroy());
  taCharts = {};

  const priceCanvas = document.getElementById("taChartPrice");
  const volCanvas   = document.getElementById("taChartVol");
  const oscCanvas   = document.getElementById("taChartOsc");
  if (!priceCanvas) return;

  // Loading state
  const section = document.getElementById("taSection");
  if (section) section.style.opacity = "0.5";

  try {
    const res = await fetch(`/api/chart/${ticker}?period=${period}`);
    const data = await res.json();
    taData = data;
    if (!data.ohlcv?.length) return;

    if (section) section.style.opacity = "1";
    redrawPriceChart(data);
    redrawVolChart(data);
    redrawOscChart(data);
    buildLegend(data);
    setupCrosshairSync(data);
  } catch (e) {
    if (section) section.style.opacity = "1";
  }
}

// ── Chart options factory ──────────────────────────────
function baseChartOptions(showXAxis = false) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false },  // we use custom crosshair tooltip
    },
    scales: {
      x: {
        display: showXAxis,
        ticks: { color: "#3d5070", maxTicksLimit: 7, font: { size: 9 }, maxRotation: 0 },
        grid:  { color: "rgba(30,45,74,0.4)" },
        border: { color: "rgba(30,45,74,0.8)" },
      },
      y: {
        position: "right",
        ticks: { color: "#3d5070", font: { size: 9 }, maxTicksLimit: 5 },
        grid:  { color: "rgba(30,45,74,0.4)" },
        border: { color: "rgba(30,45,74,0.8)" },
      }
    }
  };
}

// ── Price + Overlays ───────────────────────────────────
function redrawPriceChart(data) {
  taCharts.price?.destroy();
  const canvas = document.getElementById("taChartPrice");
  if (!canvas) return;

  const ohlcv = data.ohlcv;
  const ta    = data.technicals || {};
  const labels = ohlcv.map(d => d.date);
  const closes = ohlcv.map(d => d.close);
  const isUp   = closes[closes.length - 1] >= closes[0];

  const datasets = [];

  // Bollinger Bands (fill between upper/lower)
  if (taIndicators.bb && ta.bb_upper) {
    datasets.push({
      label: "BB Upper", data: ta.bb_upper,
      borderColor: IND_COLORS.bb_upper, borderWidth: 1,
      borderDash: [3, 3], pointRadius: 0, fill: false, tension: 0.2,
    });
    datasets.push({
      label: "BB Mid", data: ta.bb_mid,
      borderColor: IND_COLORS.bb_mid, borderWidth: 1,
      borderDash: [6, 3], pointRadius: 0, fill: false, tension: 0.2,
    });
    datasets.push({
      label: "BB Lower", data: ta.bb_lower,
      borderColor: IND_COLORS.bb_lower, borderWidth: 1,
      borderDash: [3, 3], pointRadius: 0,
      fill: "-2",  // fill between this and BB Upper
      backgroundColor: "rgba(171,71,188,0.06)",
      tension: 0.2,
    });
  }

  // VWAP
  if (taIndicators.vwap && ta.vwap) {
    datasets.push({
      label: "VWAP", data: ta.vwap,
      borderColor: IND_COLORS.vwap, borderWidth: 1.5,
      borderDash: [5, 3], pointRadius: 0, fill: false, tension: 0.2,
    });
  }

  // MAs (behind price)
  const maConf = [
    { key: "sma20",  color: IND_COLORS.sma20,  label: "SMA 20",  width: 1.5 },
    { key: "sma50",  color: IND_COLORS.sma50,  label: "SMA 50",  width: 1.5 },
    { key: "sma200", color: IND_COLORS.sma200, label: "SMA 200", width: 2 },
    { key: "ema9",   color: IND_COLORS.ema9,   label: "EMA 9",   width: 1.5 },
    { key: "ema20",  color: IND_COLORS.ema20,  label: "EMA 20",  width: 1.5 },
  ];
  maConf.forEach(m => {
    if (taIndicators[m.key] && ta[m.key]) {
      datasets.push({
        label: m.label, data: ta[m.key],
        borderColor: m.color, borderWidth: m.width,
        pointRadius: 0, fill: false, tension: 0.2,
      });
    }
  });

  // Price line (on top, with gradient fill)
  const priceColor = isUp ? "#00e676" : "#ff4f4f";
  const priceFill  = isUp ? "rgba(0,230,118,0.06)" : "rgba(255,79,79,0.06)";
  datasets.push({
    label: "Price", data: closes,
    borderColor: priceColor, borderWidth: 2,
    backgroundColor: priceFill, fill: "origin",
    pointRadius: 0, tension: 0.2,
  });

  const opts = baseChartOptions(false);
  opts.scales.y.ticks.callback = v => "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });

  taCharts.price = new Chart(canvas, {
    type: "line", data: { labels, datasets }, options: opts,
  });
}

// ── Volume ─────────────────────────────────────────────
function redrawVolChart(data) {
  taCharts.volume?.destroy();
  const canvas = document.getElementById("taChartVol");
  if (!canvas) return;

  const ohlcv  = data.ohlcv;
  const ta     = data.technicals || {};
  const labels = ohlcv.map(d => d.date);
  const vols   = ohlcv.map(d => d.volume);
  const colors = ohlcv.map(d => d.up ? IND_COLORS.vol_up : IND_COLORS.vol_dn);

  const datasets = [{
    label: "Volume", data: vols,
    backgroundColor: colors, borderColor: colors,
    borderWidth: 0, borderRadius: 1, type: "bar",
  }];

  // Volume MA 20
  const volMA = movingAvg(vols, 20);
  datasets.push({
    label: "Vol MA", data: volMA,
    borderColor: IND_COLORS.vol_ma, borderWidth: 1.5,
    pointRadius: 0, fill: false, tension: 0.3, type: "line",
  });

  const opts = baseChartOptions(false);
  opts.scales.y.ticks.callback = v => fmtVolTick(v);
  opts.scales.y.grid.drawBorder = false;

  taCharts.volume = new Chart(canvas, {
    type: "bar", data: { labels, datasets }, options: opts,
  });
}

// ── Oscillator ─────────────────────────────────────────
function redrawOscChart(data) {
  taCharts.osc?.destroy();
  const canvas = document.getElementById("taChartOsc");
  if (!canvas) return;

  const ta     = data.technicals || {};
  const labels = data.ohlcv.map(d => d.date);
  const opts   = baseChartOptions(true);
  let datasets = [];

  if (taActiveOsc === "rsi") {
    datasets = [{
      label: "RSI", data: ta.rsi,
      borderColor: IND_COLORS.rsi, borderWidth: 2,
      pointRadius: 0, fill: false, tension: 0.3,
    }];
    opts.scales.y.min = 0; opts.scales.y.max = 100;
    opts.scales.y.ticks.callback = v => v;
    // Reference line plugin drawn manually
    opts.plugins.annotation = {};

  } else if (taActiveOsc === "macd") {
    const histColors = (ta.macd_hist || []).map(v =>
      v == null ? "transparent" : v >= 0 ? IND_COLORS.macd_hist_up : IND_COLORS.macd_hist_dn);
    datasets = [
      {
        label: "Hist", data: ta.macd_hist,
        backgroundColor: histColors, borderColor: histColors,
        borderWidth: 0, type: "bar",
      },
      {
        label: "MACD", data: ta.macd,
        borderColor: IND_COLORS.macd, borderWidth: 1.5,
        pointRadius: 0, fill: false, tension: 0.3,
      },
      {
        label: "Signal", data: ta.macd_signal,
        borderColor: IND_COLORS.macd_sig, borderWidth: 1.5,
        pointRadius: 0, fill: false, tension: 0.3,
      },
    ];

  } else if (taActiveOsc === "stoch") {
    datasets = [
      {
        label: "%K", data: ta.stoch_k,
        borderColor: IND_COLORS.stoch_k, borderWidth: 1.5,
        pointRadius: 0, fill: false, tension: 0.3,
      },
      {
        label: "%D", data: ta.stoch_d,
        borderColor: IND_COLORS.stoch_d, borderWidth: 1.5,
        pointRadius: 0, fill: false, tension: 0.3, borderDash: [4, 2],
      },
    ];
    opts.scales.y.min = 0; opts.scales.y.max = 100;

  } else if (taActiveOsc === "cci") {
    datasets = [{
      label: "CCI", data: ta.cci,
      borderColor: IND_COLORS.cci, borderWidth: 1.5,
      pointRadius: 0, fill: false, tension: 0.3,
    }];
  }

  taCharts.osc = new Chart(canvas, {
    type: "line", data: { labels, datasets }, options: opts,
  });
}

// ── Reference lines plugin (RSI 70/30, Stoch 80/20) ────
function drawRefLines(chart, levels, color) {
  const { ctx, chartArea, scales } = chart;
  if (!chartArea) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  levels.forEach(v => {
    const y = scales.y.getPixelForValue(v);
    if (y >= chartArea.top && y <= chartArea.bottom) {
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
    }
  });
  ctx.restore();
}

// ── Crosshair Sync ─────────────────────────────────────
function setupCrosshairSync(data) {
  const panelIds = ["taPanelPrice", "taPanelVol", "taPanelOsc"];
  const canvasIds = ["taChartPrice", "taChartVol", "taChartOsc"];

  const onMove = (e, sourceId) => {
    const sourceCanvas = document.getElementById(sourceId);
    if (!sourceCanvas) return;
    const rect = sourceCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Get data index from the source chart
    const sourceChart = taCharts[sourceId === "taChartPrice" ? "price" : sourceId === "taChartVol" ? "volume" : "osc"];
    if (!sourceChart) return;
    const pts = sourceChart.getElementsAtEventForMode(e, "index", { intersect: false }, true);
    if (!pts.length) return;
    const idx = pts[0].index;

    // Draw crosshair on all panels
    canvasIds.forEach(cid => {
      const c = taCharts[cid === "taChartPrice" ? "price" : cid === "taChartVol" ? "volume" : "osc"];
      if (!c) return;
      const ca = c.chartArea;
      if (!ca) return;
      const cx = c.scales.x.getPixelForValue(idx);
      c._customCrosshair = { x: cx };
      c.draw();
      const ctx2 = c.ctx;
      ctx2.save();
      ctx2.beginPath();
      ctx2.moveTo(cx, ca.top);
      ctx2.lineTo(cx, ca.bottom);
      ctx2.strokeStyle = "rgba(200,220,255,0.25)";
      ctx2.lineWidth = 1;
      ctx2.setLineDash([3, 3]);
      ctx2.stroke();
      ctx2.restore();
    });

    // Also draw RSI/Stoch reference lines after chart draws
    const osc = taCharts.osc;
    if (osc) {
      if (taActiveOsc === "rsi")   drawRefLines(osc, [70, 30], "rgba(255,255,255,0.12)");
      if (taActiveOsc === "stoch") drawRefLines(osc, [80, 20], "rgba(255,255,255,0.12)");
      if (taActiveOsc === "cci")   drawRefLines(osc, [100, -100], "rgba(255,255,255,0.12)");
    }

    // Update custom tooltip
    updateCrosshairTooltip(idx, data, e);
  };

  canvasIds.forEach(cid => {
    const el = document.getElementById(cid);
    if (!el) return;
    el.addEventListener("mousemove", e => onMove(e, cid));
    el.addEventListener("mouseleave", () => {
      document.getElementById("taCrosshairTip").style.display = "none";
      document.getElementById("taOhlcDisplay").textContent = "";
      // Redraw to clear crosshair lines
      Object.values(taCharts).forEach(c => c?.draw());
      // Redraw reference lines
      const osc = taCharts.osc;
      if (osc) {
        if (taActiveOsc === "rsi")   drawRefLines(osc, [70, 30], "rgba(255,255,255,0.12)");
        if (taActiveOsc === "stoch") drawRefLines(osc, [80, 20], "rgba(255,255,255,0.12)");
        if (taActiveOsc === "cci")   drawRefLines(osc, [100, -100], "rgba(255,255,255,0.12)");
      }
    });
  });

  // Draw reference lines after each chart render
  Chart.register({
    id: "refLines",
    afterDraw(chart) {
      const osc = taCharts.osc;
      if (chart !== osc) return;
      if (taActiveOsc === "rsi")   drawRefLines(chart, [70, 30], "rgba(255,255,255,0.12)");
      if (taActiveOsc === "stoch") drawRefLines(chart, [80, 20], "rgba(255,255,255,0.12)");
      if (taActiveOsc === "cci")   drawRefLines(chart, [100, -100], "rgba(255,255,255,0.12)");
    }
  });
}

function updateCrosshairTooltip(idx, data, e) {
  const tip = document.getElementById("taCrosshairTip");
  const ohlc = data.ohlcv[idx];
  const ta   = data.technicals || {};
  if (!ohlc || !tip) return;

  // Update OHLC display above chart
  const ohlcDisp = document.getElementById("taOhlcDisplay");
  if (ohlcDisp) {
    const chgColor = ohlc.up ? "#00e676" : "#ff4f4f";
    ohlcDisp.innerHTML =
      `<span style="color:#8b949e">O</span> <span>$${ohlc.open}</span>  ` +
      `<span style="color:#8b949e">H</span> <span style="color:#00e676">$${ohlc.high}</span>  ` +
      `<span style="color:#8b949e">L</span> <span style="color:#ff4f4f">$${ohlc.low}</span>  ` +
      `<span style="color:#8b949e">C</span> <span style="color:${chgColor}">$${ohlc.close}</span>  ` +
      `<span style="color:#8b949e">V</span> <span>${fmtVolTick(ohlc.volume)}</span>`;
  }

  // Build tooltip rows
  const g = (arr, i) => (arr && arr[i] != null) ? arr[i].toFixed(2) : "—";
  const rows = [];

  if (taIndicators.sma20)  rows.push(["SMA 20",  IND_COLORS.sma20,  g(ta.sma20, idx)]);
  if (taIndicators.sma50)  rows.push(["SMA 50",  IND_COLORS.sma50,  g(ta.sma50, idx)]);
  if (taIndicators.sma200) rows.push(["SMA 200", IND_COLORS.sma200, g(ta.sma200, idx)]);
  if (taIndicators.ema9)   rows.push(["EMA 9",   IND_COLORS.ema9,   g(ta.ema9, idx)]);
  if (taIndicators.ema20)  rows.push(["EMA 20",  IND_COLORS.ema20,  g(ta.ema20, idx)]);
  if (taIndicators.bb)     rows.push(["BB %B",   IND_COLORS.bb_upper, g(ta.bb_width, idx) + "%"]);
  if (taIndicators.vwap)   rows.push(["VWAP",    IND_COLORS.vwap,   g(ta.vwap, idx)]);

  if (taActiveOsc === "rsi")   rows.push(["RSI",    IND_COLORS.rsi,      g(ta.rsi, idx)]);
  if (taActiveOsc === "macd")  {
    rows.push(["MACD",   IND_COLORS.macd,     g(ta.macd, idx)]);
    rows.push(["Signal", IND_COLORS.macd_sig, g(ta.macd_signal, idx)]);
  }
  if (taActiveOsc === "stoch") {
    rows.push(["%K", IND_COLORS.stoch_k, g(ta.stoch_k, idx)]);
    rows.push(["%D", IND_COLORS.stoch_d, g(ta.stoch_d, idx)]);
  }
  if (taActiveOsc === "cci")   rows.push(["CCI", IND_COLORS.cci, g(ta.cci, idx)]);

  const rowsHtml = rows.map(([label, color, val]) => `
    <div class="ta-tooltip-row">
      <span class="ta-tooltip-label" style="color:${color}">${label}</span>
      <span class="ta-tooltip-val">$${val}</span>
    </div>`).join("");

  const section = document.getElementById("taSection");
  const secRect = section?.getBoundingClientRect() || { left: 0, top: 0 };

  tip.innerHTML = `
    <div class="ta-tooltip-date">${ohlc.date}</div>
    ${rowsHtml}`;
  tip.style.display = "block";

  // Position tooltip — keep inside panel
  let tx = e.clientX - secRect.left + 14;
  let ty = e.clientY - secRect.top  + 14;
  const tw = 160, th = tip.offsetHeight || 80;
  const sw = section?.offsetWidth || 600;
  if (tx + tw > sw - 10) tx = e.clientX - secRect.left - tw - 14;
  tip.style.left = tx + "px";
  tip.style.top  = ty + "px";
}

// ── Legend ─────────────────────────────────────────────
function buildLegend(data) {
  const leg = document.getElementById("taLegend");
  if (!leg) return;
  const items = [
    { label: "Price", color: "#e2eaf6", type: "line" },
  ];
  if (taIndicators.sma20)  items.push({ label: "SMA 20",  color: IND_COLORS.sma20,    type: "line" });
  if (taIndicators.sma50)  items.push({ label: "SMA 50",  color: IND_COLORS.sma50,    type: "line" });
  if (taIndicators.sma200) items.push({ label: "SMA 200", color: IND_COLORS.sma200,   type: "line" });
  if (taIndicators.ema9)   items.push({ label: "EMA 9",   color: IND_COLORS.ema9,     type: "line" });
  if (taIndicators.ema20)  items.push({ label: "EMA 20",  color: IND_COLORS.ema20,    type: "line" });
  if (taIndicators.bb)     items.push({ label: "Bol Bands",color: IND_COLORS.bb_upper,type: "line" });
  if (taIndicators.vwap)   items.push({ label: "VWAP",    color: IND_COLORS.vwap,     type: "line" });

  const oscLabels = { rsi: "RSI", macd: "MACD", stoch: "Stoch", cci: "CCI" };
  const oscColors = { rsi: IND_COLORS.rsi, macd: IND_COLORS.macd, stoch: IND_COLORS.stoch_k, cci: IND_COLORS.cci };
  items.push({ label: oscLabels[taActiveOsc], color: oscColors[taActiveOsc], type: "line" });

  leg.innerHTML = items.map(i => `
    <div class="ta-legend-item">
      <div class="ta-legend-line" style="background:${i.color}"></div>
      <span style="color:var(--text3);font-size:10px">${i.label}</span>
    </div>`).join("");
}

// ── Helpers ────────────────────────────────────────────
function movingAvg(arr, n) {
  return arr.map((_, i) => {
    if (i < n - 1) return null;
    const slice = arr.slice(i - n + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / n;
  });
}

function fmtVolTick(v) {
  if (!v) return "0";
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return v.toString();
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
  if (activeChartInstance) { activeChartInstance.destroy(); activeChartInstance = null; }
  Object.values(taCharts).forEach(c => c?.destroy());
  taCharts = {};
  taData = null;
}

// ── THESIS MODAL ───────────────────────────────────────
function showThesis(key, event) {
  if (event) event.stopPropagation();
  const p = presets[key]; if (!p) return;
  const criteria = Object.entries(p.filters).map(([field, rule]) => {
    const names = { trailingPE:"P/E Ratio", priceToBook:"Price/Book", enterpriseToEbitda:"EV/EBITDA",
      revenueGrowth:"Revenue Growth", earningsGrowth:"EPS Growth", pegRatio:"PEG Ratio",
      returnOnEquity:"Return on Equity", debtToEquity:"Debt/Equity",
      operatingMargins:"Operating Margin", dividendYield:"Dividend Yield",
      payoutRatio:"Payout Ratio", above50dma:"Above 50D MA", above200dma:"Above 200D MA",
      regularMarketChangePercent:"Price Change", currentRatio:"Current Ratio" };
    let val = "";
    if ("min" in rule) val = `≥ ${rule.min < 1 && !["trailingPE","forwardPE","pegRatio","currentRatio","debtToEquity"].includes(field) ? (rule.min*100).toFixed(0)+"%" : rule.min}`;
    if ("max" in rule) val = `≤ ${rule.max < 1 && !["trailingPE","forwardPE","pegRatio","currentRatio","debtToEquity","priceToBook"].includes(field) ? (rule.max*100).toFixed(0)+"%" : rule.max}`;
    if ("value" in rule) val = rule.value ? "Required" : "No";
    return `<li><span class="criteria-field">${names[field]||field}</span><span class="criteria-value">${val}</span></li>`;
  }).join("");

  document.getElementById("thesisContent").innerHTML = `
    <div class="thesis-modal-header">
      <span class="thesis-icon-big">${p.icon}</span>
      <div class="thesis-title">${p.name}</div>
    </div>
    <div class="thesis-body">
      <p class="thesis-quote">${p.thesis}</p>
      <div class="thesis-criteria">
        <h4>Screening Criteria</h4>
        <ul class="criteria-list">${criteria}</ul>
      </div>
      <button class="btn btn-primary full-width" onclick="applyPreset('${key}');closeThesisModal()">
        ▶ Apply This Screen
      </button>
    </div>`;
  document.getElementById("thesisModal").classList.add("open");
}
function closeThesisModal() { document.getElementById("thesisModal").classList.remove("open"); }

// ── PAGINATION ────────────────────────────────────────
function renderPagination(total) {
  const totalPages = Math.ceil(total / PER_PAGE);
  const pg = document.getElementById("pagination");
  if (totalPages <= 1) { pg.style.display = "none"; return; }
  pg.style.display = "flex";
  document.getElementById("pageInfo").textContent = `Page ${currentPage} of ${totalPages}`;
  document.getElementById("btnPrev").disabled = currentPage <= 1;
  document.getElementById("btnNext").disabled = currentPage >= totalPages;
}
function changePage(delta) { currentPage += delta; runScreen(false); }

// ── SORT ──────────────────────────────────────────────
function toggleSortDir() {
  sortDir = sortDir === "desc" ? "asc" : "desc";
  document.getElementById("sortDirBtn").textContent = sortDir === "desc" ? "↓" : "↑";
  runScreen();
}

// ── EXPORT ────────────────────────────────────────────
function exportCSV() {
  if (!allResults.length) { showToast("No results to export.", "error"); return; }
  const hdr = ["Symbol","Name","Sector","Price","P/E","P/B","ROE%","RevGrowth%","OpMargin%","DivYield%","Chg%","MarketCap"];
  const rows = allResults.map(s => [
    s.symbol, `"${(s.shortName||"").replace(/"/g,'""')}"`, `"${(s.sector||"")}"`,
    (s.currentPrice||s.previousClose||"").toFixed?.(2) || "",
    s.trailingPE?.toFixed(1)||"", s.priceToBook?.toFixed(2)||"",
    s.returnOnEquity?(s.returnOnEquity*100).toFixed(1):"",
    s.revenueGrowth?(s.revenueGrowth*100).toFixed(1):"",
    s.operatingMargins?(s.operatingMargins*100).toFixed(1):"",
    s.dividendYield?(s.dividendYield*100).toFixed(2):"",
    s.regularMarketChangePercent?.toFixed(2)||"", s.marketCap||"",
  ]);
  const csv = [hdr.join(","), ...rows.map(r=>r.join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv],{type:"text/csv"})),
    download: `screen-${new Date().toISOString().slice(0,10)}.csv`
  });
  a.click();
  showToast(`Exported ${allResults.length} stocks`, "success");
}

// ── TOAST ─────────────────────────────────────────────
function showToast(msg, type = "") {
  const t = Object.assign(document.createElement("div"), { className: `toast ${type}`, textContent: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
