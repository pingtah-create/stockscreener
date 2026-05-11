// portfolio.js

const STORAGE_KEY = `stockdash_portfolio_v1_${window.CURRENT_USER || 'default'}`;
const COLORS = ['#4f8cff','#00bcd4','#ff9800','#f44336','#ab47bc','#26c6da',
                 '#ffd54f','#4db6ac','#ef5350','#42a5f5','#66bb6a','#ec407a'];

let holdings       = [];
let period         = '3mo';
let lineInst       = null;
let donutInst      = null;
let tickerUniverse = [];

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  loadTickerUniverse();
  const localData = _localLoad();
  try {
    const r = await fetch('/api/portfolio/holdings');
    if (r.ok) {
      const serverData = await r.json();
      if (Array.isArray(serverData) && serverData.length > 0) {
        holdings = serverData;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings)); } catch {}
      } else if (localData.length > 0) {
        holdings = localData;
        saveHoldings();
      } else {
        holdings = [];
      }
    } else {
      holdings = localData;
    }
  } catch {
    holdings = localData;
  }
  setupTickerSearch();
  if (holdings.length) {
    renderTable([]);          // show skeleton while loading
    fetchSummary();           // live prices + stats
    fetchPerf(period);        // performance chart
  } else {
    document.getElementById('portChartEmpty').style.display = 'flex';
  }
}

// ── Add form toggle ───────────────────────────────────────────────────────────

function toggleAddForm() {
  const form = document.getElementById('portAddForm');
  const btn  = document.getElementById('addToggleBtn');
  const open = form.style.display === 'none' || form.style.display === '';
  form.style.display = open ? 'block' : 'none';
  btn.textContent    = open ? '− Close' : '+ Add';
  if (open) document.getElementById('tickerInput').focus();
}

// ── Performance chart ─────────────────────────────────────────────────────────

async function fetchPerf(p) {
  if (!holdings.length) return;
  const empty = document.getElementById('portChartEmpty');
  if (empty) empty.style.display = 'none';
  try {
    const r = await fetch('/api/portfolio/perf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdings, period: p }),
    });
    const data = await r.json();
    if (!r.ok || data.error) { if (empty) empty.style.display = 'flex'; return; }

    // Header values
    const fmv = v => '$' + (+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('portTotalValue').textContent = fmv(data.total_value);
    const pnl    = data.period_pnl;
    const pnlPct = data.period_pnl_pct;
    const chgEl  = document.getElementById('portPeriodChg');
    chgEl.textContent  = `${pnl >= 0 ? '+' : ''}${fmv(pnl)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`;
    chgEl.className    = 'port-perf-chg ' + (pnl >= 0 ? 'pos' : 'neg');

    renderPerfChart(data.historical);
  } catch {}
}

function renderPerfChart(historical) {
  const ctx    = document.getElementById('lineChart').getContext('2d');
  const labels = historical.map(d => d.date);
  const portPts = historical.map(d => d.pct);
  const spyPts  = historical.map(d => d.spy_pct ?? null);
  const isPos   = (portPts[portPts.length - 1] ?? 0) >= 0;

  if (lineInst) lineInst.destroy();
  lineInst = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Portfolio',
          data: portPts,
          borderColor: isPos ? '#4f8cff' : '#f44336',
          backgroundColor: isPos ? 'rgba(79,140,255,0.07)' : 'rgba(244,67,54,0.07)',
          borderWidth: 2, pointRadius: 0, tension: 0.3, fill: true,
        },
        {
          label: 'S&P 500',
          data: spyPts,
          borderColor: '#444', borderWidth: 1.5, borderDash: [4, 4],
          pointRadius: 0, tension: 0.3, fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#666', font: { size: 11 }, boxWidth: 12, padding: 14 } },
        tooltip: {
          backgroundColor: '#161616', borderColor: '#222', borderWidth: 1,
          titleColor: '#888', bodyColor: '#ccc',
          callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y >= 0 ? '+' : ''}${c.parsed.y.toFixed(2)}%` },
        },
      },
      scales: {
        x: { ticks: { color: '#555', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: '#1a1a1a' } },
        y: {
          ticks: { color: '#555', font: { size: 10 }, callback: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` },
          grid: { color: '#1a1a1a' },
        },
      },
    },
  });
}

async function loadTickerUniverse() {
  try {
    const r = await fetch('/api/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: {}, sort_by: 'marketCap', sort_dir: 'desc', page: 1, per_page: 300 }),
    });
    const data = await r.json();
    tickerUniverse = data.results || [];
  } catch {}
}

function setupTickerSearch() {
  const input    = document.getElementById('tickerInput');
  const dropdown = document.getElementById('tickerDropdown');
  let debounce;

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim().toUpperCase();
    if (q.length < 1) { dropdown.classList.remove('open'); return; }
    debounce = setTimeout(() => {
      const found = tickerUniverse.filter(s =>
        s.symbol?.toUpperCase().startsWith(q) ||
        s.symbol?.toUpperCase().includes(q) ||
        (s.shortName || '').toUpperCase().includes(q)
      ).slice(0, 8);
      if (!found.length) { dropdown.classList.remove('open'); return; }
      dropdown.innerHTML = found.map(s => `
        <div class="search-result-item" data-symbol="${s.symbol}">
          <span class="search-ticker">${s.symbol}</span>
          <span class="search-name">${s.shortName || s.longName || ''}</span>
        </div>`).join('');
      dropdown.querySelectorAll('.search-result-item').forEach(el => {
        el.addEventListener('click', () => selectTicker(el.dataset.symbol));
      });
      dropdown.classList.add('open');
    }, 150);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { dropdown.classList.remove('open'); return; }
    if (e.key === 'Enter')  { dropdown.classList.remove('open'); addHolding(); }
  });

  document.addEventListener('click', e => {
    if (!input.closest('.port-ticker-wrap').contains(e.target)) dropdown.classList.remove('open');
  });
}

function selectTicker(symbol) {
  document.getElementById('tickerInput').value = symbol;
  document.getElementById('tickerDropdown').classList.remove('open');
  document.getElementById('sharesInput').focus();
}

function _localLoad() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}

// ── Period buttons ────────────────────────────────────────────────────────────

document.querySelectorAll('.port-period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.port-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    period = btn.dataset.period;
    fetchPerf(period);
  });
});

// Enter key on shares/buyin — ticker Enter is handled in setupTickerSearch
document.getElementById('sharesInput').addEventListener('keydown', e => { if (e.key === 'Enter') addHolding(); });
document.getElementById('buyinInput').addEventListener('keydown',  e => { if (e.key === 'Enter') addHolding(); });

// ── Import CSV / JSON ─────────────────────────────────────────────────────────

document.getElementById('importFile').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  this.value = '';  // reset so same file can be re-imported
  const reader = new FileReader();
  reader.onload = e => {
    const buf = e.target.result;
    const b = new Uint8Array(buf.slice(0, 3));
    let enc = 'utf-8';
    if (b[0] === 0xFF && b[1] === 0xFE) enc = 'utf-16le';
    else if (b[0] === 0xFE && b[1] === 0xFF) enc = 'utf-16be';
    const text = new TextDecoder(enc).decode(buf);
    handleImport(file.name, text);
  };
  reader.readAsArrayBuffer(file);
});

function handleImport(filename, text) {
  let rows = [];
  try {
    rows = filename.toLowerCase().endsWith('.json') ? parseImportJSON(text) : parseImportCSV(text);
  } catch (err) {
    showImportMsg(`Import failed: ${err.message}`, true);
    return;
  }
  if (!rows.length) { showImportMsg('No valid holdings found in file.', true); return; }

  let added = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const ticker = (row.ticker || '').toUpperCase();
    if (!ticker) { skipped++; continue; }
    const shares = parseFloat(row.shares);
    if (!shares || shares <= 0) { skipped++; continue; }
    const buyin = row.buyin != null ? parseFloat(row.buyin) || null : null;
    const existing = holdings.find(h => h.ticker === ticker);
    if (existing) { existing.shares = shares; if (buyin) existing.buyin = buyin; updated++; }
    else { holdings.push({ ticker, shares, buyin }); added++; }
  }

  saveHoldings();
  if (holdings.length) {
    renderTable([]);
    fetchSummary();
    fetchPerf(period);
  }
  const parts = [];
  if (added)   parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  if (skipped) parts.push(`${skipped} skipped`);
  showImportMsg(`Imported: ${parts.join(', ')}.`);
}

function showImportMsg(msg, isError = false) {
  const el = document.getElementById('importMsg');
  el.textContent = msg;
  el.style.color = isError ? 'var(--red)' : 'var(--green)';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function parseImportJSON(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : data.holdings || data.portfolio || [];
  if (!Array.isArray(arr)) throw new Error('Expected a JSON array');
  return arr.map(item => ({
    ticker: item.ticker || item.symbol || item.Symbol || item.Ticker || '',
    shares: item.shares ?? item.quantity ?? item.qty ?? item.Shares ?? item.Quantity ?? null,
    buyin:  item.buyin  ?? item.buy_price ?? item.avg_cost ?? item.cost ?? item.price ?? item.Price ?? null,
  }));
}

function parseImportCSV(text) {
  // Strip BOM if TextDecoder left one (some decoders keep it)
  const clean = text.replace(/^﻿/, '');
  const lines = clean.trim().split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];

  // Detect separator: tab beats comma when header line has tabs
  const sep = lines[0].includes('\t') ? '\t' : ',';

  // Detect header row
  const first = lines[0].toLowerCase();
  const hasHeader = /ticker|symbol|shares|quantity|holdings/.test(first);
  const rawHeaders = hasHeader ? lines[0].split(sep).map(h => h.trim().toLowerCase().replace(/^'/, '')) : null;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  // Column index resolver
  const col = (row, ...names) => {
    if (!rawHeaders) return '';
    for (const n of names) {
      const i = rawHeaders.findIndex(h => h === n || h.includes(n));
      if (i >= 0) return (row[i] ?? '').trim().replace(/^'/, '');
    }
    return '';
  };

  return dataLines.map(line => {
    const parts = line.split(sep).map(s => s.trim().replace(/^"|"$/g, '').replace(/^'/, ''));
    if (rawHeaders) {
      return {
        // Tiger: "symbol", generic: "ticker" / "symbol"
        ticker: col(parts, 'symbol', 'ticker') || parts[0] || '',
        // Tiger: "holdings", generic: "shares" / "quantity"
        shares: col(parts, 'holdings', 'shares', 'quantity', 'qty') || parts[1] || null,
        // Tiger: "cost (fifo)", generic: "cost" / "avg_cost" / "buy_price" / "price"
        buyin:  col(parts, 'cost (fifo)', 'cost', 'avg_cost', 'buy_price', 'buyin', 'price') || parts[2] || null,
      };
    }
    return { ticker: parts[0] || '', shares: parts[1] || null, buyin: parts[2] || null };
  });
}

// ── Holdings management ───────────────────────────────────────────────────────

function saveHoldings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings)); } catch {}
  fetch('/api/portfolio/holdings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(holdings),
  }).catch(() => {});
}

function addHolding() {
  const tickerEl = document.getElementById('tickerInput');
  const sharesEl = document.getElementById('sharesInput');
  const buyinEl  = document.getElementById('buyinInput');
  const ticker   = tickerEl.value.trim().toUpperCase();
  const shares   = parseFloat(sharesEl.value);
  const buyin    = parseFloat(buyinEl.value) || null;
  if (!ticker || !shares || shares <= 0) return;

  const existing = holdings.find(h => h.ticker === ticker);
  if (existing) { existing.shares = shares; existing.buyin = buyin; }
  else holdings.push({ ticker, shares, buyin });

  saveHoldings();
  renderTable([]);
  tickerEl.value = '';
  sharesEl.value = '';
  buyinEl.value  = '';
  tickerEl.focus();
  fetchSummary();
  fetchPerf(period);
}

function removeHolding(ticker) {
  holdings = holdings.filter(h => h.ticker !== ticker);
  saveHoldings();
  if (holdings.length) {
    fetchSummary();
    fetchPerf(period);
  } else {
    document.getElementById('holdingsTable').innerHTML = '';
    document.getElementById('portStats').style.display = 'none';
    document.getElementById('portAiRow').style.display = 'none';
    document.getElementById('portAnalysis').style.display = 'none';
    document.getElementById('portTotalValue').textContent = '—';
    document.getElementById('portPeriodChg').textContent = '';
    const empty = document.getElementById('portChartEmpty');
    if (empty) empty.style.display = 'flex';
    if (lineInst) { lineInst.destroy(); lineInst = null; }
  }
}

function renderPills() {
  // Holdings are now shown in renderTable(); this is a no-op kept for import compatibility
}

// ── Live summary (auto-load) ───────────────────────────────────────────────────

async function fetchSummary() {
  const stamp = document.getElementById('priceStamp');
  if (stamp) stamp.textContent = 'Updating…';
  try {
    // Always send holdings in the body so the server never needs to read from
    // disk — this survives Vercel cold starts and server-side storage misses.
    const r    = await fetch('/api/portfolio/summary', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ holdings }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    renderStats(data.metrics);
    renderTable(data.allocation);
    if (stamp) stamp.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    if (stamp) stamp.textContent = 'Price fetch failed';
  }
}

// Auto-refresh prices every 60s
setInterval(() => { if (holdings.length) fetchSummary(); }, 60000);

// ── Stats ─────────────────────────────────────────────────────────────────────

function renderStats(m) {
  const fv  = v => v != null ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : '—';
  const fmv = v => v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  const hasCost = m.total_cost != null;

  document.getElementById('portStats').innerHTML = `
    <div class="port-stat">
      <div class="port-stat-label">Total Value</div>
      <div class="port-stat-value">${fmv(m.total_value)}</div>
      <div class="port-stat-sub">${hasCost ? 'Cost ' + fmv(m.total_cost) : m.num_stocks + ' position' + (m.num_stocks !== 1 ? 's' : '')}</div>
    </div>
    ${hasCost ? `
    <div class="port-stat">
      <div class="port-stat-label">Unrealized P&L</div>
      <div class="port-stat-value ${m.total_pnl >= 0 ? 'pos' : 'neg'}">${fmv(m.total_pnl)}</div>
      <div class="port-stat-sub ${m.total_pnl_pct >= 0 ? 'pos' : 'neg'}">${fv(m.total_pnl_pct)} all time</div>
    </div>` : `
    <div class="port-stat">
      <div class="port-stat-label">Positions</div>
      <div class="port-stat-value" style="font-size:26px">${m.num_stocks}</div>
      <div class="port-stat-sub">stocks tracked</div>
    </div>`}
    <div class="port-stat">
      <div class="port-stat-label">Largest Position</div>
      <div class="port-stat-value" style="font-size:20px">${m.top_stock || '—'}</div>
      <div class="port-stat-sub">${m.top_concentration_pct != null ? m.top_concentration_pct.toFixed(1) + '% of portfolio' : ''}</div>
    </div>`;

  document.getElementById('portStats').style.display = 'grid';
  document.getElementById('portAiRow').style.display = 'flex';
}

// ── Holdings table (live) ─────────────────────────────────────────────────────

function renderTable(allocation) {
  const hasCost = allocation.some(a => a.cost_basis != null);

  const fmtChg = c => {
    if (c == null) return '—';
    return `<span class="${c >= 0 ? 'pos' : 'neg'}">${c >= 0 ? '+' : ''}${c.toFixed(2)}%</span>`;
  };
  const fmtPnl = (v, pct) => {
    if (v == null) return '—';
    const s = v >= 0 ? '+' : '';
    return `<span class="${v >= 0 ? 'pos' : 'neg'}">${s}$${Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} (${s}${pct.toFixed(1)}%)</span>`;
  };
  const fmtV = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const tableEl = document.getElementById('holdingsTable');
  tableEl.innerHTML = `
    <table class="port-table">
      <thead>
        <tr>
          <th>Ticker</th><th>Shares</th>
          ${hasCost ? '<th>Avg Cost</th>' : ''}
          <th>Price</th><th>Today</th><th>Value</th>
          ${hasCost ? '<th>Cost Basis</th><th>Unrealized P&L</th>' : ''}
          <th>Weight</th><th>Sector</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${allocation.map(a => `
          <tr>
            <td class="col-ticker"><a href="/stock/${a.ticker}">${a.ticker}</a></td>
            <td>${a.shares}</td>
            ${hasCost ? `<td>${a.buyin != null ? '$' + a.buyin.toFixed(2) : '—'}</td>` : ''}
            <td>$${a.price.toFixed(2)}</td>
            <td>${fmtChg(a.change_pct)}</td>
            <td>${fmtV(a.value)}</td>
            ${hasCost ? `<td>${a.cost_basis != null ? fmtV(a.cost_basis) : '—'}</td><td>${fmtPnl(a.unrealized_pnl, a.unrealized_pnl_pct)}</td>` : ''}
            <td>${a.pct.toFixed(1)}%</td>
            <td style="color:var(--text3)">${a.sector !== 'Unknown' ? a.sector : '—'}</td>
            <td><button class="port-pill-rm" data-ticker="${a.ticker}" title="Remove">×</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  tableEl.querySelectorAll('button[data-ticker]').forEach(btn => {
    btn.addEventListener('click', () => removeHolding(btn.dataset.ticker));
  });
}

// ── Full analysis ─────────────────────────────────────────────────────────────

async function analyzePortfolio() {
  if (!holdings.length) return;
  const btn     = document.getElementById('analyzeBtn');
  const loading = document.getElementById('portLoading');
  btn.disabled  = true;
  loading.style.display = 'flex';
  document.getElementById('portAnalysis').style.display = 'none';
  try {
    const r    = await fetch('/api/portfolio-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdings, period }),
    });
    const data = await r.json();
    if (r.status === 429) {
      document.getElementById('portAnalysis').style.display = 'block';
      document.getElementById('analysisBody').innerHTML =
        `<p style="color:var(--yellow,#ffd54f);font-size:13px">⏳ ${data.message || 'AI rate limit reached — wait a minute and try again.'}</p>`;
      return;
    }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    renderAnalysis(data);
  } catch (err) {
    document.getElementById('portAnalysis').style.display = 'block';
    document.getElementById('analysisBody').innerHTML =
      `<p style="color:var(--red);font-size:13px">Analysis failed: ${err.message}. Check your holdings and try again.</p>`;
  } finally {
    btn.disabled = false;
    loading.style.display = 'none';
  }
}

function renderAnalysis(data) {
  const { allocation, analysis } = data;
  document.getElementById('portAnalysis').style.display = 'block';
  renderDonut(allocation);
  renderAIText(analysis);
  document.getElementById('portAnalysis').scrollIntoView({ behavior: 'smooth' });
}

// ── Donut chart ───────────────────────────────────────────────────────────────

function renderDonut(allocation) {
  const ctx    = document.getElementById('donutChart').getContext('2d');
  const colors = allocation.map((_, i) => COLORS[i % COLORS.length]);

  if (donutInst) donutInst.destroy();
  donutInst = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: allocation.map(a => a.ticker),
      datasets: [{ data: allocation.map(a => a.pct), backgroundColor: colors, borderColor: '#111', borderWidth: 2, hoverBorderWidth: 3 }],
    },
    options: {
      responsive: false, cutout: '64%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161616', borderColor: '#222', borderWidth: 1, bodyColor: '#ccc',
          callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}%` },
        },
      },
    },
  });

  document.getElementById('donutLegend').innerHTML = allocation.map((a, i) => `
    <div class="port-legend-item">
      <div class="port-legend-dot" style="background:${colors[i]}"></div>
      <span class="port-legend-ticker">${a.ticker}</span>
      <span class="port-legend-pct">${a.pct.toFixed(1)}%</span>
    </div>`).join('');
}

// ── AI text ───────────────────────────────────────────────────────────────────

function renderAIText(text) {
  document.getElementById('analysisBody').innerHTML = renderMarkdown(text || '*Analysis not available*');
}

// ── Markdown ──────────────────────────────────────────────────────────────────

function renderMarkdown(s) {
  if (!s) return '';
  let o = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  o = o.replace(/^---$/gm, '<hr>');
  o = o.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  o = o.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  o = o.replace(/^# (.+)$/gm,   '<h1>$1</h1>');
  o = o.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trim()}</code></pre>`);
  o = o.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  o = o.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  o = o.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  o = o.replace(/<strong>(STRONG|BALANCED|WEAK)<\/strong>/g, (_, v) => {
    const cls = v === 'STRONG' ? 'port-verdict-strong' : v === 'WEAK' ? 'port-verdict-weak' : 'port-verdict-balanced';
    return `<strong class="${cls}">${v}</strong>`;
  });
  o = o.replace(/(^|\n)((?:[ \t]*[-*][ \t]+.+(?:\n|$))+)/g, (_, lead, block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*][ \t]+/, '')}</li>`).join('');
    return `${lead}<ul>${items}</ul>`;
  });
  o = o.replace(/((?:^|\n)\|.+\|(?:\n\|[-| :]+\|)?(?:\n\|.+\|)*)/g, block => {
    const lines = block.trim().split('\n').filter(l => l.trim().startsWith('|'));
    if (lines.length < 2) return block;
    const isSep = l => /^\|[-| :]+\|$/.test(l.trim());
    let html = '<table><thead>'; let inBody = false;
    for (const line of lines) {
      if (isSep(line)) { html += '</thead><tbody>'; inBody = true; continue; }
      const tag = inBody ? 'td' : 'th';
      const cells = line.split('|').slice(1,-1).map(c => c.trim());
      html += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    }
    html += inBody ? '</tbody></table>' : '</thead></table>';
    return html;
  });
  o = o.replace(/\n{2,}/g, '</p><p>');
  o = o.replace(/\n/g, '<br>');
  return `<p>${o}</p>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
