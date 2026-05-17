// theme.js — dark/light theme toggle, persisted per-user.
// Applied as early as possible to avoid a flash of the wrong theme.
(function () {
  var KEY = 'stockdash_theme_v1_' + (window.CURRENT_USER || 'default');
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  var theme = (saved === 'light' || saved === 'dark') ? saved : 'dark';
  document.documentElement.dataset.theme = theme;

  function setTheme(t) {
    theme = t;
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch (e) {}
    updateButtons();
    // Notify anything that paints to a canvas (charts) so it can recolor.
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: t } }));
  }
  function updateButtons() {
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.textContent = theme === 'dark' ? '☾' : '☀';
      btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    });
  }
  function wire() {
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      if (btn._wired) return;
      btn._wired = true;
      btn.addEventListener('click', function () {
        setTheme(theme === 'dark' ? 'light' : 'dark');
      });
    });
    updateButtons();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
  window.setStockdashTheme = setTheme;
})();
