// chat.js — FinBot agentic research chat
// Multi-turn conversation with localStorage persistence, tool-call display,
// rotating loading messages, and link-out to /stock/<TICKER> pages.

const STORAGE_KEY = 'stockdash_chat_v1';
const MAX_HISTORY = 20;

const heroEl    = document.getElementById('chHero');
const chatEl    = document.getElementById('chChat');
const threadEl  = document.getElementById('chThread');
const formTop   = document.getElementById('chForm');
const formBot   = document.getElementById('chFormBottom');
const inputTop  = document.getElementById('chInput');
const inputBot  = document.getElementById('chInputBottom');
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
};

const LOADING_PHRASES = [
  'Calling tools…',
  'Fetching data…',
  'Analyzing…',
  'Crunching numbers…',
  'Reading the market…',
  'Generating response…',
];

if (messages.length) renderThread();

formTop.addEventListener('submit', e => { e.preventDefault(); send(inputTop.value); });
formBot.addEventListener('submit', e => { e.preventDefault(); send(inputBot.value); });
newChatBtn.addEventListener('click', () => {
  if (messages.length && !confirm('Start a new chat? Current conversation will be cleared.')) return;
  messages = [];
  saveHistory();
  threadEl.innerHTML = '';
  chatEl.hidden  = true;
  heroEl.hidden  = false;
  inputTop.value = '';
  inputTop.focus();
});

document.querySelectorAll('.ch-chip').forEach(b => {
  b.addEventListener('click', () => send(b.dataset.q));
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    (chatEl.hidden ? inputTop : inputBot).focus();
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
  inputTop.value = '';
  inputBot.value = '';

  pending = true;
  const loadingNode = appendLoading();

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(-MAX_HISTORY) }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    const reply = data.reply || '(empty response)';
    messages.push({ role: 'assistant', content: reply, tickers: data.tickers || [], tools_used: data.tools_used || [] });
    saveHistory();
    loadingNode.remove();
    appendMessage('assistant', reply, data.tickers || [], data.tools_used || []);
  } catch (err) {
    loadingNode.remove();
    appendMessage('assistant', `**Error:** ${err.message || err}`, [], [], true);
  } finally {
    pending = false;
    inputBot.focus();
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

function appendMessage(role, text, tickers = [], toolsUsed = [], isError = false) {
  const row    = document.createElement('div');
  row.className = `ch-msg ch-msg-${role}` + (isError ? ' ch-msg-error' : '');

  const bubble  = document.createElement('div');
  bubble.className = 'ch-bubble';
  bubble.innerHTML = renderMarkdown(text);
  row.appendChild(bubble);

  // Ticker pills — link out to chart page
  if (role === 'assistant' && tickers.length) {
    const links = document.createElement('div');
    links.className = 'ch-ticker-links';
    links.innerHTML = tickers.map(t =>
      `<a href="/stock/${encodeURIComponent(t)}" class="ch-ticker-pill">${t} →</a>`
    ).join('');
    row.appendChild(links);
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
    appendMessage(m.role, m.content, m.tickers || [], m.tools_used || []);
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

// Minimal markdown renderer
function renderMarkdown(s) {
  if (!s) return '';
  let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
