// stock-map.js — Finviz-style sector treemap.
// Tile size = market cap (within sector), color = % change.
// Layout: outer treemap places sector blocks; inner treemap places stocks.

let _smRows = [];
let _smSectorFilter = "";

// Tile typography scales with tile size (TradingView style), clamped to this range.
const SM_FONT_MIN = 9;
const SM_FONT_MAX = 30;

// Company logo for a ticker. Free no-key image endpoint; Taiwan .TW and any
// symbol without a logo just 404 and the <img> removes itself (see error handler).
function logoUrl(symbol) {
  return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`;
}

async function loadStockMap() {
  const wrap = document.getElementById("stockMap");
  if (!wrap) return;
  try {
    const r = await fetch("/api/stockmap");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _smRows = await r.json();
    populateSectorFilter();
    renderStockMap();
  } catch (e) {
    wrap.innerHTML = `<div class="news-error">Failed to load stock map: ${e.message || e}</div>`;
  }
}

function populateSectorFilter() {
  const sel = document.getElementById("stockmapSector");
  if (!sel || sel._populated) return;
  const sectors = [...new Set(_smRows.map(r => r.sector).filter(Boolean))].sort();
  for (const s of sectors) {
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    _smSectorFilter = sel.value;
    renderStockMap();
  });
  sel._populated = true;
}

let _smRenderTries = 0;

function renderStockMap() {
  const wrap = document.getElementById("stockMap");
  if (!wrap) return;
  let W = wrap.clientWidth, H = wrap.clientHeight;
  // The container may not have laid out yet — retry a bounded number of times,
  // then fall back to sensible dimensions so we NEVER loop forever.
  if (W < 50 || H < 50) {
    if (_smRenderTries < 30) {
      _smRenderTries++;
      requestAnimationFrame(renderStockMap);
      return;
    }
    // Give up waiting — use a fallback size so the map still draws.
    W = Math.max(W, wrap.parentElement?.clientWidth || 600);
    H = Math.max(H, 400);
  }
  _smRenderTries = 0;
  wrap.innerHTML = "";

  const rows = _smSectorFilter
    ? _smRows.filter(r => r.sector === _smSectorFilter)
    : _smRows;
  if (!rows.length) {
    wrap.innerHTML = `<div class="news-loading">No data.</div>`;
    return;
  }

  // Group by sector
  const bySector = new Map();
  for (const r of rows) {
    if (!bySector.has(r.sector)) bySector.set(r.sector, []);
    bySector.get(r.sector).push(r);
  }
  // Outer treemap: each sector is a node sized by total market cap
  const sectorNodes = [...bySector.entries()].map(([name, items]) => ({
    name,
    items,
    value: items.reduce((s, x) => s + x.mcap, 0),
  })).sort((a, b) => b.value - a.value);

  const sectorRects = squarifiedTreemap(sectorNodes, { x: 0, y: 0, w: W, h: H });

  const SECTOR_GAP = 1; // 1px inset per sector = 2px gap between adjacent sectors

  for (const sr of sectorRects) {
    const bx = sr.x + SECTOR_GAP, by = sr.y + SECTOR_GAP;
    const bw = sr.w - 2 * SECTOR_GAP, bh = sr.h - 2 * SECTOR_GAP;

    const block = document.createElement("div");
    block.className = "sm-sector";
    block.style.left = bx + "px";
    block.style.top = by + "px";
    block.style.width = bw + "px";
    block.style.height = bh + "px";

    // Sector label header (only if there's room)
    const showLabel = bw > 60 && bh > 30;
    if (showLabel) {
      const label = document.createElement("div");
      label.className = "sm-sector-label";
      label.textContent = sr.node.name;
      block.appendChild(label);
    }

    // Inner area for tiles
    const inner = document.createElement("div");
    inner.className = "sm-sector-inner";
    const headerH = showLabel ? 16 : 0;
    inner.style.left = "0";
    inner.style.top = headerH + "px";
    inner.style.width = bw + "px";
    inner.style.height = (bh - headerH) + "px";
    block.appendChild(inner);

    // Stocks within sector
    const stockNodes = sr.node.items
      .map(it => ({ ...it, value: it.mcap }))
      .sort((a, b) => b.value - a.value);

    const stockRects = squarifiedTreemap(stockNodes,
      { x: 0, y: 0, w: bw, h: bh - headerH });

    for (const tr of stockRects) {
      const tile = document.createElement("a");
      tile.href = `/stock/${encodeURIComponent(tr.node.symbol)}`;
      tile.className = "sm-tile";
      tile.style.left = tr.x + "px";
      tile.style.top = tr.y + "px";
      tile.style.width = tr.w + "px";
      tile.style.height = tr.h + "px";
      tile.style.background = colorForChange(tr.node.change_pct);
      tile.style.color = textForChange(tr.node.change_pct);
      tile.title = `${tr.node.symbol} — ${tr.node.name} · $${(tr.node.mcap/1e9).toFixed(1)}B · ${tr.node.change_pct >= 0 ? "+" : ""}${tr.node.change_pct}%`;

      // Industry standard (Finviz/TradingView): hide text on small tiles — color only.
      // full = ticker + change%; medium = ticker only; below threshold = nothing.
      const showFull = tr.w > 80 && tr.h > 48;
      const showMedium = !showFull && tr.w > 44 && tr.h > 28;

      if (showFull || showMedium) {
        // Logo on big tiles, TradingView-style: logo chip on top, then ticker, then %.
        // Tickers without a logo (e.g. Taiwan .TW) silently drop the <img> on error,
        // so the tile gracefully falls back to ticker + change% only.
        if (showFull && tr.w >= 72 && tr.h >= 64) {
          const logoSize = Math.max(18, Math.min(tr.w * 0.30, tr.h * 0.28, 52));
          const logo = document.createElement("img");
          logo.className = "sm-tile-logo";
          logo.alt = "";
          logo.loading = "lazy";
          logo.src = logoUrl(tr.node.symbol);
          logo.style.width = logo.style.height = Math.round(logoSize) + "px";
          logo.addEventListener("error", () => logo.remove());
          tile.appendChild(logo);
        }

        // Scale typography to tile size like TradingView — big caps (NVDA) get a
        // large label, small tiles get a small one. Width-constrain so the ticker
        // fits horizontally; height-constrain so a two-line tile doesn't overflow.
        const symFont = Math.max(
          SM_FONT_MIN,
          Math.min(tr.w / (tr.node.symbol.length * 0.62), tr.h * 0.34, SM_FONT_MAX),
        );
        const sym = document.createElement("div");
        sym.className = "sm-tile-sym";
        sym.textContent = tr.node.symbol;
        sym.style.fontSize = symFont.toFixed(1) + "px";
        tile.appendChild(sym);
        if (showFull) {
          const chg = document.createElement("div");
          chg.className = "sm-tile-chg";
          chg.style.fontSize = Math.max(SM_FONT_MIN - 1, symFont * 0.62).toFixed(1) + "px";
          chg.textContent = (tr.node.change_pct >= 0 ? "+" : "") + tr.node.change_pct.toFixed(2) + "%";
          tile.appendChild(chg);
        }
      }
      inner.appendChild(tile);
    }
    wrap.appendChild(block);
  }
}

// ── 7-band stepped color scale matching TradingView's DARK-mode heatmap ──────
// Bands: ≤-4.5  -4.5→-2.5  -2.5→-0.5  flat  +0.5→+2.5  +2.5→+4.5  ≥+4.5
// Flat band is a muted dark slate (TV dark mode), not light grey, so it sits
// naturally on the dark dashboard instead of glaring out.
const _FLAT_BG = '#3a3e4a';
const _FLAT_TEXT = '#c4c9d4';
const _COLOR_BANDS = [
  { min: -Infinity, max: -4.5, bg: '#8b1a1f', text: '#fff' },
  { min: -4.5,      max: -2.5, bg: '#c0252c', text: '#fff' },
  { min: -2.5,      max: -0.5, bg: '#e15c5c', text: '#fff' },
  { min: -0.5,      max:  0.5, bg: _FLAT_BG, text: _FLAT_TEXT },
  { min:  0.5,      max:  2.5, bg: '#2eaa6a', text: '#fff' },
  { min:  2.5,      max:  4.5, bg: '#0c8a48', text: '#fff' },
  { min:  4.5,      max:  Infinity, bg: '#06602f', text: '#fff' },
];

function colorForChange(p) {
  if (p == null || isNaN(p)) return _FLAT_BG;
  return _COLOR_BANDS.find(b => p >= b.min && p < b.max)?.bg ?? _FLAT_BG;
}

function textForChange(p) {
  if (p == null || isNaN(p)) return _FLAT_TEXT;
  return _COLOR_BANDS.find(b => p >= b.min && p < b.max)?.text ?? '#fff';
}

// ── Squarified treemap (Bruls, Huijsen & van Wijk 2000) ─────
// Returns array of {x, y, w, h, node} aligned with the input nodes.
function squarifiedTreemap(nodes, rect) {
  const total = nodes.reduce((s, n) => s + n.value, 0);
  if (!total) return [];
  // Normalize values to fit the rect's area
  const scale = (rect.w * rect.h) / total;
  const items = nodes.map(n => ({ node: n, area: n.value * scale }));
  const out = [];
  layout(items, { ...rect }, out);
  return out;
}

function layout(items, rect, out) {
  if (!items.length) return;
  if (items.length === 1) {
    out.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, node: items[0].node });
    return;
  }
  let row = [];
  let i = 0;
  let shortSide = Math.min(rect.w, rect.h);
  while (i < items.length) {
    const next = items[i];
    if (!row.length) { row.push(next); i++; continue; }
    const withNext = [...row, next];
    if (worst(withNext, shortSide) <= worst(row, shortSide)) {
      row.push(next);
      i++;
    } else break;
  }
  // Lay out the current row, then recurse on the remaining rect
  const newRect = placeRow(row, rect, out);
  layout(items.slice(i), newRect, out);
}

function worst(row, w) {
  if (!row.length) return Infinity;
  const sum = row.reduce((s, r) => s + r.area, 0);
  let max = -Infinity, min = Infinity;
  for (const r of row) {
    if (r.area > max) max = r.area;
    if (r.area < min) min = r.area;
  }
  const w2 = w * w;
  const sum2 = sum * sum;
  return Math.max((w2 * max) / sum2, sum2 / (w2 * min));
}

function placeRow(row, rect, out) {
  const sum = row.reduce((s, r) => s + r.area, 0);
  const horizontal = rect.w >= rect.h;
  if (horizontal) {
    // Stack vertically along the left edge, each w/h based on row sum.
    const rowW = sum / rect.h;
    let y = rect.y;
    for (const r of row) {
      const h = r.area / rowW;
      out.push({ x: rect.x, y, w: rowW, h, node: r.node });
      y += h;
    }
    return { x: rect.x + rowW, y: rect.y, w: rect.w - rowW, h: rect.h };
  } else {
    const rowH = sum / rect.w;
    let x = rect.x;
    for (const r of row) {
      const w = r.area / rowH;
      out.push({ x, y: rect.y, w, h: rowH, node: r.node });
      x += w;
    }
    return { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
  }
}

// Re-render on resize (debounced)
let _smResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(_smResizeTimer);
  _smResizeTimer = setTimeout(() => {
    if (_smRows.length) renderStockMap();
  }, 150);
});
