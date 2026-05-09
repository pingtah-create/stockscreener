// chat.js — barebone-style AI research chat
// Multi-turn conversation with localStorage persistence, ticker detection,
// and link-out to /stock/<TICKER> pages.

const STORAGE_KEY = 'stockdash_chat_v1';
const MAX_HISTORY = 20; // last N messages sent to backend

const heroEl = document.getElementById('chHero');
const chatEl = document.getElementById('chChat');
const threadEl = document.getElementById('chThread');
const formTop = document.getElementById('chForm');
const formBot = document.getElementById('chFormBottom');
const inputTop = document.getElementById('chInput');
const inputBot = document.getElementById('chInputBottom');
const newChatBtn = document.getElementById('newChatBtn');

let messages = loadHistory();
let pending = false;

if (messages.length) renderThread();

formTop.addEventListener('submit', e => { e.preventDefault(); send(inputTop.value); });
formBot.addEventListener('submit', e => { e.preventDefault(); send(inputBot.value); });
newChatBtn.addEventListener('click', () => {
  if (messages.length && !confirm('Start a new chat? Current conversation will be cleared.')) return;
  messages = [];
  saveHistory();
  threadEl.innerHTML = '';
  chatEl.hidden = true;
  heroEl.hidden = false;
  inputTop.value = '';
  inputTop.focus();
});

document.querySelectorAll('.ch-chip').forEach(b => {
  b.addEventListener('click', () => send(b.dataset.q));
});

// Ctrl+K / Cmd+K → focus the active input
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
  const loadingNode = appendMessage('assistant', '', true);

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(-MAX_HISTORY) }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    const reply = data.reply || '(empty response)';
    messages.push({ role: 'assistant', content: reply, tickers: data.tickers || [] });
    saveHistory();
    loadingNode.remove();
    appendMessage('assistant', reply, false, data.tickers || []);
  } catch (err) {
    loadingNode.remove();
    appendMessage('assistant', `**Error:** ${err.message || err}`, false, [], true);
  } finally {
    pending = false;
    inputBot.focus();
  }
}

function appendMessage(role, text, isLoading = false, tickers = [], isError = false) {
  const row = document.createElement('div');
  row.className = `ch-msg ch-msg-${role}` + (isError ? ' ch-msg-error' : '');

  const bubble = document.createElement('div');
  bubble.className = 'ch-bubble';

  if (isLoading) {
    bubble.innerHTML = `<span class="ch-typing"><span></span><span></span><span></span></span>`;
  } else {
    bubble.innerHTML = renderMarkdown(text);
  }
  row.appendChild(bubble);

  if (role === 'assistant' && tickers && tickers.length) {
    const links = document.createElement('div');
    links.className = 'ch-ticker-links';
    links.innerHTML = tickers.map(t =>
      `<a href="/stock/${encodeURIComponent(t)}" class="ch-ticker-pill">${t} →</a>`
    ).join('');
    row.appendChild(links);
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
    appendMessage(m.role, m.content, false, m.tickers || []);
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

// Tiny markdown renderer — bold, italic, inline code, lists, line breaks, links.
// Intentionally minimal so we don't pull a library.
function renderMarkdown(s) {
  if (!s) return '';
  // Escape HTML first
  let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks ```...```
  out = out.replace(/```([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trim()}</code></pre>`);

  // Inline code `..`
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold **..**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italic *..* (avoid matching ** already replaced)
  out = out.replace(/(^|[^\*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Convert simple bullet lists (lines starting with - or *)
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

  // Paragraphs / line breaks
  out = out.replace(/\n{2,}/g, '</p><p>');
  out = out.replace(/\n/g, '<br>');
  return `<p>${out}</p>`;
}
