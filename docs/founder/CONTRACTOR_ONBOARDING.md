# Contractor Onboarding — eBay Multi-Channel Lister Pro

This document provides technical instructions, architecture overviews, and standard work statements for outside contractors and developers onboarding onto the Lister Pro project.

---

## ⚡ Product & Architecture Overview

Lister Pro is a lightweight desktop-server application that compiles, cross-posts, and syncs inventory concurrently across **eBay**, **Shopify**, **WooCommerce**, and **Etsy** in under 90 seconds.

### Codebase Components
- `start.js`: Master process runner and watcher launcher.
- `webServer.js`: Serves the dark-themed HTML interface and routes all JSON API requests.
- `ebayClient.js`: Custom REST API wrapper for eBay's OAuth and Inventory/Sell scopes.
- `geminiClient.js`: Google Gemini Vision AI endpoint client for aspect parsing and barcode matching.
- `crossPost.js`: Concurrent cross-posting Promise queues.
- `utils.js`: Core helpers (secure JSON file reader/writer, structured audit logger, barcode validation).

---

## 💻 Running Locally

### Prerequisites
- Node.js >= 18.0.0

### Run Commands
1. Copy template configuration:
   ```powershell
   cp .env.example .env
   ```
2. Configure active API keys in `.env` (Gemini, eBay, Shopify, Etsy, WooCommerce).
3. Start the application server and directory watcher daemon:
   ```powershell
   node start.js --watch
   ```
4. Access the web dashboard at: `http://localhost:45900`
5. Run the full unit/integration test suite:
   ```powershell
   node test-suite.js
   ```

---

## 🗄️ Database & Storage Specs

Lister Pro does not use external database engines (like PostgreSQL or MongoDB) or local SQLite. We utilize a **self-healing, local-first flat JSON database** located in:
- `data/history.json` (Listings history database)
- `data/drafts.json` (Draft items)
- `data/logs.json` (Trace logs)

File access is managed using **file-locking reader/writer queues** in `utils.js` to prevent race conditions during concurrent cross-posts. If file corruption is detected on read, the server automatically recovers from the corresponding `.bak` replica file.

---

## 📋 Definition of "Done" for Tasks

For any pull request or task to be marked complete:
1. **Zero Dependencies**: Do not install any external npm packages. Use native Node.js core modules only.
2. **Test Coverage**: Every new API endpoint or client feature must include corresponding assertions in `test-suite.js`.
3. **Types & Validation**: Cast inputs strictly (integers, strings) and validate payloads against schemas.
4. **Structured Logs**: Propagate `traceId` using AsyncLocalStorage store contexts for auditing.

---

## 📄 Statement of Work (SOW) Templates

### 1. SOW Template: Bug Fixes (Target Rate: $75/hr)
> **Objective**: Resolve specific bug ID (e.g., watch daemon file lock jam).
> **Deliverables**: Commit fix to master, write regression test in `test-suite.js`, verify `git status` clean, run dry-run script.
> **Done Gate**: 74/74 tests pass.

### 2. SOW Template: Feature Addition (Target Rate: $120/hr)
> **Objective**: Implement new cross-listing channel (e.g., Mercari export templates).
> **Deliverables**: Create client module, integrate route in `webServer.js`, add mock endpoint tests in `test-suite.js`.
