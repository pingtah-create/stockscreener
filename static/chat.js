// chat.js — FinBot agentic research chat
// Multi-turn conversation with localStorage persistence, tool-call display,
// rotating loading messages, and link-out to /stock/<TICKER> pages.

const STORAGE_KEY   = `stockdash_chat_v1_${window.CURRENT_USER || 'default'}`;
const SESSIONS_KEY  = `stockdash_sessions_v1_${window.CURRENT_USER || 'default'}`;
const PENDING_KEY   = `stockdash_pendingjob_v1_${window.CURRENT_USER || 'default'}`;
const MAX_HISTORY   = 20;
const currentSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const heroEl     = document.getElementById('chHero');
const chatEl     = document.getElementById('chChat');
const threadEl   = document.getElementById('chThread');
const form       = document.getElementById('chForm');
const input      = document.getElementById('chInput');
const formHero   = document.getElementById('chFormHero');
const inputHero  = document.getElementById('chInputHero');
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
  document.body.classList.add('has-thread');
} else {
  initHero();
}

// ── Recover a chat job that was running when the user navigated away ─────────
(function recoverPendingJob() {
  let pj;
  try { pj = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return; }
  if (!pj || !pj.jobId) return;

  // Stale guard: drop jobs older than 5 minutes.
  if (Date.now() - (pj.ts || 0) > 5 * 60 * 1000) {
    try { localStorage.removeItem(PENDING_KEY); } catch {}
    return;
  }

  // If the last saved message is already this question's user turn with an
  // assistant reply after it, the stream finished — nothing to recover.
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') {
    try { localStorage.removeItem(PENDING_KEY); } catch {}
    return;
  }

  // Show the conversation + a loading state, then poll the server for the job.
  if (messages.length) {
    chatEl.hidden = false; heroEl.hidden = true;
    document.body.classList.add('has-thread');
    renderThread();
  }
  const loadingNode = appendLoading();
  pending = true;

  let tries = 0;
  const poll = async () => {
    tries++;
    try {
      const r = await fetch(`/api/chat/job/${pj.jobId}`);
      const d = await r.json();
      if (d.status === 'done') {
        loadingNode.remove();
        const tickers = d.tickers || [], tools = d.tools_used || [];
        messages.push({ role: 'assistant', content: d.reply, tickers, tools_used: tools });
        saveHistory();
        saveCurrentSession();
        appendMessage('assistant', d.reply, tickers, tools);
        try { localStorage.removeItem(PENDING_KEY); } catch {}
        pending = false;
        return;
      }
      if (d.status === 'error') {
        loadingNode.remove();
        appendMessage('assistant', `**Error:** ${d.error}`, [], [], true);
        try { localStorage.removeItem(PENDING_KEY); } catch {}
        pending = false;
        return;
      }
    } catch {}
    if (tries < 40) {        // ~2 min of polling at 3s
      setTimeout(poll, 3000);
    } else {
      loadingNode.remove();
      appendMessage('assistant', '*Response timed out — please ask again.*', [], [], true);
      try { localStorage.removeItem(PENDING_KEY); } catch {}
      pending = false;
    }
  };
  poll();
})();

// Two forms: hero input (when hero is showing) and bottom input (after chat starts)
form.addEventListener('submit', e => { e.preventDefault(); send(input.value); });
if (formHero) formHero.addEventListener('submit', e => { e.preventDefault(); send(inputHero.value); });

function resetToHero() {
  saveCurrentSession();
  messages = [];
  saveHistory();
  threadEl.innerHTML = '';
  chatEl.hidden  = true;
  heroEl.hidden  = false;
  document.body.classList.remove('has-thread');
  if (inputHero) inputHero.value = '';
  input.value = '';
  if (inputHero) inputHero.focus(); else input.focus();
  initHero();
}

newChatBtn.addEventListener('click', () => {
  if (messages.length && !confirm('Start a new chat? Current conversation will be cleared.')) return;
  resetToHero();
});

// Brand click → return to hero in-place
const brandLink = document.getElementById('chBrandLink');
if (brandLink) {
  brandLink.addEventListener('click', e => {
    e.preventDefault();
    if (messages.length && !confirm('Return to home? Current conversation will be cleared.')) return;
    resetToHero();
  });
}

// Suggestion cards
document.querySelectorAll('.ch-suggest-card').forEach(b => {
  b.addEventListener('click', () => send(b.dataset.q));
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    (heroEl && !heroEl.hidden ? inputHero : input).focus();
  }
});

// ── Time-aware greeting ──────────────────────────────────────────────────────
(function initGreeting() {
  const titleEl = document.getElementById('chGreetTitle');
  const subEl   = document.getElementById('chGreetSub');
  if (!titleEl) return;
  const h = new Date().getHours();
  const user = window.CURRENT_USER ? window.CURRENT_USER.charAt(0).toUpperCase() + window.CURRENT_USER.slice(1) : '';
  let greet;
  if (h < 5)      greet = 'Up late';
  else if (h < 12) greet = 'Good morning';
  else if (h < 18) greet = 'Good afternoon';
  else             greet = 'Good evening';
  titleEl.textContent = user ? `${greet}, ${user}` : greet;
  const subs = [
    "What's on your mind today?",
    "Ready when you are.",
    "Ask anything about the market.",
    "Got a stock to dig into?",
  ];
  if (subEl) subEl.textContent = subs[Math.floor(Math.random() * subs.length)];
})();

// ── History drawer ───────────────────────────────────────────────────────────
(function initHistoryDrawer() {
  const btn    = document.getElementById('historyBtn');
  const drawer = document.getElementById('chHistoryDrawer');
  const scrim  = document.getElementById('chDrawerScrim');
  const close  = document.getElementById('chDrawerClose');
  if (!btn || !drawer || !scrim) return;
  function open()  { drawer.hidden = false; scrim.hidden = false; renderHistory(); }
  function shut()  { drawer.hidden = true;  scrim.hidden = true;  }
  btn.addEventListener('click', open);
  scrim.addEventListener('click', shut);
  close && close.addEventListener('click', shut);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !drawer.hidden) shut(); });
})();

async function send(text, skill = '') {
  text = (text || '').trim();
  if (!text || pending) return;

  if (heroEl && !heroEl.hidden) {
    heroEl.hidden = true;
    chatEl.hidden = false;
    document.body.classList.add('has-thread');
  }

  messages.push({ role: 'user', content: text });
  saveHistory();
  appendMessage('user', text);
  input.value = '';
  if (inputHero) inputHero.value = '';
  input.placeholder = 'Ask a follow-up…';

  pending = true;
  const loadingNode = appendLoading();

  // ── Background job: survives navigation ──────────────────────────────────
  // Fire a parallel keepalive request that runs the agent to completion
  // server-side. If the user navigates away mid-stream the browser keeps THIS
  // request alive; the answer is recovered on the next page load.
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const jobMessages = messages.slice(-MAX_HISTORY);
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      jobId, question: text, messages: jobMessages, ts: Date.now(),
    }));
  } catch {}
  fetch('/api/chat/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, messages: jobMessages, skill }),
    keepalive: true,   // <-- request survives a page navigation
  }).catch(() => {});

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(-MAX_HISTORY), skill }),
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
          // Stream finished cleanly — the background job is no longer needed.
          try { localStorage.removeItem(PENDING_KEY); } catch {}

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
  document.body.classList.add('has-thread');
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
    const hasSep = lines.some(isSep);
    let html = '<div class="ch-table-wrap"><table class="ch-table">';
    let inBody = false;
    let headerOpened = false;
    for (const line of lines) {
      if (isSep(line)) {
        if (headerOpened) html += '</thead>';
        html += '<tbody>';
        inBody = true;
        continue;
      }
      const tag = inBody ? 'td' : 'th';
      if (!inBody && !headerOpened && hasSep) { html += '<thead>'; headerOpened = true; }
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      html += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    }
    if (inBody) html += '</tbody>';
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

// Index tape loads on every page view (independent of hero/chat state)
loadTape();

// ── Market Snapshot ────────────────────────────────────────────────────────────
// Draw a car-speedometer-style Fear & Greed gauge into a container.
function renderFgGauge(container, score, label) {
  score = Math.max(0, Math.min(100, score || 50));
  // SVG: semicircle arc only — needle stays well inside it, score sits below in HTML.
  const W = 160, H = 96, cx = W / 2, cy = 84, r = 62;
  const color = score >= 70 ? 'var(--green)' : score >= 55 ? 'var(--green2)'
              : score >= 45 ? 'var(--yellow)' : score >= 30 ? 'var(--red2)' : 'var(--red)';
  const polar = (deg, rad) => {
    const a = deg * Math.PI / 180;
    return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)];
  };
  const arc = (fromDeg, toDeg, rad) => {
    const [x1, y1] = polar(fromDeg, rad), [x2, y2] = polar(toDeg, rad);
    const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    const sweep = toDeg < fromDeg ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rad} ${rad} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  // 5 colored zones across the 180°→0° arc
  const zones = [
    { from: 180, to: 144, c: 'var(--red)' },
    { from: 144, to: 108, c: 'var(--red2)' },
    { from: 108, to: 72,  c: 'var(--yellow)' },
    { from: 72,  to: 36,  c: 'var(--green2)' },
    { from: 36,  to: 0,   c: 'var(--green)' },
  ];
  const zonePaths = zones.map(z =>
    `<path d="${arc(z.from, z.to, r)}" fill="none" stroke="${z.c}" stroke-width="8" stroke-linecap="butt"/>`
  ).join('');
  // Needle: short, stops short of the arc so it doesn't cover the colors
  const needleDeg = 180 - (score / 100) * 180;
  const [nx, ny] = polar(needleDeg, r - 22);
  return (container.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${zonePaths}
      <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}"
            stroke="var(--text)" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="5" fill="var(--bg2)" stroke="var(--text)" stroke-width="2"/>
    </svg>
    <div class="ch-fg-score" style="color:${color}">${score}</div>
    <div class="ch-fg-label" style="color:${color}">${label || 'Neutral'}</div>
  `);
}

async function loadMarketSnapshot() {
  const timeEl   = document.getElementById('snapshotTime');
  const gaugeEl  = document.getElementById('chFgGauge');
  const volEl    = document.getElementById('chSnapVol');
  const leadEl   = document.getElementById('chSnapLeaders');
  const lagEl    = document.getElementById('chSnapLaggards');
  const narrEl   = document.getElementById('chSnapNarrative');

  // Fear & Greed gauge + Volatility (VIX) + narrative from /api/market-snapshot
  try {
    const r = await fetch('/api/market-snapshot');
    if (r.ok) {
      const d = await r.json();
      if (gaugeEl) renderFgGauge(gaugeEl, d.fg_score, d.fg_label);

      // Volatility cell — VIX level + regime
      if (volEl) {
        const vix = (d.indices || {}).VIX || {};
        const px  = vix.price;
        const chg = vix.change_pct || 0;
        const cls = chg > 0 ? 'neg' : 'pos';   // VIX up = risk-off
        const sign = chg >= 0 ? '+' : '';
        const regime = px == null ? '' : px < 15 ? 'low regime' : px < 25 ? 'normal regime' : 'elevated regime';
        volEl.innerHTML = `
          <div class="ch-snap-label">Volatility</div>
          <div class="ch-snap-big">
            <span class="ch-snap-big-val">${px != null ? px.toFixed(2) : '—'}</span>
            <span class="ch-snap-big-sub ${cls}">${sign}${chg.toFixed(2)}%</span>
          </div>
          <div class="ch-snap-meta">VIX · ${regime}</div>`;
      }
      if (narrEl && d.narrative) {
        narrEl.textContent = d.narrative;
        narrEl.style.display = '';
      }
      if (timeEl) timeEl.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else {
      if (gaugeEl) renderFgGauge(gaugeEl, 50, 'Neutral');
      if (volEl) volEl.innerHTML = '<div class="ch-snap-label">Volatility</div><div class="ch-snap-loading">Unavailable</div>';
    }
  } catch {
    if (gaugeEl) renderFgGauge(gaugeEl, 50, 'Neutral');
    if (volEl) volEl.innerHTML = '<div class="ch-snap-label">Volatility</div><div class="ch-snap-loading">Unavailable</div>';
  }

  // Leaders + Laggards from /api/movers ({chg, symbol, name})
  try {
    const r = await fetch('/api/movers');
    if (!r.ok) throw new Error('failed');
    const m = await r.json();
    const up = m.gainers || [], down = m.losers || [];
    const rowsHtml = arr => arr.slice(0, 3).map(s => {
      const chg = (s.chg != null ? s.chg : s.change_pct) || 0;
      const cls = chg >= 0 ? 'pos' : 'neg';
      const sign = chg >= 0 ? '+' : '';
      return `<div class="ch-snap-row">
        <span class="ch-snap-row-sym">${s.symbol || s.ticker}</span>
        <span class="ch-snap-row-chg ${cls}">${sign}${chg.toFixed(2)}%</span>
      </div>`;
    }).join('');
    if (leadEl) leadEl.innerHTML = `<div class="ch-snap-label">Leaders</div>${rowsHtml(up)}`;
    if (lagEl)  lagEl.innerHTML  = `<div class="ch-snap-label">Laggards</div>${rowsHtml(down)}`;
  } catch {
    if (leadEl) leadEl.innerHTML = '<div class="ch-snap-label">Leaders</div><div class="ch-snap-loading">Unavailable</div>';
    if (lagEl)  lagEl.innerHTML  = '<div class="ch-snap-label">Laggards</div><div class="ch-snap-loading">Unavailable</div>';
  }
}

// ── Index tape ─────────────────────────────────────────────────────────────────
async function loadTape() {
  try {
    const r = await fetch('/api/market-snapshot');
    if (!r.ok) return;
    const d = await r.json();
    const idx = d.indices || {};
    document.querySelectorAll('.ch-tape-cell').forEach(cell => {
      const key = cell.dataset.idx;
      const data = idx[key] || {};
      const chg = data.change_pct || 0;
      const px  = data.price != null ? data.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
      // VIX up = risk-off = red
      const cls = key === 'VIX' ? (chg > 0 ? 'neg' : 'pos') : (chg >= 0 ? 'pos' : 'neg');
      const sign = chg >= 0 ? '+' : '';
      const pxEl  = cell.querySelector('.ch-tape-px');
      const chgEl = cell.querySelector('.ch-tape-chg');
      if (pxEl)  pxEl.textContent = px;
      if (chgEl) { chgEl.textContent = `${sign}${chg.toFixed(2)}%`; chgEl.className = `ch-tape-chg mono ${cls}`; }
    });
    const statusEl = document.getElementById('chTapeStatus');
    const dotEl = document.querySelector('.ch-tape-dot');
    const h = new Date().getUTCHours();   // rough US market-hours check (13:30-20:00 UTC)
    const open = h >= 13 && h < 21;
    if (statusEl) statusEl.textContent = open ? 'Market open' : 'Market closed';
    if (dotEl) dotEl.classList.toggle('closed', !open);
  } catch {}
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
    el.innerHTML = stocks.slice(0, 6).map(s => {
      const chg  = s.change_pct || 0;
      const cls  = chg >= 0 ? 'pos' : 'neg';
      const sign = chg >= 0 ? '+' : '';
      const px   = s.price != null ? '$' + s.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
      return `<a href="/stock/${encodeURIComponent(s.ticker)}" class="ch-trending-item">
        <span class="ch-trending-info">
          <span class="ch-trending-ticker">${s.ticker}</span>
          <span class="ch-trending-name">${s.name || ''}</span>
        </span>
        <span class="ch-trending-right">
          ${px ? `<span class="ch-trending-px">${px}</span>` : ''}
          <span class="ch-trending-chg ${cls}">${sign}${chg.toFixed(1)}%</span>
        </span>
      </a>`;
    }).join('');
  } catch {
    el.innerHTML = '<span style="color:var(--text-faint);font-size:12px">Unavailable</span>';
  }
}

// ── Skill ticker universe ──────────────────────────────────────────────────────
let _skillUniverse = [];
(async () => {
  try {
    const r = await fetch('/api/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: {}, sort_by: 'marketCap', sort_dir: 'desc', page: 1, per_page: 600 }),
    });
    const d = await r.json();
    _skillUniverse = d.results || [];
  } catch {}
})();

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
let _suppressDropdown = false;

function _skillDropdownOpen(q) {
  if (_suppressDropdown) return;
  let dd = document.getElementById('chSkillDropdown');
  if (!dd) return;
  if (!q) { dd.classList.remove('open'); return; }
  // Position using fixed coords so it works regardless of overflow/clipping
  const inp = document.getElementById('chSkillTickerInput');
  if (inp) {
    const r = inp.getBoundingClientRect();
    dd.style.top  = (r.bottom + 4) + 'px';
    dd.style.left = r.left + 'px';
  }
  const found = _skillUniverse.filter(s =>
    s.symbol?.toUpperCase().startsWith(q) ||
    (s.shortName || '').toUpperCase().includes(q)
  ).slice(0, 8);
  if (!found.length) { dd.classList.remove('open'); return; }


  dd.innerHTML = found.map(s => `
    <div class="search-result-item" data-symbol="${s.symbol}">
      <span class="search-ticker">${s.symbol}</span>
      <span class="search-name">${s.shortName || ''}</span>
    </div>`).join('');
  dd.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const tickerEl = document.getElementById('chSkillTickerInput');
      if (tickerEl) {
        _suppressDropdown = true;
        tickerEl.value = el.dataset.symbol;
        tickerEl.focus();
        setTimeout(() => { _suppressDropdown = false; }, 200);
      }
      dd.classList.remove('open');
    });
  });
  dd.classList.add('open');
}

document.querySelectorAll('.ch-skill-card').forEach(card => {
  card.addEventListener('click', () => {
    const skill = card.dataset.skill;
    if (!SKILL_TEMPLATES[skill]) return;

    if (skill === 'market') {
      send(SKILL_TEMPLATES.market(), 'market');
      return;
    }

    document.querySelectorAll('.ch-skill-card').forEach(c => c.classList.remove('ch-skill-active'));
    card.classList.add('ch-skill-active');
    _activeSkill = skill;

    const row         = document.getElementById('chSkillTickerRow');
    const tickerInput = document.getElementById('chSkillTickerInput');
    const label       = document.getElementById('chSkillTickerLabel');
    if (label) label.textContent = SKILL_LABELS[skill] || 'Analyse';
    if (tickerInput) { tickerInput.value = ''; }
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
  const dd  = document.getElementById('chSkillDropdown');
  if (row) row.style.display = 'none';
  if (dd)  dd.classList.remove('open');
  document.querySelectorAll('.ch-skill-card').forEach(c => c.classList.remove('ch-skill-active'));
  const skillToFire = _activeSkill;
  _activeSkill = null;
  send(fn(ticker), skillToFire);
}

document.getElementById('chSkillTickerBtn')?.addEventListener('click', fireSkill);

document.getElementById('chSkillTickerInput')?.addEventListener('input', function() {
  _skillDropdownOpen(this.value.trim().toUpperCase());
});
document.getElementById('chSkillTickerInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { document.getElementById('chSkillDropdown')?.classList.remove('open'); fireSkill(); }
  if (e.key === 'Escape') { document.getElementById('chSkillDropdown')?.classList.remove('open'); }
});
document.addEventListener('click', e => {
  const row = document.getElementById('chSkillTickerRow');
  const dd  = document.getElementById('chSkillDropdown');
  if (row && !row.contains(e.target) && dd && !dd.contains(e.target)) {
    dd.classList.remove('open');
  }
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
