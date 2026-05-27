# Stockdash Landing Page

A standalone, dark-mode marketing site that introduces every feature of Stockdash and funnels visitors to the live dashboard at <https://stockscreener-nine-zeta.vercel.app>.

This directory is **fully self-contained**. It has zero dependencies on the Flask app in the parent directory — no Python, no build step, no bundler. Just open `index.html` in a browser.

```
landing/
├── index.html      Full landing page markup
├── styles.css      Design tokens, components, animations
├── script.js       Mobile menu, price flicker, scroll reveals, signup
├── assets/         Drop your video / images here
└── README.md       This file
```

---

## View it locally

```bash
# from the repo root
open landing/index.html
```

Or with any static server:

```bash
cd landing
python3 -m http.server 8080
# then visit http://localhost:8080
```

---

## Adding the Remotion / Hyperframe video

The video slot is in `index.html` inside `<div class="video-frame">` — search for the `REMOTION / HYPERFRAME VIDEO INTEGRATION POINT` comment block.

### Option A — exported MP4/WebM (recommended)

Export your Remotion composition to `landing/assets/product-tour.mp4` (and optionally `.webm`), then replace the entire `<div class="video-placeholder">…</div>` block with:

```html
<video
  class="video"
  controls
  playsinline
  preload="metadata"
  poster="./assets/video-poster.jpg"
>
  <source src="./assets/product-tour.mp4" type="video/mp4" />
  <source src="./assets/product-tour.webm" type="video/webm" />
  Your browser does not support the video tag.
</video>
```

Remotion export command for reference:

```bash
npx remotion render src/ProductTour.tsx ProductTour landing/assets/product-tour.mp4
```

### Option B — Remotion Player (interactive React)

If you want the React `<Player>` from `@remotion/player` instead of a baked MP4, you'll need a small build step. Replace the placeholder with a mount point:

```html
<div id="remotionMount" class="video"></div>
<script type="module" src="./remotion-mount.js"></script>
```

Then in `remotion-mount.js`:

```js
import { Player } from '@remotion/player';
import { ProductTour } from './remotion/ProductTour';
import React from 'react';
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('remotionMount')).render(
  React.createElement(Player, {
    component: ProductTour,
    durationInFrames: 30 * 90,
    fps: 30,
    compositionWidth: 1920,
    compositionHeight: 1080,
    style: { width: '100%', height: '100%' },
    controls: true,
  })
);
```

You'll need to bundle it with Vite, esbuild, or similar.

### Option C — Hyperframe / hosted embed

```html
<iframe
  class="video"
  src="https://hyperframe.app/embed/YOUR_SHARE_ID"
  allow="autoplay; fullscreen; picture-in-picture"
  allowfullscreen
  loading="lazy"
></iframe>
```

---

## Customisation cheatsheet

All design tokens live at the top of `styles.css` under `:root`:

| Token | Purpose | Default |
|-------|---------|---------|
| `--bg` | Page background | `#020617` |
| `--primary` | CTA / positive (green) | `#22C55E` |
| `--tech` | Data / trust (blue) | `#3B82F6` |
| `--gold` | Highlights / premium | `#F59E0B` |
| `--purple` | AI accent | `#8B5CF6` |
| `--pos` / `--neg` | Up/down semantic colors | green / red |
| `--container` | Max content width | `1200px` |

Change `--primary` to rebrand the CTA color across every button.

### Swapping the dashboard URL

Two places to update if you move the dashboard off Vercel:

1. **HTML** — search `index.html` for `stockscreener-nine-zeta.vercel.app` (≈ 8 hits across nav, hero, footer, CTAs).
2. **JS** — top of `script.js`:

   ```js
   var DASHBOARD_URL = 'https://stockscreener-nine-zeta.vercel.app';
   var SIGNUP_URL    = DASHBOARD_URL + '/signup';
   ```

---

## Deploying it

The page is static, so anywhere works.

### Vercel (separate project — recommended)

```bash
cd landing
vercel --prod
```

Vercel will auto-detect it as a static site (no framework). Point your apex domain (e.g. `stockdash.app`) at this project and let the dashboard run on a subdomain (e.g. `app.stockdash.app`).

### Netlify

```bash
cd landing
netlify deploy --prod --dir .
```

### GitHub Pages

Push the contents of `landing/` to a `gh-pages` branch (or use the "deploy from /landing" setting in repository pages).

### Cloudflare Pages

Set build directory = `landing/`, build command = (none), output directory = `landing/`.

---

## Serving from the existing Flask app (optional)

If you'd rather serve the landing page from the same Flask process at a public URL (e.g. `/welcome`), add this to `app.py`:

```python
from flask import send_from_directory
import os

LANDING_DIR = os.path.join(os.path.dirname(__file__), 'landing')

@app.route('/welcome')
def landing_welcome():
    # Public route — no @auth.require_login
    return send_from_directory(LANDING_DIR, 'index.html')

@app.route('/welcome/<path:filename>')
def landing_asset(filename):
    return send_from_directory(LANDING_DIR, filename)
```

Then visit `/welcome`. The page links to the live Vercel dashboard, so it works regardless of where you mount it.

**Caveat**: serving via Flask means it inherits Vercel's serverless cold-start cost. Hosting the landing page separately (Vercel/Netlify static) is faster and cheaper.

---

## What's on the page

| Section | What it shows |
|---------|--------------|
| **Nav** | Sticky, blurred, with primary "Launch dashboard" CTA |
| **Hero** | Headline, sub, dual CTAs, stat strip, trust chips, animated dashboard mockup with live price flicker |
| **Ticker tape** | Pure-CSS scrolling marquee (pauses on hover, disabled by reduced-motion) |
| **Video** | 16:9 frame with placeholder for your Remotion/Hyperframe export |
| **3 pillars** | AI · Markets · Portfolio — high-level positioning |
| **Detailed features** | 25+ feature cards grouped into 5 categories |
| **AI chat preview** | Mock conversation showing the Bull/Bear debate output |
| **Charting preview** | Multi-panel chart mockup with SMA / Bollinger / RSI |
| **Portfolio preview** | KPI strip + holdings table with weight bars |
| **Live widgets** | Fear & Greed gauge · Top movers · Sector heatmap · Trending |
| **How it works** | 4-step onboarding flow |
| **Education grid** | 6 learning cards with category chips |
| **Trust strip** | Security, data sources, disclosure |
| **Signup CTA** | Email input → redirects to dashboard `/signup?email=…` |
| **FAQ** | 7 questions in native `<details>` accordion |
| **Footer** | Brand, product, learn, account columns + legal disclaimer |

---

## Design system

Generated with the **UI/UX Pro Max** skill — `Real-Time / Operations Landing` pattern × `Accessible & Ethical` style × `Financial Dashboard` palette × `IBM Plex Sans` typography.

- WCAG AA contrast pairs throughout
- Keyboard-navigable, visible focus rings (`:focus-visible`)
- All animations respect `prefers-reduced-motion`
- Touch targets ≥ 44 × 44 px
- No emojis — Lucide-style inline SVG icons only
- Responsive breakpoints: 560, 640, 720, 880, 960, 1024 px
- Tabular numerals (JetBrains Mono) for every price and percentage

---

## Browser support

Modern evergreen browsers (Chrome, Safari, Edge, Firefox — last 2 versions). Uses `backdrop-filter`, `color-mix()`, and `aspect-ratio` which are all supported in 2024+. No IE11.
