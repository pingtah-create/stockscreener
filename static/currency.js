// currency.js — shared FX utility exposed as window.Currency
(function () {
  'use strict';

  const STORAGE_KEY = 'stockdash_currency_v1';

  const CURRENCIES = [
    { code: 'USD', symbol: '$',   name: 'USD — US Dollar',          decimals: 2 },
    { code: 'EUR', symbol: '€',   name: 'EUR — Euro',               decimals: 2 },
    { code: 'GBP', symbol: '£',   name: 'GBP — British Pound',      decimals: 2 },
    { code: 'JPY', symbol: '¥',   name: 'JPY — Japanese Yen',       decimals: 0 },
    { code: 'TWD', symbol: 'NT$', name: 'TWD — Taiwan Dollar',      decimals: 2 },
    { code: 'CAD', symbol: 'CA$', name: 'CAD — Canadian Dollar',    decimals: 2 },
    { code: 'AUD', symbol: 'A$',  name: 'AUD — Australian Dollar',  decimals: 2 },
    { code: 'CHF', symbol: 'Fr',  name: 'CHF — Swiss Franc',        decimals: 2 },
    { code: 'HKD', symbol: 'HK$', name: 'HKD — Hong Kong Dollar',   decimals: 2 },
    { code: 'SGD', symbol: 'S$',  name: 'SGD — Singapore Dollar',   decimals: 2 },
    { code: 'KRW', symbol: '₩',   name: 'KRW — Korean Won',         decimals: 0 },
  ];

  let _rates = { USD: 1.0 };
  let _fetchedAt = 0;
  let _fetchPromise = null;
  const TTL_MS = 3_600_000;

  function _load() {
    if (_fetchPromise) return _fetchPromise;
    _fetchPromise = fetch('/api/fx-rates')
      .then(r => r.json())
      .then(d => {
        if (d && d.rates) {
          _rates = d.rates;
          _fetchedAt = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => { _fetchPromise = null; });
    return _fetchPromise;
  }

  _load();

  function _ensureFresh() {
    if (Date.now() - _fetchedAt > TTL_MS) _load();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  function getCurrency() {
    return localStorage.getItem(STORAGE_KEY) || 'USD';
  }

  function setCurrency(code) {
    if (!CURRENCIES.find(c => c.code === code)) return;
    localStorage.setItem(STORAGE_KEY, code);
    document.dispatchEvent(new CustomEvent('currencychange', { detail: { code } }));
  }

  function getInfo(code) {
    return CURRENCIES.find(c => c.code === (code || getCurrency())) || CURRENCIES[0];
  }

  function convertFromUSD(amount) {
    if (amount == null || isNaN(amount)) return amount;
    _ensureFresh();
    const code = getCurrency();
    if (code === 'USD') return amount;
    return amount * (_rates[code] || 1);
  }

  function formatPrice(usdAmount) {
    if (usdAmount == null || isNaN(usdAmount)) return '—';
    const info = getInfo();
    const val  = convertFromUSD(usdAmount);
    const dec  = info.decimals;
    const str  = val >= 1000
      ? val.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
      : val.toFixed(dec);
    return info.symbol + str;
  }

  function formatLarge(usdAmount) {
    if (usdAmount == null || isNaN(usdAmount)) return '—';
    const info = getInfo();
    const val  = convertFromUSD(usdAmount);
    const abs  = Math.abs(val);
    if (abs >= 1e12) return info.symbol + (val / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9)  return info.symbol + (val / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6)  return info.symbol + (val / 1e6).toFixed(2) + 'M';
    return info.symbol + val.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  // Auto-init any .currency-select elements on the page
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.currency-select').forEach(sel => {
      sel.value = getCurrency();
      sel.addEventListener('change', () => setCurrency(sel.value));
    });
  });

  window.Currency = { CURRENCIES, getCurrency, setCurrency, getInfo, convertFromUSD, formatPrice, formatLarge };
})();
