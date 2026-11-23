# ListAI Pro — Shipped Monetization & Quick Wins Ledger

All items below are **implemented, wired end-to-end (backend + dashboard + landing page), and verified by `test-suite.js`**.

---

## 1. Monetization & Willingness-To-Pay (WTP) Multipliers

1. **Agency / Consignment Tier ($149/mo or $1,490/yr — 3,500 AI Listings/mo & 10 Team Seats)**
   - Unlocks high-ticket B2B revenue from consignment stores, estate liquidators, and multi-VA operations (3x the ARPU of Power Seller).
   - Enforced in `TEAM_SEATS_BY_PLAN` (`agency: 10`), `LISTING_ALLOTMENT_BY_PLAN` (`agency: 3500`), `BILLING_PLANS.agency`, `inviteTeamMember`, `acceptTeamInvite`, and `getWorkspaceFor`.
2. **Annual Billing with 2 Months Free (10x Monthly Price Billed Yearly)**
   - **Pro Annual:** `$190/yr` ($16/mo effective — saves $38/yr).
   - **Power Seller Annual:** `$490/yr` ($41/mo effective — saves $98/yr).
   - **Agency Annual:** `$1,490/yr` ($124/mo effective — saves $298/yr).
   - Wired in `POST /api/billing/create-checkout-session` (`interval: "month" | "year"`), `POST /api/billing/webhook`, `public/landing.html` interactive pricing toggle, and `public/index.html` Upgrade Plan Modal.
3. **One-Time Instant Listing Credit Boost Packs (`CREDIT_PACKS`)**
   - **+100 AI Listings Boost:** `$9` one-time (`boost_100`).
   - **+500 AI Listings Boost:** `$29` one-time (`boost_500`).
   - Wired via `POST /api/billing/create-credit-pack-session`, `POST /api/billing/webhook` (`metadata.credit_pack`), `addBonusListings`, `getBonusListings`, and `resolveGenerationAllowance`.
4. **Interactive Reseller Time & Profit ROI Calculator (`public/landing.html`)**
   - Live sliders for weekly listing volume, average net profit per sold item, and manual minutes per listing. Calculates monthly hours saved, reinvested profit capacity, and recommends the exact tier.

---

## 2. Enterprise Reseller Features (Retention & LTV Drivers)

5. **Realized & Projected Portfolio P&L Analytics Engine (`lib/analyticsEngine.js` & `GET /api/analytics/pnl`)**
   - Category-accurate eBay Final Value Fee schedule (`EBAY_FVF_RATES` + $0.30 order fee), COGS tracking, net profit, profit margin %, ROI %, and unrealized profit projections on active/draft inventory.
6. **QuickBooks Desktop (`.IIF`) & Schedule C Tax CSV Accounting Exports (`lib/accountingExport.js`)**
   - `GET /api/accounting/export.csv` (RFC-4180 Schedule C / QuickBooks Online CSV) and `GET /api/accounting/export.iif` (double-entry QuickBooks Desktop `TRNS`/`SPL` journal splits for Accounts Receivable, Sales Income, Platform Fees, and COGS).
7. **Warehouse Code 128B Barcode Bin Labels & Walking-Order Pick Lists (`lib/binLocationManager.js`)**
   - Pure-JS Code 128B barcode encoder, print-ready 400×160 SVG bin labels (`GET /api/bins/label.svg?sku=...`), natural aisle/shelf alphanumeric sorting, and walking-order warehouse pick list generation (`POST /api/bins/pick-list`).
8. **eBay Active Content & Policy Compliance Scanner + 1-Click Auto-Fix (`lib/complianceScanner.js`)**
   - Scans listing HTML against 11 eBay policy rules (scripts, iframes, objects/embeds, inline JS event handlers, forms, meta redirects, external stylesheets, insecure HTTP assets, and off-site contact info) via `POST /api/compliance/scan` and auto-sanitizes via `POST /api/compliance/autofix`.
9. **Sourcing Venue ROI Leaderboard & Stale Dead-Capital Alerts (`lib/sourcingAnalytics.js`)**
   - Tracks sell-through rate, total spend, total profit, and average ROI by sourcing venue (Estate Sale, Goodwill, Garage Sale, etc.) and flags dead capital sitting active >60 days.
10. **10-Channel Publishing & Export Suite (`POST /api/export/:platform` & `GET /api/listings/export-whatnot.csv`)**
    - Direct API publishing to eBay, Shopify, Etsy, and WooCommerce + tailored copy-paste export packages for **Mercari, Poshmark, Depop, Grailed, Facebook Marketplace, and Whatnot** + bulk Whatnot live-show CSV download.
11. **Multi-Quantity Channel Reserve & Safety Buffer Engine (`lib/inventorySync.js` & `POST /api/inventory/reserve-calc`)**
    - Prevents multi-channel overselling with global safety buffers and per-channel reserve floors.

---

## 3. UX, Reliability & Security Quick Wins

12. **Live Net Profit, Fee, Margin % & ROI % Preview Bar in Listing Editor (`public/index.html`)**
    - Recalculates estimated eBay fees, net profit, margin %, and ROI % in real time as the seller edits Price or Cost of Goods.
13. **COGS + 15% Minimum Margin Guard in Automated Repricer (`ebayClient.js`, `lib/repricer.js`, `webServer.js`)**
    - Prevents automated daily repricing or bulk percentage discounts from dropping an item's price below `COGS * 1.15` or eBay's `$0.99` minimum.
14. **Bulk Price Adjustment (−10% / +10%) & Bulk Delete (`POST /api/listings/bulk-action`)**
    - One-click bulk price adjustments and bulk deletion from the Listing History toolbar, respecting `priceLocked`, `priceFloor`, `priceCap`, and the COGS 15% margin floor.
15. **Pattern-Based Secret Redaction in Audit Logs (`utils.sanitizeLog`)**
    - Scrubs dynamic Shopify tokens (`shpat_...`), WooCommerce keys (`ck_...`, `cs_...`), Gemini API keys (`AIza...`), Basic auth headers, and Bearer tokens from all log entries and error responses.
16. **Private Metadata Leak Prevention (`utils.sanitizeListingForMarketplace`)**
    - Strips `costOfGoods`, `internalNotes`, `binLocation`, and `sourcingVenue` before any outbound eBay, Shopify, WooCommerce, Etsy, or copy-paste export payload is constructed.
17. **Shopify Aspect Tag Sanitization (`crossPost.js`)**
    - Strips commas, semicolons, and quotes from eBay aspect values before building Shopify comma-delimited tag strings.
18. **Onboarding Wizard OAuth Fix & Non-Secret Config Prefill (`GET /api/config` & `public/index.html`)**
    - Fixes eBay OAuth Redirect URI instructions to `/api/auth/ebay/callback`, adds `EBAY_RUNAME` support, prefills non-secret settings via `GET /api/config`, and adds a 1-click eBay OAuth connection button.
19. **UI Polish Fix (`public/index.html`)**
    - Fixed corrupted Chinese characters on `#presetFastBtn` (`Fast (−10%利润)` → `Fast (−10%)`).
20. **Termux / Cross-Platform `sharp` WebAssembly Fallback & Zero npm Vulnerabilities (`package.json`)**
    - Added `@img/sharp-wasm32` optional dependency and upgraded `axios`, `follow-redirects`, and `sharp` (`npm audit` = 0 vulnerabilities).
