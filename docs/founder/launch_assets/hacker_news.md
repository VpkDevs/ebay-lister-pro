# Hacker News Show HN Launch Assets — eBay Multi-Channel Lister Pro

---

## 1. Thread Details

- **Title**: Show HN: A zero-dependency multi-channel eBay lister written in raw Node.js
- **Link**: `http://127.0.0.1:45900` (or production domain)

---

## 2. Show HN Body Copy

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
