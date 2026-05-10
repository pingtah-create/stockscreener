// portfolio.js

const STORAGE_KEY = `stockdash_portfolio_v1_${window.CURRENT_USER || 'default'}`;
const COLORS = ['#4f8cff','#00bcd4','#ff9800','#f44336','#ab47bc','#26c6da',
                 '#ffd54f','#4db6ac','#ef5350','#42a5f5','#66bb6a','#ec407a'];

let holdings = [];
let period   = '3mo';
let lineInst = null;
let donutInst = null;

// ── Init: load from server, fall back to localStorage ─────────────────────────

async function init() {
  try {
    const r = await fetch('/api/portfolio/holdings');
    if (r.ok) {
      const data = await r.json();
      holdings = Array.isArray(data) ? data : [];
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings)); } catch {}
    } else {
      holdings = _localLoad();
    }
  } catch {
    holdings = _localLoad();
  }
  renderPills();
}

function _localLoad() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// Period buttons
document.querySelectorAll('.port-period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.port-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    period = btn.dataset.period;
  });
});

// Enter key on inputs
document.getElementById('tickerInput').addEventListener('keydown', e => { if (e.key === 'Enter') addHolding(); });
document.getElementById('sharesInput').addEventListener('keydown', e => { if (e.key === 'Enter') addHolding(); });
document.getElementById('buyinInput').addEventListener('keydown',  e => { if (e.key === 'Enter') addHolding(); });

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
  renderPills();
  tickerEl.value = '';
  sharesEl.value = '';
  buyinEl.value  = '';
  tickerEl.focus();
}

function removeHolding(ticker) {
  holdings = holdings.filter(h => h.ticker !== ticker);
  saveHoldings();
  renderPills();
}

function renderPills() {
  const el = document.getElementById('holdingsList');
  if (!holdings.length) {
    el.innerHTML = '<span style="color:var(--text3);font-size:12px">No holdings yet — add a ticker above</span>';
    return;
  }
  el.innerHTML = holdings.map(h => `
    <div class="port-pill">
      <span class="port-pill-ticker">${h.ticker}</span>
      <span class="port-pill-shares">× ${h.shares}${h.buyin ? ` @ $${h.buyin}` : ''}</span>
      <button class="port-pill-rm" onclick="removeHolding('${h.ticker}')" title="Remove">×</button>
    </div>`).join('');
}

// ── Analysis ──────────────────────────────────────────────────────────────────

async function analyzePortfolio() {
  if (!holdings.length) return;
  const btn     = document.getElementById('analyzeBtn');
  const loading = document.getElementById('portLoading');
  btn.disabled  = true;
  loading.style.display = 'flex';
  try {
    const r    = await fetch('/api/portfolio-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdings, period }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    renderResults(data);
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    loading.style.display = 'none';
  }
}

function renderResults(data) {
  const { historical, allocation, metrics, ticker_returns, analysis } = data;
  document.getElementById('portResults').style.display = 'block';
  renderStats(metrics);
  renderLineChart(historical);
  renderDonut(allocation);
  renderTable(allocation, ticker_returns);
  renderAnalysis(analysis);
  document.getElementById('portResults').scrollIntoView({ behavior: 'smooth' });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function renderStats(m) {
  const fv  = v => v != null ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : '—';
  const fmv = v => v != null ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

  const hasCost = m.total_cost != null;
  const pnlVal  = hasCost ? m.total_pnl : null;
  const pnlPct  = hasCost ? m.total_pnl_pct : null;

  document.getElementById('portStats').innerHTML = `
    <div class="port-stat">
      <div class="port-stat-label">Total Value</div>
      <div class="port-stat-value">${fmv(m.total_value)}</div>
      <div class="port-stat-sub">${hasCost ? 'Cost ' + fmv(m.total_cost) : m.num_stocks + ' position' + (m.num_stocks !== 1 ? 's' : '')}</div>
    </div>
    ${hasCost ? `
    <div class="port-stat">
      <div class="port-stat-label">Unrealized P&L</div>
      <div class="port-stat-value ${pnlVal >= 0 ? 'pos' : 'neg'}">${fmv(pnlVal)}</div>
      <div class="port-stat-sub ${pnlPct >= 0 ? 'pos' : 'neg'}">${fv(pnlPct)} all time</div>
    </div>` : `
    <div class="port-stat">
      <div class="port-stat-label">Portfolio Return</div>
      <div class="port-stat-value ${m.portfolio_return_pct >= 0 ? 'pos' : 'neg'}">${fv(m.portfolio_return_pct)}</div>
      <div class="port-stat-sub">Selected period</div>
    </div>`}
    <div class="port-stat">
      <div class="port-stat-label">vs S&P 500 (Alpha)</div>
      <div class="port-stat-value ${m.alpha >= 0 ? 'pos' : 'neg'}">${fv(m.alpha)}</div>
      <div class="port-stat-sub">SPY ${fv(m.benchmark_return_pct)} this period</div>
    </div>
    <div class="port-stat">
      <div class="port-stat-label">Largest Position</div>
      <div class="port-stat-value" style="font-size:18px">${m.top_stock || '—'}</div>
      <div class="port-stat-sub">${m.top_concentration_pct != null ? m.top_concentration_pct.toFixed(1) + '% of portfolio' : ''}</div>
    </div>`;
}

// ── Line chart ────────────────────────────────────────────────────────────────

function renderLineChart(historical) {
  const ctx     = document.getElementById('lineChart').getContext('2d');
  const labels  = historical.map(d => d.date);
  const portPts = historical.map(d => +((d.portfolio - 100).toFixed(2)));
  const benchPts= historical.map(d => d.benchmark != null ? +((d.benchmark - 100).toFixed(2)) : null);

  if (lineInst) lineInst.destroy();

  lineInst = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Portfolio',
          data: portPts,
          borderColor: '#4f8cff',
          backgroundColor: 'rgba(79,140,255,0.07)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'S&P 500',
          data: benchPts,
          borderColor: '#444',
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#888', font: { size: 11 }, boxWidth: 12, padding: 16 } },
        tooltip: {
          backgroundColor: '#161616',
          borderColor: '#222',
          borderWidth: 1,
          titleColor: '#888',
          bodyColor: '#ccc',
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y >= 0 ? '+' : ''}${ctx.parsed.y.toFixed(2)}%`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#444', maxTicksLimit: 7, maxRotation: 0, font: { size: 11 } },
          grid: { color: '#1a1a1a' },
        },
        y: {
          ticks: {
            color: '#444',
            font: { size: 11 },
            callback: v => `${v >= 0 ? '+' : ''}${v}%`,
          },
          grid: { color: '#1a1a1a' },
        },
      },
    },
  });
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
      datasets: [{
        data: allocation.map(a => a.pct),
        backgroundColor: colors,
        borderColor: '#111',
        borderWidth: 2,
        hoverBorderWidth: 3,
      }],
    },
    options: {
      responsive: false,
      cutout: '64%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161616',
          borderColor: '#222',
          borderWidth: 1,
          bodyColor: '#ccc',
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

// ── Holdings table ────────────────────────────────────────────────────────────

function renderTable(allocation, ticker_returns) {
  const retMap    = {};
  (ticker_returns || []).forEach(r => { retMap[r.ticker] = r.return_pct; });

  const rows      = [...allocation].sort((a, b) => b.pct - a.pct);
  const hasCost   = rows.some(a => a.cost_basis != null);
  const fmtR = r => r != null
    ? `<span class="${r >= 0 ? 'pos' : 'neg'}">${r >= 0 ? '+' : ''}${r.toFixed(1)}%</span>`
    : '—';
  const fmtPnl = (v, pct) => {
    if (v == null) return '—';
    const sign = v >= 0 ? '+' : '';
    return `<span class="${v >= 0 ? 'pos' : 'neg'}">${sign}$${Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} (${sign}${pct.toFixed(1)}%)</span>`;
  };
  const fmtV = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  document.getElementById('holdingsTable').innerHTML = `
    <table class="port-table">
      <thead>
        <tr>
          <th>Ticker</th><th>Shares</th>
          ${hasCost ? '<th>Avg Cost</th>' : ''}
          <th>Price</th><th>Value</th>
          ${hasCost ? '<th>Cost Basis</th><th>Unrealized P&L</th>' : ''}
          <th>Weight</th><th>Return</th><th>Sector</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(a => `
          <tr>
            <td class="col-ticker"><a href="/stock/${a.ticker}">${a.ticker}</a></td>
            <td>${a.shares}</td>
            ${hasCost ? `<td>${a.buyin != null ? '$' + a.buyin.toFixed(2) : '—'}</td>` : ''}
            <td>$${a.price.toFixed(2)}</td>
            <td>${fmtV(a.value)}</td>
            ${hasCost ? `<td>${a.cost_basis != null ? fmtV(a.cost_basis) : '—'}</td><td>${fmtPnl(a.unrealized_pnl, a.unrealized_pnl_pct)}</td>` : ''}
            <td>${a.pct.toFixed(1)}%</td>
            <td>${fmtR(retMap[a.ticker])}</td>
            <td style="color:var(--text3)">${a.sector !== 'Unknown' ? a.sector : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── AI analysis ───────────────────────────────────────────────────────────────

function renderAnalysis(text) {
  document.getElementById('analysisBody').innerHTML = renderMarkdown(text || '*Analysis not available*');
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

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
    let html = '<table><thead>';
    let inBody = false;
    for (const line of lines) {
      if (isSep(line)) { html += '</thead><tbody>'; inBody = true; continue; }
      const tag   = inBody ? 'td' : 'th';
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
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
