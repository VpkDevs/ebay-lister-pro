# 📘 Operational Runbook — eBay Multi-Channel Lister Pro

This runbook contains all details required to run, operate, deploy, and maintain the eBay Multi-Channel Lister Pro platform.

---

## 🏗️ Architecture & Component Overview

Lister Pro is built as a zero-dependency Node.js system. It consists of two primary services managed concurrently by a process runner (`start.js`):

1. **Dashboard Web Server (`webServer.js`)**: Serves the dashboard GUI, handles OAuth integrations, interacts with platform APIs (eBay, Shopify, Etsy, WooCommerce), manages the Stripe billing lifecycle, and handles the Dead-Letter Queue (DLQ).
2. **Watcher Daemon (`simple-lister-pro.js --watch`)**: Monitors `data/uploads/watch/` for incoming images, clusters them automatically, extracts UPC barcodes/aspects using Gemini Vision AI, and enriches new drafts.

### Data Storage & Persistence
- **Audit Logs**: Stored locally in `data/lister-audit.log`.
- **Database History**: Saved to `data/listings-history.json` with file-locks and `.bak` self-healing.
- **Dead-Letter Queue (DLQ)**: Stored in `data/pending-syncs.json` and retried every 5 minutes.
- **Temporary Uploads**: Cached in `data/uploads/` and deleted automatically on startup.

---

## 🚀 Running Locally

Follow these steps to boot the application on your local machine:

### 1. Initialize Configuration
Copy `.env.example` to `.env` and fill in your details:
```powershell
cp .env.example .env
```
Or run the configuration wizard:
```powershell
node bootstrap.js
```

### 2. Start Services
Launch both the Dashboard Web Server and the Watcher Daemon:
```powershell
node start.js
```
- The Web Dashboard is now accessible at [http://127.0.0.1:45900](http://127.0.0.1:45900).
- The watch folder is active at `data/uploads/watch/`.

### 3. Run the Test Suite
Ensure the codebase remains functionally sound:
```powershell
npm test
```

---

## 🔑 Environment Variables Directory

| Variable | Description | Source / Where to obtain | Required? |
|---|---|---|---|
| `API_KEY` | Chrome extension auth token | Generate a random string | Yes (for extension sync) |
| `GEMINI_API_KEY` | Google Gemini AI access token | [Google AI Studio](https://aistudio.google.com/) | Yes (for Vision analysis) |
| `EBAY_CLIENT_ID` | eBay Developer App Client ID | [eBay Developer Portal](https://developer.ebay.com/) | Yes (for eBay integration) |
| `EBAY_CLIENT_SECRET`| eBay Developer App Client Secret | [eBay Developer Portal](https://developer.ebay.com/) | Yes (for eBay integration) |
| `EBAY_REFRESH_TOKEN`| User OAuth Refresh Token | Generate via Auth flow | Yes (for active listings) |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | [Google Cloud Console](https://console.cloud.google.com/) | No (optional premium auth) |
| `GOOGLE_CLIENT_SECRET`| Google OAuth Client Secret | [Google Cloud Console](https://console.cloud.google.com/) | No (optional premium auth) |
| `STRIPE_SECRET_KEY` | Stripe billing API Key | [Stripe Dashboard](https://dashboard.stripe.com/) | No (optional subscriptions) |
| `SHOPIFY_SHOP_NAME` | Shopify store subdomain name | Your Shopify store name | No (optional Shopify channel) |
| `SHOPIFY_ACCESS_TOKEN`| Shopify Admin Access Token | Created in Custom Apps settings | No (optional Shopify channel) |
| `WOOCOMMERCE_URL` | WooCommerce storefront url | WooCommerce URL | No (optional WooCommerce) |
| `ETSY_SHOP_ID` | Etsy Shop ID | [Etsy Developer Console](https://developers.etsy.com/) | No (optional Etsy channel) |

---

## 🛠️ Common Failure Modes & Recovery

### 1. Database Corruption (File Read Failures)
- **Symptom**: Server logs show `SyntaxError: Unexpected end of JSON input` or file lock errors.
- **Cause**: Unexpected system power down during write operations.
- **Remediation**: The system implements self-healing. It will automatically load the corresponding `.bak` file (e.g., `data/listings-history.json.bak`) if the primary file fails to parse. If manual restoration is required:
  ```powershell
  copy data/listings-history.json.bak data/listings-history.json
  ```

### 2. Circuit Breaker Tripping (429/Network Errors)
- **Symptom**: Dashboard shows `RATE_LIMITED` and calls to eBay or external platforms fail instantly.
- **Cause**: Rate limit exceeded on third-party APIs.
- **Remediation**: The circuit breaker automatically resets after 60 seconds of silent cool-down. If you need to force reset it manually during testing, restart the process manager:
  ```powershell
  # Press Ctrl+C in terminal, then run:
  node start.js
  ```

### 3. Watcher Daemon Exiting on Locked Files
- **Symptom**: Process manager logs show Watcher Daemon crashing.
- **Cause**: Windows holds file locks on large images during drag-and-drop operations.
- **Remediation**: The system contains a stability filter that waits for file sizes to stop changing for 2 seconds before reading. If issues persist, ensure the directory has full write permissions.

---

## 💾 Backup & Restore Procedure

Since Lister Pro stores data in clean flat JSON files under `data/`, backing up and restoring is simple:

### Create Backup
Zip the `data/` folder or copy it to a secure backup directory:
```powershell
Compress-Archive -Path data/ -DestinationPath data-backup.zip
```

### Restore Backup
Unzip the backup file into the project root directory:
```powershell
Expand-Archive -Path data-backup.zip -DestinationPath . -Force
```

---

## 🤝 Contractor Onboarding Instructions

To hand this project off to a contract developer:
1. Provide access to the repository.
2. Instruct them to read `docs/founder/RUNBOOK.md` and `docs/API.md`.
3. Provide them with standard sandbox API keys (Google Gemini sandbox key, eBay Sandbox credentials).
4. Run `npm test` to verify their setup is fully correct.
