// chat.js — FinBot agentic research chat
// Multi-turn conversation with localStorage persistence, tool-call display,
// rotating loading messages, and link-out to /stock/<TICKER> pages.

const STORAGE_KEY  = `stockdash_chat_v1_${window.CURRENT_USER || 'default'}`;
const SESSIONS_KEY = `stockdash_sessions_v1_${window.CURRENT_USER || 'default'}`;
const MAX_HISTORY  = 20;
const currentSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const heroEl    = document.getElementById('chHero');
const chatEl    = document.getElementById('chChat');
const threadEl  = document.getElementById('chThread');
const form      = document.getElementById('chForm');
const input     = document.getElementById('chInput');
const newChatBtn = document.getElementById('newChatBtn');

let messages = loadHistory();
let pending  = false;

const TOOL_LABELS = {
  get_stock_fundamentals:  'Fundamentals',
  get_technical_signals:   'Technicals',
  get_recent_news:         'News',
  get_peer_comparison:     'Competitors',
  get_earnings_info:       'Earnings',
  get_insider_activity:    'Insider Activity',
  get_dividend_info:       'Dividends',
  screen_stocks:           'Screening',
  get_market_overview:     'Market Overview',
  compare_stocks:          'Comparing Stocks',
  get_analyst_consensus:   'Analyst Ratings',
  get_watchlist_analysis:  'Watchlist Analysis',
  get_options_chain:       'Options Chain',
  get_macro_indicators:    'Macro Indicators',
};

const LOADING_PHRASES = [
  'Calling tools…',
  'Fetching data…',
  'Analyzing…',
  'Crunching numbers…',
  'Reading the market…',
  'Generating response…',
];

if (messages.length) {
  renderThread();
} else {
  initHero();
}

form.addEventListener('submit', e => { e.preventDefault(); send(input.value); });
newChatBtn.addEventListener('click', () => {
  if (messages.length && !confirm('Start a new chat? Current conversation will be cleared.')) return;
  saveCurrentSession();
  messages = [];
  saveHistory();
  threadEl.innerHTML = '';
  chatEl.hidden  = true;
  heroEl.hidden  = false;
  input.placeholder = 'Ask about a stock — e.g. Is NVDA overvalued?';
  input.value = '';
  input.focus();
  initHero();
});

document.querySelectorAll('.ch-chip').forEach(b => {
  b.addEventListener('click', () => send(b.dataset.q));
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    input.focus();
  }
});

async function send(text) {
  text = (text || '').trim();
  if (!text || pending) return;

  if (heroEl && !heroEl.hidden) {
    heroEl.hidden = true;
    chatEl.hidden = false;
  }

  messages.push({ role: 'user', content: text });
  saveHistory();
  appendMessage('user', text);
  input.value = '';
  input.placeholder = 'Ask anything…';

  pending = true;
  const loadingNode = appendLoading();

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(-MAX_HISTORY) }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }

    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', fullText = '', msgNode = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();  // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }

        if (evt.type === 'chunk') {
          fullText += evt.text;
          if (!msgNode) {
            loadingNode.remove();
            msgNode = appendStreamingMessage();
          }
          msgNode.querySelector('.ch-bubble').innerHTML = renderMarkdown(fullText);
          threadEl.scrollTop = threadEl.scrollHeight;

        } else if (evt.type === 'done') {
          const tickers = evt.tickers || [], tools = evt.tools_used || [];
          const chartData = evt.chart_data || null;
          messages.push({ role: 'assistant', content: fullText, tickers, tools_used: tools, chart_data: chartData });
          saveHistory();
          saveCurrentSession();
          if (msgNode) finaliseStreamingMessage(msgNode, fullText, tickers, tools, chartData);
          else { loadingNode.remove(); appendMessage('assistant', fullText, tickers, tools, false, chartData); }

        } else if (evt.type === 'error') {
          throw new Error(evt.error);
        }
      }
    }
  } catch (err) {
    loadingNode.remove();
    appendMessage('assistant', `**Error:** ${err.message || err}`, [], [], true);
  } finally {
    pending = false;
    input.focus();
  }
}

function appendLoading() {
  const row    = document.createElement('div');
  row.className = 'ch-msg ch-msg-assistant';
  const bubble  = document.createElement('div');
  bubble.className = 'ch-bubble ch-bubble-loading';

  let phraseIdx = 0;
  const label = document.createElement('span');
  label.className = 'ch-loading-text';
  label.textContent = LOADING_PHRASES[0];

  bubble.innerHTML = `<span class="ch-typing"><span></span><span></span><span></span></span> `;
  bubble.appendChild(label);
  row.appendChild(bubble);
  threadEl.appendChild(row);
  threadEl.scrollTop = threadEl.scrollHeight;

  // Rotate through loading phrases
  const timer = setInterval(() => {
    phraseIdx = (phraseIdx + 1) % LOADING_PHRASES.length;
    label.textContent = LOADING_PHRASES[phraseIdx];
  }, 2000);
  row._clearTimer = () => clearInterval(timer);

  const origRemove = row.remove.bind(row);
  row.remove = () => { row._clearTimer(); origRemove(); };
  return row;
}

function appendStreamingMessage() {
  const row = document.createElement('div');
  row.className = 'ch-msg ch-msg-assistant';
  const bubble = document.createElement('div');
  bubble.className = 'ch-bubble ch-bubble-streaming';
  row.appendChild(bubble);
  threadEl.appendChild(row);
  return row;
}

function finaliseStreamingMessage(row, text, tickers, toolsUsed, chartData) {
  const bubble = row.querySelector('.ch-bubble');
  bubble.classList.remove('ch-bubble-streaming');
  bubble.innerHTML = renderMarkdown(text);
  colorTableCells(bubble);
  if (chartData && chartData.type === 'sector' && chartData.data) {
    row.appendChild(renderSectorChart(chartData.data));
  }
  if (tickers.length) {
    const pills = document.createElement('div');
    pills.className = 'ch-tickers';
    tickers.forEach(t => {
      const a = document.createElement('a');
      a.className = 'ch-ticker-pill';
      a.href = `/stock/${t}`;
      a.textContent = t;
      pills.appendChild(a);
    });
    row.appendChild(pills);
  }
  if (toolsUsed.length) {
    const tools = document.createElement('div');
    tools.className = 'ch-tools';
    tools.textContent = `Tools: ${toolsUsed.join(', ')}`;
    row.appendChild(tools);
  }
  threadEl.scrollTop = threadEl.scrollHeight;
}

function appendMessage(role, text, tickers = [], toolsUsed = [], isError = false, chartData = null) {
  const row    = document.createElement('div');
  row.className = `ch-msg ch-msg-${role}` + (isError ? ' ch-msg-error' : '');

  const bubble  = document.createElement('div');
  bubble.className = 'ch-bubble';
  bubble.innerHTML = renderMarkdown(text);
  row.appendChild(bubble);

  // Color-code % cells in tables
  colorTableCells(bubble);

  // Sector bar chart
  if (chartData && chartData.type === 'sector' && chartData.data) {
    row.appendChild(renderSectorChart(chartData.data));
  }

  // Ticker sparkline cards
  if (role === 'assistant' && tickers.length) {
    const linksEl = document.createElement('div');
    linksEl.className = 'ch-ticker-links';
    linksEl.innerHTML = tickers.map(t =>
      `<a href="/stock/${encodeURIComponent(t)}" class="ch-ticker-pill">${t} →</a>`
    ).join('');
    row.appendChild(linksEl);
    // Async upgrade: replace pills with sparkline cards
    upgradeToSparklineCards(tickers, linksEl);
  }

  // Tools-used footer
  if (role === 'assistant' && toolsUsed.length) {
    const unique = [...new Set(toolsUsed)];
    const footer = document.createElement('div');
    footer.className = 'ch-tools-used';
    footer.innerHTML = '🔧 ' + unique.map(t =>
      `<span class="ch-tool-pill">${TOOL_LABELS[t] || t}</span>`
    ).join('');
    row.appendChild(footer);
  }

  threadEl.appendChild(row);
  threadEl.scrollTop = threadEl.scrollHeight;
  return row;
}

function renderThread() {
  heroEl.hidden = true;
  chatEl.hidden = false;
  threadEl.innerHTML = '';
  for (const m of messages) {
    appendMessage(m.role, m.content, m.tickers || [], m.tools_used || [], false, m.chart_data || null);
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveHistory() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_HISTORY * 2))); }
  catch {}
}

// ── Visual helpers ────────────────────────────────────────────────────────────

function colorTableCells(el) {
  el.querySelectorAll('.ch-table td').forEach(td => {
    const text = td.textContent.trim();
    const m = text.match(/^([+-]?\d+\.?\d*)%$/);
    if (!m) return;
    const v = parseFloat(m[1]);
    if (v > 0.1)  td.classList.add('ch-cell-pos');
    else if (v < -0.1) td.classList.add('ch-cell-neg');
  });
}

function sparklineSVG(prices, w = 88, h = 30) {
  if (!prices || prices.length < 2) return '';
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * w;
    const y = h - 2 - ((p - min) / range) * (h - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const color = prices[prices.length - 1] >= prices[0] ? '#3d9e6e' : '#b84444';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="${pts}" stroke="${color}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

async function upgradeToSparklineCards(tickers, linksEl) {
  for (const ticker of tickers) {
    try {
      const r = await fetch(`/api/sparkline/${encodeURIComponent(ticker)}`);
      if (!r.ok) continue;
      const data = await r.json();
      const prices = data.prices || [];
      if (prices.length < 2) continue;

      const chg = (prices[prices.length - 1] - prices[0]) / prices[0] * 100;
      const chgStr = `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`;
      const isUp = chg >= 0;

      const pill = [...linksEl.querySelectorAll('.ch-ticker-pill')]
        .find(p => p.textContent.startsWith(ticker));
      if (!pill) continue;

      const card = document.createElement('a');
      card.href = `/stock/${encodeURIComponent(ticker)}`;
      card.className = 'ch-ticker-card';
      card.innerHTML =
        `<span class="ch-tc-name">${ticker}</span>` +
        `<span class="ch-tc-spark">${sparklineSVG(prices)}</span>` +
        `<span class="ch-tc-chg ${isUp ? 'pos' : 'neg'}">${chgStr}</span>`;
      pill.replaceWith(card);
    } catch {}
  }
}

function renderSectorChart(data) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const maxAbs  = Math.max(...entries.map(([, v]) => Math.abs(v)), 0.1);
  const wrap = document.createElement('div');
  wrap.className = 'ch-sector-chart';
  wrap.innerHTML = '<div class="ch-sc-title">Sector Performance</div>' +
    entries.map(([sec, val]) => {
      const isPos = val >= 0;
      const barPct = Math.abs(val) / maxAbs * 100;
      const valStr = `${isPos ? '+' : ''}${val.toFixed(2)}%`;
      return `<div class="ch-sc-row">
        <span class="ch-sc-label">${sec}</span>
        <div class="ch-sc-track"><div class="ch-sc-bar ${isPos ? 'pos' : 'neg'}" style="width:${barPct.toFixed(1)}%"></div></div>
        <span class="ch-sc-val ${isPos ? 'pos' : 'neg'}">${valStr}</span>
      </div>`;
    }).join('');
  return wrap;
}

// ── Minimal markdown renderer ─────────────────────────────────────────────────
function renderMarkdown(s) {
  if (!s) return '';
  let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Horizontal rules (must come before header processing)
  out = out.replace(/^---$/gm, '<hr class="ch-hr">');

  // Headers
  out = out.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  out = out.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  out = out.replace(/^# (.+)$/gm,   '<h1>$1</h1>');

  // Code blocks
  out = out.replace(/```([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trim()}</code></pre>`);

  // Inline code
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold & italic
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^\*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // Colour verdict keywords
  out = out.replace(/<strong>(BULLISH|BEARISH|NEUTRAL)<\/strong>/g, (_, v) => {
    const cls = v === 'BULLISH' ? 'ch-bull' : v === 'BEARISH' ? 'ch-bear' : 'ch-neutral';
    return `<strong class="${cls}">${v}</strong>`;
  });

  // Links
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Bullet lists
  out = out.replace(/(^|\n)((?:[ \t]*[-*][ \t]+.+(?:\n|$))+)/g, (_, lead, block) => {
    const items = block.trim().split(/\n/).map(l =>
      `<li>${l.replace(/^[ \t]*[-*][ \t]+/, '')}</li>`).join('');
    return `${lead}<ul>${items}</ul>`;
  });

  // Numbered lists
  out = out.replace(/(^|\n)((?:[ \t]*\d+\.[ \t]+.+(?:\n|$))+)/g, (_, lead, block) => {
    const items = block.trim().split(/\n/).map(l =>
      `<li>${l.replace(/^[ \t]*\d+\.[ \t]+/, '')}</li>`).join('');
    return `${lead}<ol>${items}</ol>`;
  });

  // Tables  |col|col|
  out = out.replace(/((?:^|\n)\|.+\|(?:\n\|[-| :]+\|)?(?:\n\|.+\|)*)/g, block => {
    const lines = block.trim().split('\n').filter(l => l.trim().startsWith('|'));
    if (lines.length < 2) return block;
    const isSep = l => /^\|[-| :]+\|$/.test(l.trim());
    let html = '<div class="ch-table-wrap"><table class="ch-table">';
    let inBody = false;
    for (const line of lines) {
      if (isSep(line)) { html += '<tbody>'; inBody = true; continue; }
      const tag  = inBody ? 'td' : 'th';
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      html += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      if (!inBody && lines.some(isSep)) { html += '</thead>'; }
    }
    html += '</table></div>';
    return html;
  });

  out = out.replace(/\n{2,}/g, '</p><p>');
  out = out.replace(/\n/g, '<br>');
  return `<p>${out}</p>`;
}

// ── Hero init ──────────────────────────────────────────────────────────────────
function initHero() {
  loadMarketSnapshot();
  loadTrending();
  renderHistory();
}

// ── Market Snapshot ────────────────────────────────────────────────────────────
async function loadMarketSnapshot() {
  const body   = document.getElementById('snapshotBody');
  const timeEl = document.getElementById('snapshotTime');
  if (!body) return;
  try {
    const r = await fetch('/api/market-snapshot');
    if (!r.ok) throw new Error('failed');
    const d = await r.json();

    // indices is a dict: { VIX: {price, change_pct}, SP500: {...}, NASDAQ: {...} }
    const LABELS = { SP500: 'S&P 500', NASDAQ: 'NASDAQ', VIX: 'VIX' };
    const idxOrder = ['SP500', 'NASDAQ', 'VIX'];
    const colsHtml = idxOrder.map(key => {
      const idx  = (d.indices || {})[key] || {};
      const chg  = idx.change_pct || 0;
      const cls  = key === 'VIX' ? (chg > 0 ? 'neg' : 'pos') : (chg >= 0 ? 'pos' : 'neg');
      const sign = chg >= 0 ? '+' : '';
      const price = idx.price != null
        ? idx.price.toLocaleString('en-US', { maximumFractionDigits: 2 })
        : '—';
      return `<div class="ch-snap-col">
        <span class="ch-snap-col-label">${LABELS[key] || key}</span>
        <span class="ch-snap-col-val">${price}</span>
        <span class="ch-snap-col-chg ${cls}">${sign}${chg.toFixed(2)}%</span>
      </div>`;
    }).join('');

    // Fear & Greed as 4th column
    const fgScore = d.fg_score != null ? d.fg_score : 50;
    const fgLabel = d.fg_label || 'Neutral';
    const fgCls   = fgScore >= 60 ? 'pos' : fgScore <= 40 ? 'neg' : 'neu';
    const fgCol = `<div class="ch-snap-col">
      <span class="ch-snap-col-label">Fear &amp; Greed</span>
      <span class="ch-snap-col-val ${fgCls}">${fgScore}</span>
      <span class="ch-snap-col-chg ${fgCls}">${fgLabel}</span>
    </div>`;

    body.innerHTML = `
      <div class="ch-snap-cols">${colsHtml}${fgCol}</div>
      ${d.narrative ? `<div class="ch-snap-narrative">${d.narrative}</div>` : ''}
    `;

    if (timeEl) {
      const now = new Date();
      timeEl.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
  } catch {
    body.innerHTML = '<span class="ch-snapshot-loading-text">Market data unavailable</span>';
  }
}

// ── Trending ───────────────────────────────────────────────────────────────────
async function loadTrending() {
  const el = document.getElementById('chTrending');
  if (!el) return;
  try {
    const r = await fetch('/api/trending');
    if (!r.ok) throw new Error('failed');
    // trending returns an array directly
    const stocks = await r.json();
    if (!Array.isArray(stocks) || !stocks.length) {
      el.innerHTML = '<span style="color:var(--text-faint);font-size:12px">No data</span>';
      return;
    }
    el.innerHTML = stocks.map(s => {
      const chg  = s.change_pct || 0;
      const cls  = chg >= 0 ? 'pos' : 'neg';
      const sign = chg >= 0 ? '+' : '';
      return `<a href="/stock/${encodeURIComponent(s.ticker)}" class="ch-trending-item">
        <span class="ch-trending-ticker">${s.ticker}</span>
        <span class="ch-trending-name">${s.name || ''}</span>
        <span class="ch-trending-chg ${cls}">${sign}${chg.toFixed(1)}%</span>
      </a>`;
    }).join('');
  } catch {
    el.innerHTML = '<span style="color:var(--text-faint);font-size:12px">Unavailable</span>';
  }
}

// ── Skills ─────────────────────────────────────────────────────────────────────
const SKILL_TEMPLATES = {
  fundamentals: t => `Is ${t} a great company to own long-term?`,
  timing:       t => `What are the best entry and exit levels for ${t} right now?`,
  swing:        t => `Give me a swing trade setup for ${t} with entry, target, and stop-loss.`,
  earnings:     t => `Preview the next earnings for ${t} — estimates, beat rate, and what to watch.`,
  compare:      t => `Compare ${t} vs its closest peers on valuation, growth, and momentum.`,
  market:       () => `Give me a market overview: what's driving markets today and where the opportunities are.`,
};

const SKILL_LABELS = {
  fundamentals: 'Analyse',
  timing:       'Analyse',
  swing:        'Analyse',
  earnings:     'Analyse',
  compare:      'Compare',
};

let _activeSkill = null;

document.querySelectorAll('.ch-skill-card').forEach(card => {
  card.addEventListener('click', () => {
    const skill = card.dataset.skill;
    if (!SKILL_TEMPLATES[skill]) return;

    if (skill === 'market') {
      send(SKILL_TEMPLATES.market());
      return;
    }

    document.querySelectorAll('.ch-skill-card').forEach(c => c.classList.remove('ch-skill-active'));
    card.classList.add('ch-skill-active');
    _activeSkill = skill;

    // Show ticker row below the skill grid
    const row        = document.getElementById('chSkillTickerRow');
    const tickerInput = document.getElementById('chSkillTickerInput');
    const label      = document.getElementById('chSkillTickerLabel');
    if (label) label.textContent = SKILL_LABELS[skill] || 'Analyse';
    if (tickerInput) tickerInput.value = '';
    if (row) { row.style.display = 'flex'; row.style.visibility = 'visible'; }
    if (tickerInput) tickerInput.focus();
  });
});

function fireSkill() {
  const tickerEl = document.getElementById('chSkillTickerInput');
  if (!tickerEl || !_activeSkill) return;
  const ticker = tickerEl.value.trim().toUpperCase();
  if (!ticker) { tickerEl.focus(); return; }
  const fn = SKILL_TEMPLATES[_activeSkill];
  if (!fn) return;
  const row = document.getElementById('chSkillTickerRow');
  if (row) row.style.display = 'none';
  document.querySelectorAll('.ch-skill-card').forEach(c => c.classList.remove('ch-skill-active'));
  _activeSkill = null;
  send(fn(ticker));
}

document.getElementById('chSkillTickerBtn')?.addEventListener('click', fireSkill);
document.getElementById('chSkillTickerInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') fireSkill();
});

// ── History ────────────────────────────────────────────────────────────────────
function getSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveSessions(sessions) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 30))); } catch {}
}

function saveCurrentSession() {
  if (!messages.length) return;
  const first = messages.find(m => m.role === 'user');
  const sessions = getSessions().filter(s => s.id !== currentSessionId);
  sessions.unshift({
    id: currentSessionId,
    title: first ? first.content.slice(0, 60) : 'Untitled',
    ts: Date.now(),
    messages: messages.slice(-MAX_HISTORY * 2),
  });
  saveSessions(sessions);
}

function renderHistory() {
  const sidebar  = document.getElementById('chSidebarHistory');
  const sessions = getSessions();
  if (!sidebar) return;
  if (!sessions.length) {
    sidebar.innerHTML = '<span style="font-size:11px;color:var(--text-faint);padding:4px 10px">No history yet</span>';
    return;
  }
  sidebar.innerHTML = sessions.map(s => {
    const dateStr = new Date(s.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `<button class="ch-sidebar-session" data-id="${s.id}" title="${escHtml(s.title)} · ${dateStr}">${escHtml(s.title)}</button>`;
  }).join('');
  sidebar.querySelectorAll('.ch-sidebar-session').forEach(btn => {
    btn.addEventListener('click', () => loadSession(btn.dataset.id));
  });
}

function loadSession(id) {
  const s = getSessions().find(x => x.id === id);
  if (!s) return;
  messages = s.messages || [];
  saveHistory();
  renderThread();
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
