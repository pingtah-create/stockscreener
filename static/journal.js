// journal.js

const JNL_KEY = `stockdash_journal_v1_${window.CURRENT_USER || 'default'}`;
let entries    = [];
let filterStatus = 'all';
let editingId  = null;
let universe   = [];

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  loadUniverse();
  await loadEntries();
  setupFilters();
  setupTickerSearch();
  render();
}

async function loadEntries() {
  const local = _localLoad();
  try {
    const r = await fetch('/api/journal');
    if (r.ok) {
      const server = await r.json();
      if (Array.isArray(server) && server.length > 0) {
        entries = server;
        _localSave(entries);
        return;
      }
    }
  } catch {}
  entries = local;
}

async function loadUniverse() {
  try {
    const r = await fetch('/api/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: {}, sort_by: 'marketCap', sort_dir: 'desc', page: 1, per_page: 600 }),
    });
    const d = await r.json();
    universe = d.results || [];
  } catch {}
}

function _localLoad() {
  try { return JSON.parse(localStorage.getItem(JNL_KEY) || '[]'); } catch { return []; }
}
function _localSave(data) {
  try { localStorage.setItem(JNL_KEY, JSON.stringify(data)); } catch {}
}

// ── Filters ───────────────────────────────────────────────────────────────────

function setupFilters() {
  document.getElementById('jnlFilters').addEventListener('click', e => {
    const btn = e.target.closest('.jnl-filter-btn');
    if (!btn) return;
    document.querySelectorAll('.jnl-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterStatus = btn.dataset.status;
    render();
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const filtered = filterStatus === 'all' ? entries : entries.filter(e => e.status === filterStatus);
  const list = document.getElementById('jnlList');
  const empty = document.getElementById('jnlEmpty');

  renderStats();

  if (!filtered.length) {
    empty.style.display = '';
    list.innerHTML = '';
    list.appendChild(empty);
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = filtered.map(e => entryCard(e)).join('');
  list.querySelectorAll('.jnl-card').forEach(card => {
    card.querySelector('.jnl-card-edit')?.addEventListener('click', ev => {
      ev.stopPropagation(); openEntryModal(card.dataset.id);
    });
    card.querySelector('.jnl-card-delete')?.addEventListener('click', ev => {
      ev.stopPropagation(); deleteEntry(card.dataset.id);
    });
    card.querySelector('.jnl-card-body')?.addEventListener('click', () => {
      card.classList.toggle('expanded');
    });
  });
}

function entryCard(e) {
  const pnl    = calcPnl(e);
  const pnlHtml = pnl !== null
    ? `<span class="jnl-pnl ${pnl >= 0 ? 'green' : 'red'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%</span>`
    : '';
  const rr = calcRR(e);
  const rrHtml = rr !== null ? `<span class="jnl-meta-item">R/R ${rr}</span>` : '';
  const statusClass = { Idea: 'idea', Open: 'open', Closed: 'closed' }[e.status] || '';

  return `
  <div class="jnl-card" data-id="${e.id}">
    <div class="jnl-card-body">
      <div class="jnl-card-top">
        <div class="jnl-card-left">
          <a class="jnl-card-ticker" href="/stock/${e.ticker}" onclick="event.stopPropagation()">${e.ticker}</a>
          <span class="jnl-dir ${e.direction === 'Short' ? 'short' : 'long'}">${e.direction}</span>
          <span class="jnl-status ${statusClass}">${e.status}</span>
          ${pnlHtml}
        </div>
        <div class="jnl-card-actions">
          <button class="jnl-card-edit" title="Edit">✎</button>
          <button class="jnl-card-delete" title="Delete">✕</button>
        </div>
      </div>
      <div class="jnl-card-meta">
        ${e.entry_price ? `<span class="jnl-meta-item">Entry $${e.entry_price}</span>` : ''}
        ${e.target      ? `<span class="jnl-meta-item">Target $${e.target}</span>` : ''}
        ${e.stop        ? `<span class="jnl-meta-item">Stop $${e.stop}</span>` : ''}
        ${rrHtml}
        ${e.date_opened ? `<span class="jnl-meta-item">${e.date_opened}</span>` : ''}
        ${e.date_closed ? `<span class="jnl-meta-item">→ ${e.date_closed}</span>` : ''}
      </div>
      ${e.notes ? `<div class="jnl-card-notes">${escHtml(e.notes)}</div>` : ''}
    </div>
  </div>`;
}

function calcPnl(e) {
  if (e.status !== 'Closed' || !e.entry_price || !e.close_price) return null;
  const ep = parseFloat(e.entry_price), cp = parseFloat(e.close_price);
  if (!ep) return null;
  return e.direction === 'Short' ? (ep - cp) / ep * 100 : (cp - ep) / ep * 100;
}

function calcRR(e) {
  if (!e.entry_price || !e.target || !e.stop) return null;
  const ep = parseFloat(e.entry_price), tp = parseFloat(e.target), sp = parseFloat(e.stop);
  const reward = Math.abs(tp - ep), risk = Math.abs(ep - sp);
  if (!risk) return null;
  return (reward / risk).toFixed(1);
}

function renderStats() {
  const closed = entries.filter(e => e.status === 'Closed');
  if (!closed.length) { document.getElementById('jnlStats').style.display = 'none'; return; }
  document.getElementById('jnlStats').style.display = '';
  const pnls  = closed.map(e => calcPnl(e)).filter(v => v !== null);
  const wins  = pnls.filter(v => v > 0).length;
  const losses = pnls.filter(v => v <= 0).length;
  const avg   = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  document.getElementById('statTotal').textContent   = closed.length;
  document.getElementById('statWins').textContent    = wins;
  document.getElementById('statLosses').textContent  = losses;
  document.getElementById('statWinRate').textContent = pnls.length ? `${Math.round(wins / pnls.length * 100)}%` : '—';
  const avgEl = document.getElementById('statAvgPnl');
  avgEl.textContent = pnls.length ? `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%` : '—';
  avgEl.className = `jnl-stat-val ${avg >= 0 ? 'green' : 'red'}`;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openEntryModal(id = null) {
  editingId = id;
  const modal = document.getElementById('jnlModalOverlay');
  document.getElementById('jnlModalTitle').textContent = id ? 'Edit Entry' : 'New Entry';

  // Reset form
  document.getElementById('fTicker').value     = '';
  document.getElementById('fEntry').value      = '';
  document.getElementById('fTarget').value     = '';
  document.getElementById('fStop').value       = '';
  document.getElementById('fClosePrice').value = '';
  document.getElementById('fNotes').value      = '';
  document.getElementById('fDateOpened').value = new Date().toISOString().split('T')[0];
  document.getElementById('fDateClosed').value = '';
  setSegment('fDirection', 'Long');
  setSegment('fStatus', 'Idea');
  toggleClosedFields('Idea');

  if (id) {
    const e = entries.find(x => x.id === id);
    if (e) {
      document.getElementById('fTicker').value     = e.ticker || '';
      document.getElementById('fEntry').value      = e.entry_price || '';
      document.getElementById('fTarget').value     = e.target || '';
      document.getElementById('fStop').value       = e.stop || '';
      document.getElementById('fClosePrice').value = e.close_price || '';
      document.getElementById('fNotes').value      = e.notes || '';
      document.getElementById('fDateOpened').value = e.date_opened || '';
      document.getElementById('fDateClosed').value = e.date_closed || '';
      setSegment('fDirection', e.direction || 'Long');
      setSegment('fStatus', e.status || 'Idea');
      toggleClosedFields(e.status);
    }
  }

  modal.style.display = 'flex';
  document.getElementById('fTicker').focus();
}

function closeEntryModal(e) {
  if (e && e.target !== document.getElementById('jnlModalOverlay')) return;
  document.getElementById('jnlModalOverlay').style.display = 'none';
  document.getElementById('jnlTickerDropdown').classList.remove('open');
  editingId = null;
}

function setSegment(groupId, val) {
  document.querySelectorAll(`#${groupId} .jnl-seg-btn`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === val);
  });
}

function getSegment(groupId) {
  return document.querySelector(`#${groupId} .jnl-seg-btn.active`)?.dataset.val || '';
}

document.getElementById('fDirection')?.querySelectorAll('.jnl-seg-btn').forEach(btn => {
  btn.addEventListener('click', () => setSegment('fDirection', btn.dataset.val));
});

document.getElementById('fStatus')?.querySelectorAll('.jnl-seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setSegment('fStatus', btn.dataset.val);
    toggleClosedFields(btn.dataset.val);
  });
});

function toggleClosedFields(status) {
  const show = status === 'Closed';
  document.getElementById('fClosePriceGroup').style.display = show ? '' : 'none';
  document.getElementById('fDateClosedGroup').style.display = show ? '' : 'none';
}

async function saveEntry() {
  const ticker = document.getElementById('fTicker').value.trim().toUpperCase();
  if (!ticker) { document.getElementById('fTicker').focus(); return; }

  const body = {
    ticker,
    direction:   getSegment('fDirection'),
    status:      getSegment('fStatus'),
    entry_price: document.getElementById('fEntry').value || null,
    target:      document.getElementById('fTarget').value || null,
    stop:        document.getElementById('fStop').value || null,
    close_price: document.getElementById('fClosePrice').value || null,
    notes:       document.getElementById('fNotes').value.trim(),
    date_opened: document.getElementById('fDateOpened').value || null,
    date_closed: document.getElementById('fDateClosed').value || null,
  };

  const btn = document.getElementById('jnlSaveBtn');
  btn.disabled = true;

  try {
    if (editingId) {
      const r = await fetch(`/api/journal/${editingId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const updated = await r.json();
      entries = entries.map(e => e.id === editingId ? updated : e);
    } else {
      const r = await fetch('/api/journal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const created = await r.json();
      entries.unshift(created);
    }
    _localSave(entries);
  } catch (err) {
    alert('Save failed: ' + err.message);
    btn.disabled = false;
    return;
  }
  // The entry is saved — UI updates below must never surface as "Save failed".
  try {
    const overlay = document.getElementById('jnlModalOverlay');
    if (overlay) overlay.style.display = 'none';
    editingId = null;
    render();
  } catch (e) {
    console.error('journal render after save failed:', e);
  }
  btn.disabled = false;
}

async function deleteEntry(id) {
  if (!confirm('Delete this entry?')) return;
  await fetch(`/api/journal/${id}`, { method: 'DELETE' });
  entries = entries.filter(e => e.id !== id);
  _localSave(entries);
  render();
}

// ── Ticker autocomplete ───────────────────────────────────────────────────────

function setupTickerSearch() {
  const input = document.getElementById('fTicker');
  const dd    = document.getElementById('jnlTickerDropdown');
  let debounce;

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim().toUpperCase();
    if (!q) { dd.classList.remove('open'); return; }
    debounce = setTimeout(() => {
      const found = universe.filter(s =>
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
          input.value = el.dataset.symbol;
          dd.classList.remove('open');
        });
      });
      dd.classList.add('open');
    }, 150);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') dd.classList.remove('open');
  });

  document.addEventListener('click', e => {
    if (!input.closest('.jnl-ticker-wrap')?.contains(e.target)) dd.classList.remove('open');
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
