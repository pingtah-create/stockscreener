/* ==============================================================
   Stockdash Landing — JS
   Vanilla, no dependencies. Respects prefers-reduced-motion.
   ============================================================== */

(function () {
  'use strict';

  var DASHBOARD_URL = 'https://stockscreener-nine-zeta.vercel.app';
  var SIGNUP_URL    = DASHBOARD_URL + '/signup';
  var reduceMotion  = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----------------------------------------------------------
     1. Year in footer
     ---------------------------------------------------------- */
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ----------------------------------------------------------
     2. Mobile menu
     ---------------------------------------------------------- */
  var menuBtn  = document.querySelector('.nav__menu');
  var mobileNav = document.getElementById('mobileNav');
  if (menuBtn && mobileNav) {
    menuBtn.addEventListener('click', function () {
      var expanded = menuBtn.getAttribute('aria-expanded') === 'true';
      menuBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      if (expanded) {
        mobileNav.setAttribute('hidden', '');
      } else {
        mobileNav.removeAttribute('hidden');
      }
    });
    // Close menu on link click
    mobileNav.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        menuBtn.setAttribute('aria-expanded', 'false');
        mobileNav.setAttribute('hidden', '');
      });
    });
  }

  /* ----------------------------------------------------------
     3. Simulated price flickers (hero mockup)
     Updates the `data-flicker` numbers every few seconds with
     small random walks so the hero looks alive.
     ---------------------------------------------------------- */
  if (!reduceMotion) {
    var tickers = {
      'nvda-price': { value: 487.62,    prefix: '$', decimals: 2 },
      'nvda-pct':   { value: 2.84,      prefix: '+', decimals: 2, suffix: '%' },
      'spx-price':  { value: 5318.42,   prefix: '',  decimals: 2 },
      'spx-pct':    { value: 0.62,      prefix: '+', decimals: 2, suffix: '%' },
      'ndx-price':  { value: 18712.83,  prefix: '',  decimals: 2 },
      'ndx-pct':    { value: 0.91,      prefix: '+', decimals: 2, suffix: '%' },
      'vix-price':  { value: 13.24,     prefix: '',  decimals: 2 },
      'vix-pct':    { value: -2.10,     prefix: '',  decimals: 2, suffix: '%' },
      't10-price':  { value: 4.21,      prefix: '',  decimals: 2, suffix: '%' },
      't10-pct':    { value: -0.03,     prefix: '',  decimals: 2 }
    };

    function fmt(t, v) {
      var sign = '';
      if (t.prefix === '+' && v < 0) sign = '−';
      else if (t.prefix === '+') sign = '+';
      else if (v < 0) sign = '−';
      var abs = Math.abs(v).toFixed(t.decimals);
      // Add thousands separators for prices
      if (!t.suffix && t.decimals === 0) abs = Number(abs).toLocaleString('en-US');
      else if (!t.suffix) abs = Number(abs).toLocaleString('en-US', { minimumFractionDigits: t.decimals, maximumFractionDigits: t.decimals });
      var prefix = (t.prefix === '+' || t.prefix === '') ? '' : t.prefix;
      return sign + prefix + abs + (t.suffix || '');
    }

    function tick() {
      Object.keys(tickers).forEach(function (key) {
        var t = tickers[key];
        var el = document.querySelector('[data-flicker="' + key + '"]');
        if (!el) return;
        // Random walk — bigger jitter on percentages
        var step = key.indexOf('pct') > -1
          ? (Math.random() - 0.5) * 0.4
          : (Math.random() - 0.5) * (t.value * 0.002);
        var newVal = t.value + step;
        // Keep within a small band of the original
        var orig = t.value;
        if (Math.abs(newVal - orig) > Math.abs(orig * 0.06)) {
          newVal = orig + (Math.random() - 0.5) * Math.abs(orig * 0.01);
        }
        var prevVal = parseFloat(el.dataset.prev || t.value);
        t.value = newVal;
        el.textContent = fmt(t, newVal);
        el.dataset.prev = newVal;
        var cls = newVal >= prevVal ? 'flick' : 'flick--down';
        el.classList.remove('flick', 'flick--down');
        // force reflow to restart animation
        void el.offsetWidth;
        el.classList.add(cls);
      });
    }

    setInterval(tick, 2400);
  }

  /* ----------------------------------------------------------
     4. Reveal-on-scroll
     ---------------------------------------------------------- */
  var revealTargets = document.querySelectorAll(
    '.section__head, .pillar, .step, .chart-mock, .cta-card, .faq__item, .video-frame'
  );
  revealTargets.forEach(function (el) { el.classList.add('reveal'); });

  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealTargets.forEach(function (el) { io.observe(el); });
  } else {
    revealTargets.forEach(function (el) { el.classList.add('is-visible'); });
  }

  /* ----------------------------------------------------------
     5. Signup form → redirect to dashboard /signup with email
     ---------------------------------------------------------- */
  var form    = document.getElementById('signupForm');
  var emailEl = document.getElementById('signupEmail');
  var errEl   = document.getElementById('signupError');
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (form && emailEl && errEl) {
    var clearError = function () {
      errEl.hidden = true;
      errEl.textContent = '';
    };
    emailEl.addEventListener('input', clearError);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var val = emailEl.value.trim();
      if (!val) {
        errEl.textContent = 'Please enter your email address.';
        errEl.hidden = false;
        emailEl.focus();
        return;
      }
      if (!EMAIL_RE.test(val)) {
        errEl.textContent = 'That doesn’t look like a valid email. Try again.';
        errEl.hidden = false;
        emailEl.focus();
        return;
      }
      // Visual loading state on the button
      var btn = form.querySelector('button[type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.75';
        btn.textContent = 'Redirecting…';
      }
      // Redirect with email pre-filled
      var url = SIGNUP_URL + '?email=' + encodeURIComponent(val);
      window.location.href = url;
    });
  }

  /* ----------------------------------------------------------
     6. Video placeholder → click sends to dashboard
        (until the actual video is dropped in)
     ---------------------------------------------------------- */
  var videoBtn = document.querySelector('#videoPlaceholder .video-play');
  if (videoBtn) {
    videoBtn.addEventListener('click', function () {
      window.location.href = DASHBOARD_URL;
    });
  }

  /* ----------------------------------------------------------
     7. Smooth-scroll for in-page anchors
        (native smooth-scroll handles most browsers, but we
        normalise focus management for keyboard users)
     ---------------------------------------------------------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (ev) {
      var id = a.getAttribute('href');
      if (!id || id === '#' || id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      ev.preventDefault();
      target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      // Move focus for screen readers without re-scrolling
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
  });

})();
