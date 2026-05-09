// stock-map.js — Finviz-style sector treemap.
// Tile size = market cap (within sector), color = % change.
// Layout: outer treemap places sector blocks; inner treemap places stocks.

let _smRows = [];
let _smSectorFilter = "";

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

function renderStockMap() {
  const wrap = document.getElementById("stockMap");
  if (!wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (W < 50 || H < 50) {
    requestAnimationFrame(renderStockMap);
    return;
  }
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

  for (const sr of sectorRects) {
    const block = document.createElement("div");
    block.className = "sm-sector";
    block.style.left = sr.x + "px";
    block.style.top = sr.y + "px";
    block.style.width = sr.w + "px";
    block.style.height = sr.h + "px";

    // Sector label header (only if there's room)
    const showLabel = sr.w > 60 && sr.h > 30;
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
    inner.style.width = sr.w + "px";
    inner.style.height = (sr.h - headerH) + "px";
    block.appendChild(inner);

    // Stocks within sector
    const stockNodes = sr.node.items
      .map(it => ({ ...it, value: it.mcap }))
      .sort((a, b) => b.value - a.value);

    const stockRects = squarifiedTreemap(stockNodes,
      { x: 0, y: 0, w: sr.w, h: sr.h - headerH });

    for (const tr of stockRects) {
      const tile = document.createElement("a");
      tile.href = `/stock/${encodeURIComponent(tr.node.symbol)}`;
      tile.className = "sm-tile";
      tile.style.left = tr.x + "px";
      tile.style.top = tr.y + "px";
      tile.style.width = tr.w + "px";
      tile.style.height = tr.h + "px";
      tile.style.background = colorForChange(tr.node.change_pct);
      tile.title = `${tr.node.symbol} — ${tr.node.name} · $${(tr.node.mcap/1e9).toFixed(1)}B · ${tr.node.change_pct >= 0 ? "+" : ""}${tr.node.change_pct}%`;

      // Show ticker + change% if there's room
      if (tr.w > 36 && tr.h > 22) {
        const sym = document.createElement("div");
        sym.className = "sm-tile-sym";
        sym.textContent = tr.node.symbol;
        tile.appendChild(sym);
        if (tr.h > 38) {
          const chg = document.createElement("div");
          chg.className = "sm-tile-chg";
          chg.textContent = (tr.node.change_pct >= 0 ? "+" : "") + tr.node.change_pct.toFixed(2) + "%";
          tile.appendChild(chg);
        }
      }
      inner.appendChild(tile);
    }
    wrap.appendChild(block);
  }
}

// ── Color: red (loss) → grey (flat) → green (gain) ──────
function colorForChange(p) {
  // Cap at ±5% for color saturation; beyond that, just use the strongest shade.
  const t = Math.max(-1, Math.min(1, p / 5));
  if (t === 0 || isNaN(t)) return "#2a2f36";
  if (t > 0) {
    // 0 → #2a2f36, 1 → #1faa3e
    const a = t;
    return `rgb(${Math.round(42 + (31 - 42) * a)}, ${Math.round(47 + (170 - 47) * a)}, ${Math.round(54 + (62 - 54) * a)})`;
  } else {
    const a = -t;
    return `rgb(${Math.round(42 + (200 - 42) * a)}, ${Math.round(47 + (47 - 47) * a)}, ${Math.round(54 + (47 - 54) * a)})`;
  }
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
