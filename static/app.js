/* US Stock Dashboard */

let allResults = [];

document.addEventListener("DOMContentLoaded", async () => {
  setupSearch();
  setupKeyboardShortcuts();
  updateMarketStatus();
  setInterval(updateMarketStatus, 30000);
  await Promise.all([loadIndices(), checkStatus()]);
  loadMovers();
  loadHeatmap();
  loadNews();
  preloadStocksForSearch();
  setInterval(checkStatus, 4000);
  setInterval(loadIndices, 60000);
  setInterval(loadMovers, 120000);
  setInterval(loadNews, 300000);
});

async function preloadStocksForSearch() {
  try {
    const res = await fetch("/api/screen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: {}, sort_by: "marketCap", sort_dir: "desc", page: 1, per_page: 200 }),
    });
    const data = await res.json();
    allResults = data.results;
  } catch (e) {}
}

// ── MARKET STATUS ─────────────────────────────────────
function updateMarketStatus() {
  const dot   = document.getElementById("marketDot");
  const label = document.getElementById("marketLabel");
  if (!dot || !label) return;
  const now = new Date();
  const etOptions = { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false, weekday: "short" };
  const parts = new Intl.DateTimeFormat("en-US", etOptions).formatToParts(now);
  const weekday = parts.find(p => p.type === "weekday")?.value;
  const hour    = parseInt(parts.find(p => p.type === "hour")?.value || "0");
  const minute  = parseInt(parts.find(p => p.type === "minute")?.value || "0");
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  const totalMin = hour * 60 + minute;
  const openMin  = 9 * 60 + 30;
  const closeMin = 16 * 60;
  const preMin   = 4 * 60;

  dot.className = "market-dot";
  if (isWeekend || totalMin >= closeMin || totalMin < preMin) {
    dot.classList.add("closed");
    label.textContent = "MARKET CLOSED";
    label.style.color = "var(--red)";
  } else if (totalMin < openMin) {
    dot.classList.add("pre");
    label.textContent = `PRE-MARKET · opens in ${openMin - totalMin}m`;
    label.style.color = "var(--yellow)";
  } else {
    dot.classList.add("open");
    const minsLeft = closeMin - totalMin;
    label.textContent = `NYSE OPEN · ${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m left`;
    label.style.color = "var(--green)";
  }
}

// ── TOP MOVERS ────────────────────────────────────────
async function loadMovers() {
  try {
    const data = await fetch("/api/movers").then(r => r.json());
    renderMovers("moverGainers", data.gainers, "up");
    renderMovers("moverLosers",  data.losers,  "down");
    const t = document.getElementById("moversTime");
    if (t) t.textContent = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  } catch (e) {}
}

function renderMovers(containerId, items, cls) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.map(s => {
    const sign = s.chg >= 0 ? "+" : "";
    const shortName = (s.name || "").split(" ").slice(0, 3).join(" ");
    return `<div class="mover-row ${cls}" onclick="window.location='/stock/${s.symbol}'">
      <div class="mover-row-left">
        <span class="mover-row-ticker">${s.symbol}</span>
        <span class="mover-row-name">${shortName}</span>
      </div>
      <span class="mover-row-pct">${sign}${s.chg.toFixed(2)}%</span>
    </div>`;
  }).join("");
}

// ── SECTOR HEAT MAP ───────────────────────────────────
async function loadHeatmap() {
  try {
    const data = await fetch("/api/heatmap").then(r => r.json());
    renderHeatmap(data);
  } catch (e) {}
}

function renderHeatmap(data) {
  const grid = document.getElementById("heatmapGrid");
  if (!grid) return;
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { grid.innerHTML = '<div class="heatmap-loading">No data</div>'; return; }

  grid.innerHTML = entries.map(([sector, chg]) => {
    const pct = Math.min(Math.abs(chg) / 3, 1);
    let bg;
    if (chg > 0) {
      const g = Math.round(40 + pct * 110);
      bg = `rgba(0,${g},40,0.75)`;
    } else {
      const r = Math.round(100 + pct * 130);
      bg = `rgba(${r},20,20,0.75)`;
    }
    const sign = chg >= 0 ? "+" : "";
    const shortName = sector.replace(" Services","").replace(" Cyclical","").replace(" Defensive","");
    return `<div class="heatmap-tile" style="background:${bg}" title="${sector}">
      <div class="heatmap-sector">${shortName}</div>
      <div class="heatmap-pct ${chg >= 0 ? 'up' : 'down'}">${sign}${chg.toFixed(2)}%</div>
    </div>`;
  }).join("");
}

// ── NEWS FEED ─────────────────────────────────────────
async function loadNews() {
  const feed = document.getElementById("newsFeed");
  if (!feed) return;
  feed.innerHTML = `<div class="news-loading"><span class="spinner"></span> Loading news…</div>`;
  try {
    const items = await fetch("/api/news").then(r => r.json());
    if (!items.length) {
      feed.innerHTML = `<div class="news-loading">No news available right now.</div>`;
      return;
    }
    feed.innerHTML = items.map(n => {
      const age = n.age_min == null ? "" :
        n.age_min < 60   ? `${n.age_min}m ago` :
        n.age_min < 1440 ? `${Math.floor(n.age_min/60)}h ago` :
        `${Math.floor(n.age_min/1440)}d ago`;
      const thumb = n.thumbnail
        ? `<img class="news-thumb" src="${n.thumbnail}" alt="" onerror="this.style.display='none'">`
        : `<div class="news-thumb-placeholder">📰</div>`;
      return `<a class="news-item" href="${n.link}" target="_blank" rel="noopener noreferrer">
        ${thumb}
        <div class="news-body">
          <div class="news-title">${n.title}</div>
          <div class="news-meta">
            <span class="news-publisher">${n.publisher || "Reuters"}</span>
            ${age ? `<span class="news-dot"></span><span class="news-age">${age}</span>` : ""}
          </div>
        </div>
      </a>`;
    }).join("");
  } catch (e) {
    feed.innerHTML = `<div class="news-loading" style="color:var(--red)">Failed to load news.</div>`;
  }
}

// ── KEYBOARD SHORTCUTS ─────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      document.getElementById("searchInput").focus();
    }
    if (e.key === "Escape") closeSearch();
  });
}

// ── MARKET INDICES ────────────────────────────────────
async function loadIndices() {
  try {
    const data = await fetch("/api/indices").then(r => r.json());
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
      const card  = document.getElementById(`mktcard-${id}`);
      const price = document.getElementById(`mktprice-${id}`);
      const chgEl = document.getElementById(`mktchg-${id}`);
      if (price) price.textContent = priceStr;
      if (chgEl) { chgEl.textContent = `${sign}${chg.toFixed(2)}%`; chgEl.className = `mkt-card-chg ${cls}`; }
      if (card)  { card.classList.remove("up","down"); card.classList.add(cls); }
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
  const found = allResults.filter(s =>
    s.symbol?.toUpperCase().startsWith(q) ||
    s.symbol?.toUpperCase().includes(q) ||
    (s.shortName || "").toUpperCase().includes(q)
  ).slice(0, 7);

  const dropdown = document.getElementById("searchDropdown");
  const directItem = `<div class="search-result-item" onclick="window.location='/stock/${q}'" style="border-top:1px solid var(--border);opacity:.7">
    <span class="search-ticker">${q}</span>
    <span class="search-name" style="color:var(--text3)">Go to chart →</span>
    <span class="search-sector"></span>
  </div>`;

  dropdown.innerHTML = found.map(s => `
    <div class="search-result-item" onclick="window.location='/stock/${s.symbol}'">
      <span class="search-ticker">${s.symbol}</span>
      <span class="search-name">${s.shortName || s.longName || "—"}</span>
      <span class="search-sector">${s.sector || ""}</span>
    </div>`).join("") + directItem;
  dropdown.classList.add("open");
}

function closeSearch() {
  document.getElementById("searchDropdown").classList.remove("open");
}

// ── STATUS ────────────────────────────────────────────
async function checkStatus() {
  try {
    const data = await fetch("/api/status").then(r => r.json());
    document.getElementById("cacheCount").textContent = `${data.cached_stocks} stocks`;
    const dot  = document.getElementById("statusDot");
    const mini = document.getElementById("refreshMini");
    const fill = document.getElementById("refreshMiniFill");
    const btn  = document.getElementById("btnRefresh");
    const prog = data.refresh;
    if (prog.running) {
      dot.className = "status-dot syncing";
      mini.style.display = "block";
      fill.style.width = (prog.total > 0 ? prog.done / prog.total * 100 : 0).toFixed(1) + "%";
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

// ── TOAST ─────────────────────────────────────────────
function showToast(msg, type = "") {
  const t = Object.assign(document.createElement("div"), { className: `toast ${type}`, textContent: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
