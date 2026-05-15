# Onboarding Module

## Overview

Guided product tour for new users, powered by [Driver.js v1.4.0](https://driverjs.com/). Walks users through all four pages (Chat, Dashboard, Stock Chart, Portfolio) in sequence, highlighting key UI elements with annotated popovers.

## Files

| File | Purpose |
|------|---------|
| `static/onboarding.js` | Tour logic — step definitions, multi-page flow, localStorage state |
| `static/onboarding.css` | Dark theme overrides for Driver.js popovers + `?` help button style |
| `templates/chat.html` | Driver.js CDN links + `tourHelpBtn` in nav |
| `templates/dashboard.html` | Driver.js CDN links + `tourHelpBtn` in nav + `CURRENT_USER` injection |
| `templates/portfolio.html` | Driver.js CDN links + `tourHelpBtn` in nav |
| `templates/stock.html` | Driver.js CDN links + `tourHelpBtn` in nav + `CURRENT_USER` injection |

## Dependencies

- **Driver.js v1.4.0** — loaded via CDN (`cdn.jsdelivr.net`) in every template. Both CSS and IIFE JS bundle.
- **`window.CURRENT_USER`** — injected by each template; used as part of the localStorage key.

## Architecture

### Page detection

`page()` maps `window.location.pathname` to one of four page IDs:

| Path | Page ID |
|------|---------|
| `/` | `chat` |
| `/dashboard` | `dashboard` |
| `/stock/*` | `stock` |
| `/portfolio` | `portfolio` |

### Step definitions (`STEPS`)

Each page has an array of Driver.js step objects. Steps reference DOM elements by CSS selector (`element` key). Steps without an `element` render as centered modal popovers (used for intro/outro).

| Page | Step count | Notable targets |
|------|-----------|-----------------|
| `chat` | 6 | `#chSnapshot`, `.ch-skills-grid`, `#chTrending`, `#chInput`, `#historyBtn` |
| `dashboard` | 8 | `.db-indices`, `#marketStatus`, `#stockMap`, `#stockmapSector`, `#searchInput`, `#dbSidebar`, `#watchlistAddBtn` |
| `stock` | 13 | `.stock-header`, `#watchStar`, `#alertBell`, `.period-btns`, `.chart-type-btns`, `.ind-btns`, `#autoTaBtn`, `#patternBtn`, `#drawToggleBtn`, `.compare-wrap`, `.osc-controls`, `.sidebar-tabs` |
| `portfolio` | 7 | `.port-perf-card`, `.port-period-btns`, `.port-holdings-card`, `#addToggleBtn`, `#analyzeBtn` |

### Multi-page flow

The tour spans pages in order: `chat → dashboard → stock/AAPL → portfolio`.

**State machine** (stored in `localStorage` key `stockdash_onboarding_v2_<username>`):

| State value | Meaning |
|-------------|---------|
| `""` (empty) | New user — auto-start on `/` (chat page) |
| `"dashboard"` | Chat tour done — auto-start on `/dashboard` |
| `"stock"` | Dashboard tour done — auto-start on `/stock/*` |
| `"portfolio"` | Stock tour done — auto-start on `/portfolio` |
| `"complete"` | All tours finished — never auto-start |

When a page tour finishes, `onFinish` sets the next page ID in localStorage and navigates via `window.location.href` using `NEXT_URL`:

```
chat      → /dashboard
dashboard → /stock/AAPL
stock     → /portfolio
portfolio → (done, state = "complete")
```

### Visibility filtering

`filterVisible(steps)` removes steps whose `element` selector doesn't match a visible DOM node (`el.offsetParent !== null`). This prevents the tour from breaking if a UI section is hidden or not yet rendered.

### Manual replay

Every page has a `?` button (`#tourHelpBtn`) in the nav bar. Clicking it replays the current page's tour without affecting the multi-page flow state.

### Auto-start timing

Auto-start tours fire after a 1500ms `setTimeout` to allow the page to fully render (data fetches, DOM hydration).

## Driver.js configuration

```
showProgress: true
animate: true
stagePadding: 10
stageRadius: 10
popoverOffset: 14
smoothScroll: true
overlayOpacity: 0.75
progressText: "{{current}} / {{total}}"
```

## Styling

Custom dark theme in `onboarding.css`:

- Popover: `#1a1a1a` background, `12px` border radius, `360px` max width
- Active element: white outline + blue glow (`rgba(79,140,255,0.3)`)
- Overlay: `rgba(0,0,0,0.4)` — keeps page content partially visible
- Buttons: transparent "Back", blue `#4f8cff` "Next"/"Done"
- Help button (`?`): 26px circle, `#333` border, hover turns blue

## localStorage keys

| Key | Value |
|-----|-------|
| `stockdash_onboarding_v2_<username>` | Flow state: `""`, `"dashboard"`, `"stock"`, `"portfolio"`, or `"complete"` |

## Adding steps to a page

1. Add a new object to the relevant array in `STEPS.<page>`:
   ```js
   { element: '#myNewElement', popover: { title: '...', description: '...', side: 'bottom', align: 'center' } }
   ```
2. Ensure the target element has a stable `id` or class selector.
3. Steps without an `element` key render as centered modals.

## Adding a new page to the flow

1. Add the page ID to `FLOW` array.
2. Add a `STEPS.<pageId>` array with step definitions.
3. Add `page()` detection for the new pathname.
4. Add an entry in `NEXT_URL` pointing to the next page's URL.
5. Include Driver.js CDN links, `onboarding.css`, `onboarding.js`, and `#tourHelpBtn` in the new template.
