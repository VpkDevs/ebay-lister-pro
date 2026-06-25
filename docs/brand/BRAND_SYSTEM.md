# Brand System — eBay Multi-Channel Lister Pro

This document defines the visual design system, color tokens, typography scales, motion patterns, and components style guidelines for the eBay Multi-Channel Lister Pro platform.

---

## 🎨 Color Palette & Tokens

Lister Pro uses a high-end, futuristic **Dark Technical Indigo** theme. It provides high contrast for reseller workflows while looking exceptionally modern and premium.

### CSS Theme Variables

```css
:root {
  /* Backgrounds */
  --bg:         #050810;      /* Near-black deep navy background */
  --bg2:        #0a1120;      /* Slightly lighter overlay background */
  --surface:    #0f1929;      /* Panel / Card background */
  --surface2:   #162036;      /* Hover state / Active item background */

  /* Borders */
  --border:     rgba(255,255,255,0.06);   /* Subtle structural border */
  --border2:    rgba(255,255,255,0.11);   /* Highlight border */

  /* Brand Accents */
  --brand:      #6366f1;      /* Indigo-500 Core brand color */
  --brand2:     #4f46e5;      /* Indigo-600 Secondary brand shade */
  --glow:       rgba(99,102,241,0.30); /* Glow shadow color */
  --light:      #818cf8;      /* Light Indigo-400 for accent text */

  /* Status Colors */
  --cyan:       #22d3ee;      /* Info / Pricing Outliers / WooCommerce */
  --green:      #10b981;      /* Active listings / Shopify / WooCommerce */
  --amber:      #f59e0b;      /* Warnings / Draft status / VeRO check flags */
  --red:        #ef4444;      /* Errors / Exceeded limits / Ended listings */

  /* Text Colors */
  --text:       #f0f4fc;      /* Bright readable off-white */
  --muted:      #94a3b8;      /* Subdued gray-blue */
  --dim:        #475569;      /* Low-priority dark gray */

  /* Motion Transition */
  --r:          0.22s cubic-bezier(.4,0,.2,1);
}
```

---

## ✍️ Typography Stack

The typography system combines the geometric impact of **Syne** for headlines with the clean, highly legible structure of **Inter** for data tables and controls, and **JetBrains Mono** for pricing comp tables, trace auditing, and developer logs.

### Font Stack Definitions

```css
font-family: 'Syne', sans-serif;             /* Display/Header */
font-family: 'Inter', sans-serif;            /* Body/Controls */
font-family: 'JetBrains Mono', monospace;    /* Data/Code/Metrics */
```

### Type Scale

| Class | CSS Styling | Usage |
|---|---|---|
| `.h1` | `font-size: clamp(2.8rem, 6.5vw, 5rem); font-weight: 800; letter-spacing: -0.04em;` | Hero headlines |
| `.h2` | `font-size: clamp(1.9rem, 4vw, 3rem); font-weight: 800; letter-spacing: -0.03em;` | Section headers |
| `.h3` | `font-size: 1.15rem; font-weight: 800;` | Card headers |
| `.lead` | `font-size: clamp(1rem, 1.8vw, 1.2rem); color: var(--muted);` | Subheadlines |
| `.mono` | `font-family: 'JetBrains Mono', monospace;` | SKUs, barcodes, API states |

---

## 🎬 Motion Language

Animations must be purposeful, micro-interactive, and snappy to prevent interface lag.

### CSS Transition Utilities
Use CSS transitions on hover, focus, and state changes to animate scale, background colors, and box-shadow glows.

```css
/* Snappy spring effect for buttons and hover cards */
.btn:hover, .card:hover {
  transform: translateY(-2px);
  transition: all var(--r);
}

/* Primary glow shadow effect on hover */
.btn--primary:hover {
  box-shadow: 0 8px 36px var(--glow);
}
```

---

## 🧱 Component Design Tokens

### Buttons
Standardized button styles for primary actions, outline secondary states, and size modifiers:
- **Primary**: Brand-to-brand2 gradient background with white text.
- **Outline**: Transparent background with border2 outline; transitions to surface on hover.

### Badges
Used for platform channels, status items, and listing states:
- **Shopify**: Badge green background (`rgba(16,185,129,0.12)`)
- **eBay**: Badge brand/indigo background (`rgba(99,102,241,0.14)`)
- **Etsy**: Badge amber background (`rgba(245,158,11,0.12)`)
- **WooCommerce**: Badge cyan background (`rgba(34,211,238,0.10)`)
