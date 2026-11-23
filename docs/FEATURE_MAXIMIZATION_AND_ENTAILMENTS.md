# ListAI Pro — Master Feature Maximization (Pass #2) & Architectural Entailment Specification

> **Repository:** `VpkDevs/ebay-lister-pro` (`/data/data/com.termux/files/home/projects/ebay-lister-pro`)  
> **Scope:** 50 Customer-Facing Capabilities (`LF-01`–`LF-25` Internal Features, `F1`–`F18` Competitor Crown Jewels, `NF-01`–`NF-07` Net-New Reseller Multipliers) + **Complete System Entailments**.

---

## Part 1: Why Entailments Are Make-or-Break

A customer-facing feature is never just a button or an isolated route. Every feature **entails** (logically and operationally requires):
1. **Schema & Data-Store Entailments:** Exact fields on `listings-history.json`, `sold-orders.json`, `pending-syncs.json`, `templates.json`, `billing_status.json`, or new JSON stores—plus backward-compatible default normalization so existing records and all 196 existing tests never break.
2. **State-Machine & Invariant Entailments:** If a feature introduces a new listing status (e.g., `BUNDLED`, `WRITTEN_OFF`, `RETURNED`) or mutates price/quantity, every downstream loop (`runInventoryCrossSync`, `runDailyRepricer`, `computePortfolioAnalytics`, `exportToCSV`, `exportToIIF`, `buildListingsCsv`, `BULK_ALLOWED_STATUSES`, `sanitizeListingForMarketplace`) must know how to handle that state.
3. **Transport, Security & Runtime Entailments:** Browser extension `postMessage` bridges, React/Vue synthetic DOM event dispatchers, `DataTransfer` binary file hydration for `<input type="file">`, POST body size limits in `webServer.js` (`readRequestBody`), and BYOK/Metering credit accounting.
4. **UI/UX Lifecycle Entailments:** Creation, preview/dry-run, confirmation, error remediation, and undo/reversal.

---

## Part 2: Pass #2 on All 25 Internal Features (`LF-01`–`LF-25`) + Full Entailments

### `LF-01` — 2-Pass Photo-to-Listing AI Vision Generator
- **Pass #1:** Multi-Item Photo-Pile Auto-Clustering / Batch Draft Splitter (`POST /api/analyze/batch-clusters` — drop 40 photos of 10 items, group by `N` photos/item or visual/timestamp cluster, generate 10 separate Drafts).
- **Pass #2 (2nd Greatest Improvement):** **Per-Cluster Metering Pre-Check + Partial-Batch Fault Isolation & Resume**
  - If a seller drops 10 items (30 photos) and only has 6 listing credits remaining (or item #7 hits a temporary Gemini 503), a naive batch endpoint fails the entire 10-item upload. Pass #2 pre-validates `resolveGenerationRoute(user.email)` against the cluster count `K`, processes clusters sequentially/bounded-concurrently (concurrency = 2), saves each completed cluster immediately to `listings-history.json` as a `DRAFT`, increments `recordGeneration` *only* per succeeded cluster, and returns `{ succeeded: [...], failed: [...], skippedForCap: [...] }`.
- **Entailments:**
  1. *Middleware Body Limit Entailment:* `webServer.js` line 1581 currently grants a `50MB` POST limit only to `parsedUrl.pathname === '/api/analyze'`. `/api/analyze/batch-clusters` **must** be added to the `50MB` (or `100MB`) whitelist in `startWebGuiServer` or batch uploads will 413!
  2. *Rate-Limiter Entailment:* `checkRateLimit(clientIp, parsedUrl.pathname)` in `webServer.js` limits `/api/analyze` to 5 requests/60s. Batch clustering must count as 1 HTTP request against the IP rate limiter while internally pacing Gemini calls.
  3. *Storage Entailment:* Each generated draft in the batch must materialize its own persistent image directory under `data/uploads/listings/<SKU>/` so `cleanOldTempFiles()` doesn't delete the photos after 24 hours.

### `LF-02` — Remote Image & Product Page URL Importer
- **Pass #1:** Full JSON-LD (`application/ld+json` `@type: "Product"`) & OpenGraph (`og:title`, `og:price:amount`, `product:brand`) metadata, specs, and MSRP extraction alongside images.
- **Pass #2 (2nd Greatest Improvement):** **Multi-Variant / Colorway Selector & Competitor Boilerplate Sanitizer**
  - Product pages on Amazon/Shopify often contain 30+ images across 5 color variations plus store return-policy boilerplate in `description`. Pass #2 filters extracted images to the selected variant (or deduplicates thumb/zoom URL pairs like Amazon's `._AC_US40_.jpg` vs `._AC_SL1500_.jpg` to always pick the highest-resolution master image) and strips third-party store names/links via `complianceScanner.autoFix()` before prefilling the editor.
- **Entailments:**
  1. *SSRF Security Entailment:* Every scraped product page URL **AND** every `<img src>` or JSON-LD `image` URL extracted from that page must pass through `utils.validateRemoteImageUrl(url)` so a malicious product page cannot include `<img src="http://127.0.0.1:45900/...">` to trigger a second-hop SSRF.
  2. *Compliance Entailment:* Extracted third-party HTML descriptions must automatically run through `utils.stripScriptsAndIframes` + `complianceScanner.autoFix` before populating `#description` so off-site retailer links aren't published to eBay.

### `LF-03` — "Sell Similar" Competitor Listing & Keyword Importer
- **Pass #1:** Top-5 Comp Consensus Merger (unions populated Item Specifics by frequency across top 5 comps + uses IQR-trimmed median price).
- **Pass #2 (2nd Greatest Improvement):** **Competitor Title Gap & Missing-Keyword Injector**
  - Compares the top 5 highest-ranked comp titles to extract high-frequency search tokens that appear in ≥60% of top comps (e.g., `"OEM"`, `"Genuine"`, `"Tested"`, `"Fast Ship"`, `"Mens"`) and surfaces them as 1-click **"➕ High-Ranking Comp Keywords"** chips under the `#title` field.
- **Entailments:**
  1. *Metering Entailment:* Direct eBay Browse API imports remain unmetered (0 Gemini cost), while the Gemini fallback path when Browse API returns 0 items or 403 continues to enforce `resolveGenerationRoute(user.email)`.
  2. *VeRO Entailment:* Imported `brand` from a competitor listing must immediately trigger `checkVeroWarning(data.brand)` in the UI and set `veroWarning` on save.

### `LF-04` — UPC / ISBN-13 Barcode Scanner & Catalog Auto-Enrichment
- **Pass #1:** In-Browser Camera Barcode Scanner (`BarcodeDetector` API + canvas fallback) + Auto Media-Mail & Edition/Format Detection for books/games/vinyl/DVDs.
- **Pass #2 (2nd Greatest Improvement):** **Discogs Music Release + OpenLibrary + eBay Catalog Tri-Source Merger**
  - `config.js` line 196 already defines `config.getDISCOGS_TOKEN()`, which is currently unused in `resolveBarcodeData`! Pass #2 wires Discogs API lookup (for Vinyl/CD barcodes & catalog numbers) alongside OpenLibrary (for ISBN-13 books) and eBay Catalog API (for general UPCs), auto-populating Tracklist, Record Label, Release Year, Genre, Format, Author, and Binding into `aspects`.
- **Entailments:**
  1. *CSP & Permissions-Policy Header Entailment:* `webServer.js` line 1820 sets `Permissions-Policy: camera=(self), ...` (which we already enabled!) and `Content-Security-Policy` must allow `media-src 'self' blob:;` so `<video>` camera preview streams work in the browser without CSP violation.
  2. *Config Entailment:* Add `'DISCOGS_TOKEN'` to `allowedKeys` in `POST /api/config/save` and `GET /api/config`.

### `LF-05` — Studio Image Sprucing Editor & Auto-Spruce on Upload
- **Pass #1:** 1-Click "Apply Spruce Settings to All Gallery Photos" (`POST /api/images/spruce-batch`) + 85% Auto-Tight-Trim Product Centering + EXIF GPS Privacy Scrub.
- **Pass #2 (2nd Greatest Improvement):** **Non-Destructive "Revert to Original Photo" History Stack + Multi-Aspect-Ratio Padding (`1:1`, `4:5`, `5:4`)**
  - If a seller batch-spruces 10 photos with background removal and realizes 1 photo had a white shirt that blended into the white background, they need a 1-click **"↩ Revert Photo to Original"** button without re-uploading from disk!
- **Entailments:**
  1. *Original-File Retention Entailment:* `lib/imagePipeline.js` and `uploadedBase64Files` in `public/index.html` must keep a pointer `originalImageMap[index] = originalUrlOrData` alongside the spruced `/uploads/processed/spruced-*.jpg` URL so reverting is instant.
  2. *Payload Limit Entailment:* `/api/images/spruce-batch` must be added to the `50MB` POST body limit whitelist in `webServer.js` line 1581.

### `LF-06` — AI Copywriting Personas & 1-Click AI Text Polish (with Undo)
- **Pass #1:** Deterministic 80-Char eBay Cassini SEO Title Score Badge (0–100) + Before/After Score Delta.
- **Pass #2 (2nd Greatest Improvement):** **Persona + Category + Custom Rulebook Compiler**
  - Combines the selected Persona (*Standard, Luxury, Friendly, Vintage, Discount*) with the user's saved **Custom AI House-Style Rulebook (`F18`)** (`titlePrefix`, `bannedWords`, `requiredFooterHtml`) so both initial generation (`/api/analyze`) and text polish (`/api/enhance`) enforce the seller's exact rules deterministically.
- **Entailments:**
  1. *Policy 1 Billing Invariant Entailment:* `/api/enhance` must remain **100% unmetered** (never incrementing `usage.json`) while routing through `resolveEnhanceKey(user.email)` so free-tier/overflow users run on their own BYOK key.

### `LF-07` — Live eBay Market Comp Bell-Curve Chart & 1-Click Price Presets
- **Pass #1:** Interactive Comp Exclude Checkboxes (`#compLinks`) + Red Dashed "Break-Even Floor Line" (`COGS + Est. Shipping + eBay Fee`) drawn on `#compsChart`.
- **Pass #2 (2nd Greatest Improvement):** **Comp Condition Filter Pill (`New` / `Used` / `For Parts`) + Manual Comp Re-Query Input**
  - Sometimes the AI's 80-char SEO title is *too* specific for eBay comp search (returning 0 comps), whereas a 3-word query (`"Sony WM-FX290 Walkman"`) returns 20 comps. Pass #2 adds an inline **"🔍 Refine Comp Search Query"** input right above `#compsBar` (`GET /api/ebay/comps?q=...&condition=...`) so the seller can tweak the comp search keywords or condition and refresh the chart in 1 second without re-running Gemini Vision!
- **Entailments:**
  1. *New Endpoint Entailment:* Expose `GET /api/ebay/comps?q=<keywords>&condition=<cond>` in `webServer.js` wrapping `ebayClient.searchEbayComps(q, condition)`.
  2. *Reactive State Entailment:* Unchecking a comp checkbox or running a refined comp query must update `initialPrice`, `#compMin`, `#compAvg`, `#compMax`, `drawCompsChart()`, and `renderTakeHomePanel()` in unison.

### `LF-08` — 5-Marketplace Net Take-Home Pricing Table & Live Net Profit Bar
- **Pass #1:** True Net Profit After COGS & Seller-Paid Shipping in `#takeHomePanel` + Reverse "Target Profit Solver" (*"I want $25 net profit ➔ sets required list price"*).
- **Pass #2 (2nd Greatest Improvement):** **Expand Take-Home Fee Engine to All 8 Marketplaces (`eBay`, `Mercari`, `Poshmark`, `Etsy`, `Shopify`, `Depop`, `Grailed`, `Whatnot`)**
  - Adds fee schedules for **Depop** (0% US selling fee + 3.3% + $0.45 payment processing), **Grailed** (9% commission + 3.49% + $0.49 processing), and **Whatnot** (8% commission + 2.9% + $0.30 processing).
- **Entailments:**
  1. *Backward-Compatible Test Contract Entailment:* `test-suite.js` asserts `Object.keys(utils.MARKETPLACE_FEES)` has the 5 Wave-1C keys (`['ebay', 'mercari', 'poshmark', 'etsy', 'shopify']`) in `buildTakeHomePanel`. Therefore, keep `utils.MARKETPLACE_FEES` with those exact 5 keys so existing unit tests pass 100%, and expose `utils.EXTENDED_MARKETPLACE_FEES` (all 8 marketplaces) for the extended profit solver and cross-list price translator (`F1`)!

### `LF-09` — eBay Category Type-Ahead Search & Auto-Required Item Specifics Filler
- **Pass #1:** 1-Click "✨ AI Fill Blank Specifics" button (`POST /api/aspects/autofill`) when switching categories.
- **Pass #2 (2nd Greatest Improvement):** **Required vs. Recommended Aspect Visual Separation + Instant Validation Counter (`"6/6 Required Specifics Complete ✓"`)**
  - Sorts required aspects (`meta.required === true`) to the top of `#aspectsContainer` with an amber `* Required` badge and shows a live completion counter in the section header.
- **Entailments:**
  1. *Taxonomy Cache Entailment:* Cache `getItemAspectsMetadata(categoryId)` in memory (with 1-hour TTL) in `ebayClient.js` so switching categories or auto-filling specifics doesn't hammer eBay's Taxonomy API repeatedly.

### `LF-10` — Reusable Listing Templates & Field Presets
- **Pass #1:** Unify `#listingTemplateSelect` and `#templateSelect` into one Template Manager + `DELETE /api/templates` + Overwrite Existing + `{{token}}` Variable Interpolation (`{{brand}}`, `{{model}}`, `{{condition}}`, `{{sku}}`, `{{binLocation}}`).
- **Pass #2 (2nd Greatest Improvement):** **Category-Linked Auto-Default Templates**
  - Allows a template to specify an optional `defaultForCategoryId` (or category keyword like `"Clothing"` or `"Books"`). When the AI classifies an item into that category, the matching template's shipping policy, return policy, and description footer snippet apply automatically!
- **Entailments:**
  1. *Private-Field Sanitization Entailment:* Templates can store `costOfGoods`, `binLocation`, `sourcingVenue`, and `internalNotes` locally in `templates.json`, and `utils.sanitizeListingForMarketplace()` guarantees those fields are stripped before any outbound marketplace publish.

### `LF-11` — Real-Time Autosave, Local Crash-Recovery & Draft Manager
- **Pass #1:** Non-Blocking "📝 Unsaved Draft Available — [Restore] [Discard]" Banner in `#create-view` + Auto-Clear `lp-autosave-draft` on `saveDraft()` / `publishListing()` + Live `"☁️ Autosaved"` timestamp pill.
- **Pass #2 (Status):** **`MAXIMIZED`**
  - *Why:* Once autosave is non-blocking, clears cleanly on save/publish, syncs to `/api/draft/autosave`, and supports multi-draft recovery, the draft lifecycle is frictionless and complete.
- **Entailments:**
  1. *DOM Lifecycle Entailment:* Remove the blocking `window.confirm()` inside `window.addEventListener('load')` in `public/index.html` line 6183 and replace it with `#unsavedDraftBanner`.

### `LF-12` — Direct eBay Publishing with Business Policies, Best Offer & Promoted Listings
- **Pass #1:** <50ms Pre-Publish Readiness Validator (`POST /api/publish/preflight`) + 1-Click Margin-Safe Best-Offer Auto-Accept / Auto-Decline Bounds Calculator.
- **Pass #2 (2nd Greatest Improvement):** **Scheduled Listing Launch / "Publish Later" Queue (`scheduledPublishAt`)**
  - eBay auctions and fixed-price drops convert best during peak evening hours (Sunday 5 PM–8 PM PT). Pass #2 allows saving a draft with `scheduledPublishAt: ISOString`; the server's 5-minute background loop in `webServer.js` automatically publishes any `SCHEDULED` draft whose `scheduledPublishAt <= Date.now()`!
- **Entailments:**
  1. *Status Enum Entailment:* Add `'SCHEDULED'` to `BULK_ALLOWED_STATUSES` (or keep `BULK_ALLOWED_STATUSES = ['SOLD', 'ACTIVE', 'DRAFT', 'ENDED']` if locked by a test—let's check: `test-suite.js` checks `BULK_ALLOWED_STATUSES`! So keep `BULK_ALLOWED_STATUSES` intact or store `scheduledPublishAt` on `DRAFT` listings so status stays `'DRAFT'` until the scheduler flips it to `'ACTIVE'`!). That's a classic test-contract entailment catch.

### `LF-13` — Concurrent API Cross-Posting to Shopify, WooCommerce & Etsy
- **Pass #1:** 1-Click Post-Publish "Push to Shopify / Woo / Etsy" buttons in Listing History (`POST /api/crosspost/push`) + Per-Channel Price Offset %.
- **Pass #2 (2nd Greatest Improvement):** **Bulk Multi-SKU Cross-Post Runner (`POST /api/crosspost/bulk-push`)**
  - Lets a seller select 20 eBay-only active listings in Listing History and click **"🟢 Bulk Push to Shopify"** or **"🟣 Bulk Push to WooCommerce"**, pushing all 20 concurrently with automatic DLQ fallback for any row that fails.
- **Entailments:**
  1. *History Persistence Entailment:* When `POST /api/crosspost/push` succeeds for an existing SKU, it must update `item.shopifyId`, `item.woocommerceId`, or `item.etsyId` in `listings-history.json` so `runInventoryCrossSync()` immediately begins monitoring that channel for 2-way stock sync.

### `LF-14` — Failed Cross-Post Sync Queue (Dead Letter Queue) Manager
- **Pass #1:** Smart Error Remediation Buttons + Inline Queued Payload Editor Inside `#dlq-view` (`POST /api/dlq/update-and-retry`).
- **Pass #2 (Status):** **`MAXIMIZED`**
  - *Why:* Exponential backoff + max-attempt exhaustion + inline payload repair + 1-click force retry covers the entire DLQ lifecycle.
- **Entailments:**
  1. *Sanitization Entailment:* Any inline edit to a queued DLQ listing payload must run through `utils.sanitizeListingForMarketplace()` and `utils.stripScriptsAndIframes()` before updating `pending-syncs.json`.

### `LF-15` — 6-Platform Copy-Paste Cross-List Assistant & Bulk Whatnot CSV Exporter
- **Pass #1:** 1-Click "🚀 Copy All & Launch [Platform] Create-Listing Tab" (triggering Chrome Extension DOM Auto-Fill `F1`) + External Channel Status Badges (`POST /api/listings/link-channel`).
- **Pass #2 (2nd Greatest Improvement):** **Platform-Specific Image Zip / 1-Click Sequential Image Downloader + Fee-Compensated Price Toggle in Export Modal**
  - Adds a toggle inside `#exportModal`: **"☑️ Auto-Adjust Price for [Platform] Fees to Keep $[X] Net Profit"** plus a **"📥 Download All Photos"** button for desktop uploaders.
- **Entailments:**
  1. *Bridge Entailment:* `public/index.html` dispatches `window.postMessage({ type: 'LISTAI_CROSSLIST_LAUNCH', platform, sku, payload, images }, window.location.origin)` which `chrome-extension/content.js` intercepts and stores in `chrome.storage.local` before opening the marketplace tab.

### `LF-16` — Automated 2-Way Inventory Cross-Sync & Multi-Quantity Safety Buffer
- **Pass #1:** Extend `runInventoryCrossSync()` 2-Way Auto-Zeroing to **WooCommerce & Etsy** (alongside eBay & Shopify) + Auto-Record Realized Sales into `sold-orders.json` + Push Non-API Delist Alerts (`F2`).
- **Pass #2 (2nd Greatest Improvement):** **Sync Conflict & External Price-Drift Detector**
  - Detects if a seller changed an item's price directly on eBay Seller Hub or Shopify Admin outside ListAI Pro and updates the local `listings-history.json` price (unless `priceLocked` is true) while logging an audit notification.
- **Entailments:**
  1. *Idempotency Entailment:* When `runInventoryCrossSync()` detects a newly ended/sold item and writes a record to `sold-orders.json`, it **must** deduplicate by `sku` / `orderId` so a 5-minute polling loop never writes duplicate sale records for the same SKU.

### `LF-17` — Automated Daily Market-Comp Repricer with COGS + 15% Margin Floor
- **Pass #1:** "Preview / Dry-Run Reprice Changes" Diff Modal (`POST /api/repricer/run` with `{ dryRun: true }`) + Persistent Reprice Audit Log (`GET /api/repricer/log`).
- **Pass #2 (2nd Greatest Improvement):** **1-Click "Undo Last Reprice Batch" Rollback (`POST /api/repricer/rollback`)**
  - Because every repricing cycle records `{ sku, oldPrice, newPrice, offerId, timestamp }` in `scratch/reprice-log.json`, we can offer a 1-click **"↩ Rollback Last Reprice Run"** button that restores `oldPrice` on eBay and in `listings-history.json`!
- **Entailments:**
  1. *Audit Store Entailment:* `runDailyRepricer` in `ebayClient.js` must append each price change to `path.join(config.scratchDir, 'reprice-log.json')` and return `{ updatedCount, changes: [...] }` so both dry-run and live runs return structured diffs.

### `LF-18` — 1-Click Discount Offers to eBay Watchers
- **Pass #1:** Bulk Margin-Safe Watcher Offer Campaign (`POST /api/offers/bulk-send`) clamped to `max(COGS * 1.15, priceFloor)`.
- **Pass #2:** Age-Tiered Dynamic Offer Escalation (`10%` <30d, `15%` 30–60d, `20%` >60d, still clamped to `COGS * 1.15`). *(Unified with `F15` — **`MAXIMIZED`**).*
- **Entailments:**
  1. *Active-Listing Guard Entailment:* Only items with `status === 'ACTIVE'` and a valid `listingId` may be sent to `ebayClient.sendOffersToWatchers(listingId, discountPct)`.

### `LF-19` — VeRO Intellectual Property Brand Risk Warning & Auto-Genericizer
- **Pass #1:** 3-Tier VeRO Intelligence: (1) 1-Click Fix Banned Trademark Words (*Velcro ➔ Hook & Loop, Onesie ➔ Bodysuit*), (2) Authentic Luxury/Apparel Guard (*Auto-Uncheck Catalog Stock Photos + Prompt for Authenticity Tag Photo*), (3) Aftermarket Parts Genericizer (`"Compatible with [Brand]"`).
- **Pass #2 (2nd Greatest Improvement):** **User-Extensible Custom VeRO & Restricted-Brand Watchlist (`POST /api/vero-brands/custom`)**
  - eBay adds new VeRO complainants every month. Lets the seller add custom restricted brands or keywords to their workspace's VeRO watchlist.
- **Entailments:**
  1. *Description Scan Entailment:* VeRO checking must scan not only `#brand`, but also `#title` and `#description` for banned genericized trademarks (`Velcro`, `Onesie`, `Bubble Wrap`, `Tupperware`, `Jacuzzi`) when the item's brand is not that trademark owner.

### `LF-20` — eBay Active Content & Policy Compliance Scanner + 1-Click Auto-Fix
- **Pass #1:** Portfolio-Wide 1-Click "Audit & Auto-Fix All Listings Compliance" (`POST /api/compliance/autofix-all`).
- **Pass #2 (Status):** **`MAXIMIZED`**
  - *Why:* 12-rule editor scan + 1-click editor auto-fix + 1-click portfolio-wide batch sanitization + automatic pre-publish stripping covers every entry vector.
- **Entailments:**
  1. *History Mutation Entailment:* `POST /api/compliance/autofix-all` must sanitize both top-level `item.description` and `item.listingDetails.description` in `listings-history.json` and return `{ scanned, fixedCount, fixedSkus }`.

### `LF-21` — Bulk Inventory Operations & Round-Trip CSV Import/Export
- **Pass #1:** Universal Competitor CSV Auto-Translator (transparently imports Vendoo, List Perfectly, eBay Seller Hub, and Shopify CSVs without manual column renaming) + Bulk Assign Bin Location / Sourcing Venue (`action: 'assign_metadata'` in `POST /api/listings/bulk-action`).
- **Pass #2 (2nd Greatest Improvement):** **1-Click "Download Failed Import Rows as Error-Annotated CSV"**
  - When a seller imports a 200-row CSV and 8 rows fail validation (e.g., missing price or duplicate SKU), instead of making them hunt for rows #14, #89, and #142 in Excel, provide a 1-click download of just the 8 failed rows with an added `importError` column so they can fix and re-upload in 30 seconds!
- **Entailments:**
  1. *Exact Header Contract Entailment:* `LISTING_CSV_HEADERS` in `webServer.js` **must remain the exact 14 columns** tested by `test-suite.js:3826` (`sku,title,price,msrp,keywords,costOfGoods,internalNotes,status,categoryId,createdAt,ebayListingId,shopifyId,woocommerceId,etsyId`). Competitor header alias mapping must run inside `importListingsFromCsv` when normalizing incoming header names (`"item number" -> "sku"`, `"handle" -> "sku"`, `"current price" -> "price"`, `"variant price" -> "price"`, `"cost" -> "costOfGoods"`, `"bin" -> "binLocation"`, `"source" -> "sourcingVenue"`).

### `LF-22` — Warehouse Bin Location Manager, Code 128B Barcode Labels & Pick Lists
- **Pass #1:** Batch Multi-Label Printable HTML/SVG Sheet (`GET /api/bins/labels-sheet?skus=...&layout=thermal|avery5160`) + Interactive Barcode Scan-to-Verify Pick Checkoff on Pick Lists.
- **Pass #2 (2nd Greatest Improvement):** **Bin Capacity & Empty/Freed-Bin Reclaim Tracker**
  - When all items in `Bin A1-S2-B4` are marked `SOLD`, highlights `A1-S2-B4` as **"🟢 Empty / Ready for Reuse"** in `#analytics-view` so the seller knows which physical bins in their garage/warehouse are open for new inventory!
- **Entailments:**
  1. *Print CSS Entailment:* `GET /api/bins/labels-sheet` must output clean `@media print` CSS (`@page { margin: 0; }` for 4"×6" / 2.25"×1.25" thermal labels and 3-column × 10-row grid for Avery 5160 sheets) with `window.print()` trigger button.

### `LF-23` — Profit, Tax & Sourcing ROI Command Center
- **Pass #1:** "💰 Record Actual Sale Details" Modal (`POST /api/orders/record-sale`: Channel, Actual Sold Price, Actual Shipping Cost, Shipping Charged, Buyer Name) + IRS Schedule C Overhead Expense & Mileage (67¢/mi) Ledger (`F11`) + 4-Bucket Aging Markdown (`F12`).
- **Pass #2 (2nd Greatest Improvement):** **CPA Year-End Tax Packet Generator (`GET /api/accounting/tax-packet.json` & `.csv`)**
  - Generates a complete, single-click **IRS Schedule C Year-End Summary** combining: Part I (Gross Receipts, Returns/Allowances, COGS Breakdown: Beginning Inventory + Purchases − Ending Inventory) and Part II (Platform Fees, Shipping Postage, Supplies, Mileage at 67¢/mi, Software/Storage Overhead) + Net Schedule C Profit & Estimated 1040-ES Self-Employment Tax.
- **Entailments:**
  1. *Expense Store Entailment:* Add `expensesPath = path.join(dataDir, 'expenses.json')` in `config.js` so overhead expenses and mileage survive container restarts under `LISTER_STATE_DIR`.

### `LF-24` — Team Seats & Shared Workspace Management
- **Pass #1:** 1-Click Pending Invite Auto-Banner on Login (`pendingInvitesForMe` in `GET /api/team`) + Per-Seat Activity Attribution (`createdBy`, `publishedBy`) & Lister Productivity Leaderboard.
- **Pass #2 (2nd Greatest Improvement):** **Optional "VA Draft-Only Mode" Toggle (`allowMemberDirectPublish: boolean`)**
  - Many Power Seller ($49) and Agency ($149) owners hire remote VAs to create drafts from photos, but want the owner to review pricing before any item goes live on eBay. Pass #2 adds a 1-click workspace toggle: **"Require Owner Approval Before Team Members Can Publish Live"** (when enabled, team members can generate and save Drafts freely, while `POST /api/publish` and `POST /api/publish-draft` require `role === 'owner'`).
- **Entailments:**
  1. *Team Store Contract Entailment:* `pendingInvitesForMe` in `GET /api/team` is an additive field (`pendingInvitesForMe: [...]`) when `role === 'none'`, preserving all existing `GET /api/team` fields (`role, owner, plan, maxSeats, members, usage`) tested in `test-suite.js`.

### `LF-25` — Self-Serve BYOK Gemini Key Valve, Credit Packs, Onboarding Wizard & Chrome Extension
- **Pass #1:** Topbar Live Usage & Plan Meter Pill (`⚡ 42 / 300 · Pro`) + 1-Click "🔌 Test Gemini Key / Test Channel Connection" Ping Endpoints (`POST /api/user/gemini-key/test`, `POST /api/config/test-channel`).
- **Pass #2 (2nd Greatest Improvement):** **1-Click Chrome Extension Auto-Pair (Zero Manual API Key Copy-Paste)**
  - Right now, to use the Chrome Extension, the operator has to manually copy `API_KEY` from `.env` and paste it into the extension popup. Pass #2 adds a **"🧩 Pair Chrome Extension"** button in Settings that posts the session/operator token to `window.postMessage({ type: 'LISTAI_PAIR_EXTENSION' })`, which `chrome-extension/content.js` saves directly into `chrome.storage.local`!
- **Entailments:**
  1. *Security Entailment:* Extension pairing via `postMessage` must only fire upon explicit user click in Settings when authenticated, never exposing `API_KEY` on unauthenticated public endpoints.

---

## Part 3: 7 Net-New High-Value Reseller Multipliers (`NF-01`–`NF-07`) + Pass #1, Pass #2 & Entailments

### `NF-01` — Dimensional-Weight, Box-Size & Carrier Rate Optimizer (`lib/shippingOptimizer.js`)
- **What It Does for the Customer:** Resellers routinely lose $5–$18 on shipping because they underestimate cubic/dimensional weight (`(L × W × H) / 166`) or pick USPS Priority Mail when USPS Ground Advantage or UPS Ground Saver is $6 cheaper—or forget that Books/Vinyl/DVDs qualify for $4.63 USPS Media Mail.
- **Pass #1:** Given `(weightMajor, weightMinor, packageLength, packageWidth, packageHeight, categoryId)`, computes Billable Weight (`max(actualWeight, dimWeight)`), checks Media Mail eligibility, estimates rates across **USPS Media Mail, USPS Ground Advantage, USPS Priority Mail, USPS Flat Rate Padded/Medium/Large Box, and UPS Ground**, and recommends the cheapest carrier service.
- **Pass #2:** **Box-Trimming Savings Alert** — Detects when reducing a box dimension by 1–2 inches (e.g., `14×12×10"` ➔ `14×12×8"`) drops the package below the 1-cubic-foot (`1,728 in³`) dimensional-weight surcharge cliff and tells the seller: *"💡 Crush/trim box height by 2\" to save ~$4.80 on dimensional weight!"*
- **Entailments:**
  1. *Editor Wiring Entailment:* Hook `shippingOptimizer` into `#weightLbs`, `#weightOz`, `#dimL`, `#dimW`, `#dimH` in `#sec-shipping` (`POST /api/shipping/estimate`) and feed the recommended shipping cost into `#liveNetProfitBar` when Free Shipping is selected.

### `NF-02` — Multi-Variation & Lot Parent-Child Matrix Builder (`lib/variationBuilder.js`)
- **What It Does for the Customer:** Sellers with 10 shirts in sizes `S, M, L, XL` or 3 colors currently have to create separate listings.
- **Pass #1:** Builds an eBay `inventory_item_group` payload (`PUT /inventory_item_group/{inventoryItemGroupKey}`) and Shopify multi-variant array from a single parent form with a 1-click Variation Matrix (`Size × Color × Quantity × Price`).
- **Pass #2:** **Auto-SKU Child Generator (`PARENT-SKU-BLK-L`) + Per-Variant Barcode/COGS Tracking**.
- **Entailments:**
  1. *eBay API Entailment:* Uses eBay Sell Inventory API `/inventory_item_group/{key}` after creating each child `/inventory_item/{childSku}` and `/offer`.

### `NF-03` — Pre-Publish INAD & Return-Risk Auditor (`lib/returnRiskAuditor.js`)
- **What It Does for the Customer:** eBay "Item Not As Described" (INAD) returns cost the seller two-way shipping plus a defect strike.
- **Pass #1:** Audits a listing before publish for the 6 leading causes of INAD returns:
  1. Condition is `USED_*` or `FOR_PARTS` but description contains zero condition/wear notes.
  2. Apparel/Footwear category (`11450`, `93427`, etc.) with zero measurements in description or aspects.
  3. Fewer than 3 photos uploaded on a used item.
  4. Title says `"New"` or `"Mint"` while Condition enum is `USED_GOOD` or `FOR_PARTS_OR_NOT_WORKING` (Condition-Title Contradiction!).
  5. VeRO brand with catalog stock photos enabled on a used item.
  6. Electronics item without `"Tested"` / `"Working"` / `"For Parts"` disclosure.
- **Pass #2:** **1-Click "Auto-Resolve Return Risks" Button** that automatically resolves contradiction #1, #4, #5, and #6 by syncing condition disclaimers and unchecking stock photos on used items.
- **Entailments:**
  1. *UI Entailment:* Renders an **INAD Return-Safety Score (`0–100% Safe`)** right next to the Listing Completeness bar in `#create-view`.

### `NF-04` — Sourcing Receipt & Manifest Vision OCR → Auto-COGS & Expense Allocator
- **What It Does for the Customer:** Typing COGS and expenses from crumpled Goodwill receipts or estate-sale invoices is the #1 chore resellers procrastinate on.
- **Pass #1:** Upload a photo of a receipt or invoice (`POST /api/accounting/parse-receipt`); Gemini Vision extracts `{ venue, date, lineItems: [{ description, price }], taxPaid, totalPaid }` and lets the user match line items directly to active/draft SKUs' `costOfGoods` or log supplies/fees to `expenses.json`.
- **Pass #2:** **Sales-Tax Proration into Per-Item COGS** (automatically distributes the receipt's local sales tax across each purchased item's `costOfGoods` so every cent paid at the register is captured in the tax basis).
- **Entailments:**
  1. *BYOK / Key Routing Entailment:* Uses `resolveEnhanceKey(user.email)` (or house key on paid plans) without decrementing listing generation credits (Policy 1: administrative/edit utility, not a new listing generation).

### `NF-05` — Multi-Store / Client Profile Switcher (for Power Seller & Agency Tiers)
- **What It Does for the Customer:** Consignment agencies ($149/mo) and full-time sellers ($49/mo) often manage 2+ separate eBay/Shopify storefronts or separate client catalogs.
- **Pass #1:** Allows saving named **Store Profiles** (`storeProfiles.json`) carrying per-store `SKU_PREFIX`, `WATERMARK_TEXT`, `SELLER_SHIPPING_TERMS`, `SELLER_RETURN_TERMS`, and default `consignorName`.
- **Pass #2:** **Per-Store P&L & Inventory Filter** in `#history-view` and `#analytics-view` (filtering by `skuPrefix` or `storeProfileId`).
- **Entailments:**
  1. *Backward-Compatibility Entailment:* Default profile always reads/writes the global `config.js` settings so single-store users and existing tests experience zero change.

### `NF-06` — Thermal Label Printer Ready Suite (4"×6" & 2.25"×1.25" Dymo / Rollo / Zebra Layouts)
- **What It Does for the Customer:** Resellers use Rollo, Dymo 4XL/450, and Zebra thermal printers—not standard 8.5"×11" inkjets.
- **Pass #1:** Adds exact thermal-printer page presets (`2.25in × 1.25in` SKU/Bin barcode sticker, `4in × 6in` Warehouse Bin Placard / Whatnot Show Pull-Tag, and `30-up Avery 5160` sheet) to `lib/binLocationManager.js` (`GET /api/bins/labels-sheet`).
- **Pass #2:** **QR + Code 128B Dual-Code Label Option** (includes both a 1D Code 128B barcode for laser scanners and a 2D QR/deep-link URL that opens the SKU directly in ListAI Pro on a phone!).

### `NF-07` — 30/60/90-Day Cashflow & Break-Even Velocity Forecast (`lib/cashflowForecaster.js`)
- **What It Does for the Customer:** Shows the seller when their current invested COGS will turn back into cash based on their actual historical daily sell-through rate.
- **Pass #1:** Computes `dailySellThroughRate`, `daysToRecoverInvestedCogs`, and `projected30DayNetCashInflow` from `listings-history.json` + `sold-orders.json`, displayed in `#analytics-view`.
- **Pass #2:** **"Sourcing Budget Allowance" Calculator** (*"Based on your last 30 days of realized net profit ($X) and tax reserve ($Y), your safe weekly reinvestment sourcing budget is $Z"*).

---

## Part 4: Master Cross-System Entailment Checklist (Before & During Implementation)

| Entailment Domain | Concrete Requirement in `VpkDevs/ebay-lister-pro` | Affected Files |
| :--- | :--- | :--- |
| **1. Test-Suite Contract Preservation (196/196)** | • `LISTING_CSV_HEADERS` must stay the exact 14 columns.<br>• `utils.normalizeListingFields({})` must return `{ keywords: [], msrp: null, costOfGoods: null, internalNotes: '' }` (only normalize optional fields like `binLocation`, `sourcingVenue`, `consignorName`, `consignorSplitPct`, `measurements`, `externalChannels` when present on the input object).<br>• `utils.MARKETPLACE_FEES` must keep its 5 keys (`ebay, mercari, poshmark, etsy, shopify`); place Depop/Grailed/Whatnot in `utils.EXTENDED_MARKETPLACE_FEES`.<br>• `utils.sanitizeListingForMarketplace` must delete all private fields (`internalNotes`, `costOfGoods`, `binLocation`, `sourcingVenue`, `consignorName`, `consignorSplitPct`). | `utils.js`, `webServer.js`, `test-suite.js` |
| **2. Persistent State Root (`LISTER_STATE_DIR`)** | Every new JSON data file (`expenses.json`, `delist-queue.json`, `ai-rulebooks.json`, `feedback-history.json`, `reprice-log.json`) **must** resolve under `config.dataDir` or `config.scratchDir` (which derive from `config.stateRoot`), so Railway volume mounts and `utils.safeResolvePath()` allow them without directory-traversal rejections. | `config.js`, `utils.js` |
| **3. Middleware Body-Size & Rate-Limit Whitelists** | Any new batch image or manifest endpoint (`/api/analyze/batch-clusters`, `/api/images/spruce-batch`, `/api/accounting/parse-receipt`, `/api/listings/batch-generate`) must be added to the `20MB–50MB` POST body limit branch in `webServer.js` (line 1581). | `webServer.js` |
| **4. Metering & BYOK Invariants** | • Only endpoints that generate **new listings from AI** (`/api/analyze`, `/api/analyze/batch-clusters`, `/api/ebay/import` Gemini fallback, `/api/listings/batch-generate` AI fallback) consume monthly listing credits via `resolveGenerationRoute` + `recordGeneration`.<br>• Edits, aspect autofill, receipt OCR, compliance autofix, and comp lookups never consume listing credits (Policy 1) and use `resolveEnhanceKey` when applicable.<br>• A failed call on a user's BYOK key (`USER_KEY_REJECTED` / `USER_KEY_CALL_FAILED`) **never** falls back to the house key and never increments usage. | `webServer.js`, `geminiClient.js` |
| **5. Chrome Extension ↔ Dashboard Bridge** | • `chrome-extension/content.js` must listen for `window.postMessage` events (`LISTAI_CROSSLIST_LAUNCH`, `LISTAI_PAIR_EXTENSION`) on the dashboard origin.<br>• Form auto-fill on Poshmark/Mercari/Depop/Grailed must use native `HTMLInputElement.prototype` value setters + bubbling `input`/`change` events + `DataTransfer` `File` hydration for photos + floating `"✓ Link External Listing URL"` callback bar. | `chrome-extension/content.js`, `chrome-extension/background.js`, `chrome-extension/popup.js`, `public/index.html` |
