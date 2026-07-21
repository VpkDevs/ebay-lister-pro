# 🚀 eBay Multi-Channel Lister Pro (100% Zero-Dependency)

The ultimate, enterprise-grade, zero-dependency multichannel reselling platform. Scan folders, automatically spruce images, evaluate comps using IQR pricing filters, perform visual flaw analysis, check VeRO policies, and cross-list to eBay, Shopify, WooCommerce, Etsy, Mercari, and Poshmark.

Built entirely using native Node.js core APIs and vanilla frontend HTML/CSS/JS without any external package dependencies.

---

## 🏗️ Directory Layout & Codebase Architecture

```
ebay-lister-pro/
├── chrome-extension/     # Manifest V3 browser scraping extension
│   ├── manifest.json     # Extension setup settings
│   ├── content.js        # Amazon/eBay/Shopify/Poshmark listing scraper
│   ├── popup.html/js     # Scraped item viewer and sync buttons
│   └── background.js     # Background worker communications
├── public/               # Frontend Assets & Dashboard GUI
│   ├── index.html        # Main Outfit-styled dark-mode reseller dashboard
│   └── landing.html      # Customer-facing marketing/billing landing page
├── scratch/              # Active runtime databases (billing_status.json)
├── uploads/              # Image processing temporary uploads directory
├── bootstrap.js          # Interactive configuration wizard
├── start.js              # Concurrently spawns webServer and Watcher Daemon
├── config.js             # Global environment configurations & VeRO list
├── crossPost.js          # Cross-posting controllers and DLQ processor
├── ebayClient.js         # eBay API operations, Comps pricing, & Repricer
├── geminiClient.js       # Google Gemini Vision inspection and schema fixes
├── simple-lister-pro.js  # Automatic folder watch-daemon scanner
├── utils.js              # Atomic JSON files locking, logs, & PowerShell sprucing
└── test-suite.js         # Comprehensive unit and integration test suite
```

---

## 🛠️ Quick Start Guide

### 1. Run the Configuration Wizard
Before starting the application, run the interactive bootstrap wizard to check environment preconditions and initialize your `.env` file settings:
```powershell
node bootstrap.js
```
The configurator will ask you for:
- Chrome Extension secure API Key (generates a random secure default).
- Google Gemini API Key.
- eBay Client ID, Client Secret, and User Refresh Token.
- (Optional) Shopify subdomain and admin tokens.

### 2. Launch the Application Processes
Start the concurrent process runner to boot both the Web UI server and the background Watcher Daemon concurrently:
```powershell
node start.js
```
The lister is now running!
- **Dashboard Interface**: [http://127.0.0.1:45900](http://127.0.0.1:45900)
- **Watcher Daemon Scanner**: Watching the working directory for newly placed images.

---

## 🛍️ Chrome Extension Installation

Integrate Amazon, eBay, Shopify, Poshmark, and Mercari scrapers directly with your local dashboard:
1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** on in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `ebay-lister-pro/chrome-extension/` directory.
5. Click on the extension popup, enter your dashboard API Key (from your `.env` file), and start scraping. Scraped products instantly sync to your lister dashboard as drafts.

---

## 🚦 Enterprise Reliability Features

- **Domain-Specific Circuit Breakers**: Isolates connectivity failures (eBay vs. Shopify). If one service encounters 5 consecutive network errors, it trips and immediately returns fallback comps or queue requests without blocking other functional channels.
- **Dead-Letter Queue (DLQ)**: Failed WooCommerce, Etsy, or Shopify cross-posts are automatically queued in a DLQ (`pending-syncs.json`) with detailed error logs, and retried automatically every 5 minutes in the background.
- **Zero-Dependency Rate Limiting**: Built-in sliding token bucket rate limiter intercepts API endpoints, returning 429 to prevent brute force or dashboard abuse.
- **Self-Healing Storage**: All listing database reads and writes enforce file locks, backing up copies to `.bak` files. If primary database corruption is ever detected, the system auto-recovers from the backup database cleanly.
- **Structured Audit Logging**: Structured JSON logging propagates request trace IDs globally using `AsyncLocalStorage` for trace transparency.

---

## 🧪 Testing and Verification

Verify the system integration by running the native test suite containing **70 tests**:
```powershell
node test-suite.js
```
All mock network layers, image sprucing rules, pricing strategies, and API callbacks will be checked.
