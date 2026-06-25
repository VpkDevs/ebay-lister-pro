# Launch Scripts — eBay Multi-Channel Lister Pro

This document contains copy-paste launch scripts ordered sequentially by launch day execution time.

---

## 1. Product Hunt Launch (02:01 CT / 00:01 PST)
- **Destination**: [Product Hunt Submit](https://www.producthunt.com/posts/new)
- **Tagline**: Zero-dependency multichannel eBay, Shopify & Etsy lister.
- **Description**: Spruce product images, lookup comp pricing using Gemini Vision AI, protect against double-selling, and cross-list to eBay, Shopify, WooCommerce, and Etsy in 90 seconds. 100% zero external npm dependencies.
- **Topics**: Reselling, E-Commerce, Developer Tools, Productivity

---

## 2. Maker's First Comment (02:05 CT)
- **Destination**: Product Hunt Post comment section
- **Text to copy**:
  ```markdown
  Hi Hunters! 👋

  Vincent Kinney here, creator of eBay Multi-Channel Lister Pro.

  If you’ve ever sold inventory online, you know that cross-listing across platforms is painful. Existing SaaS tools charge $50+/month, lag on inventory synchronization, and bloat your browser.

  I built Lister Pro to solve this cleanly:
  - ⚡ 100% Zero-Dependency: Built entirely using native Node.js core modules. No npm bloat. Starts instantly.
  - 👁️ Gemini Vision: Snap a photo, and the AI automatically detects defects, extracts aspects, and pulls live eBay comp metrics.
  - 🔄 Concurrent Sync: Publishes to eBay, Shopify, WooCommerce, and Etsy simultaneously with automatic Dead-Letter Queue (DLQ) retry and circuit breakers.
  - 🔒 Local-First: Your history and credentials remain on your machine.

  The codebase is open and self-hostable. A premium tier is available if you want managed updates.

  I'd love to hear your feedback on the image watermarking and the pricing comp calculations!

  Happy flippin'! 🚀
  ```

---

## 3. Twitter/X Launch Thread (06:00 CT)
- **Destination**: [Twitter/X Compose](https://x.com/compose)
- **Text to copy (First Tweet)**:
  ```text
  I got tired of paying $50/month for cross-listing apps that lag and bloat my machine.

  So, I spent the last few weeks building my own: a 100% zero-dependency, local-first lister that posts to eBay, Shopify, WooCommerce & Etsy in 90 seconds.

  Here's the story of how I did it: 🧵👇
  ```
- **Note**: Compose subsequent tweets in the thread using the assets in [Twitter Thread Assets](file:///c:/Users/MQ420_OL/DEV/ebay-lister-pro/docs/founder/launch_assets/twitter_thread.md).

---

## 4. Hacker News Show HN Submission (09:00 CT)
- **Destination**: [Hacker News Submit](https://news.ycombinator.com/submit)
- **Title**: `Show HN: A zero-dependency multi-channel eBay lister written in raw Node.js`
- **Text to copy (Body)**:
  ```markdown
  Hello HN,

  I wanted to share a project I've been building: a multi-channel inventory lister and reseller tool.

  What makes it unique is that it is built entirely using native Node.js core APIs (http, fs, crypto, child_process) and vanilla HTML/CSS/JS. It has 100% zero external dependencies—no Express, no database drivers, no UI frameworks, no npm packages.

  ### Why zero dependencies?
  I got tired of the package inflation in modern JavaScript. I wanted to see if I could write a production-grade SaaS tool (with CORS, token rate limiters, session auth, file locks, concurrent cross-posting HTTP queues, and image resizing) using only what Node.js provides out of the box. The entire app fits in under 10 files and boots in under 10ms.

  ### Key Technical Aspects:
  - Native Sliding Window Rate Limiter: Built using standard JavaScript Maps tracking token decay.
  - Self-Healing File Database: Enforces custom reader/writer locks on JSON files. If database corruption is detected, it auto-restores from the `.bak` replica.
  - Concurrent Cross-Posting: Uses Promise.allSettled and a file-backed Dead-Letter Queue (DLQ) to retry failed Shopify/Etsy API syncs.
  - Native Image Editing: Uses PowerShell GDI+ scripts spawned via child_process to watermark, crop, and resize images locally on Windows.

  I’ve open-sourced the project and it can be run locally with a single command: `node start.js`.

  Would love to get your thoughts on the custom file-locking database model and how to improve the GDI+ script performance!
  ```

---

## 5. Reddit r/flipping Submission (10:00 CT)
- **Destination**: [r/flipping Submit](https://www.reddit.com/r/flipping/submit)
- **Title**: `I got tired of paying $50/mo for cross-listing software, so I built a zero-dependency local lister`
- **Text to copy (Body)**:
  ```markdown
  Hey everyone,

  I’ve been flipping on eBay and Shopify for a couple of years. One of my biggest pain points has always been cross-listing. It takes forever, and the popular apps (like Vendoo or Crosslist) charge a hefty monthly subscription that cuts straight into my profit margins.

  So, I decided to build my own local lister. I had a few rules:
  1. It had to be 100% free and self-hostable.
  2. It had to be zero-dependency (so no weird node_modules folders or vulnerabilities).
  3. It had to be fast.

  ### What it does:
  - Image sprucing: Automatically crops, squares, and watermarks your photos natively.
  - Gemini Vision: Uses Google's AI to look at your listing photos, find defects (scuffs, stains), suggest item conditions, extract model details, and find the UPC.
  - Comp Lookup: Searches active eBay listings and calculates the average market price, excluding statistical outliers.
  - Multi-Channel Sync: Cross-posts to eBay, Shopify, WooCommerce, and Etsy concurrently.
  - Double-Sell Protection: Periodically checks active listings. If an item sells on eBay, it automatically archives the product on Shopify (and vice versa) to prevent double-selling.

  It runs locally on your machine and serves a clean dark-mode dashboard at `http://localhost:45900`. 

  It's completely open. I’ve put the code up on GitHub so anyone can clone it and run it for free.

  If anyone wants to try it, I'd love to hear your feedback on the pricing comp calculations or the layout!
  ```
