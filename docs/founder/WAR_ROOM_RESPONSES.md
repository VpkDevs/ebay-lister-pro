# War Room Pre-Drafted Responses — eBay Multi-Channel Lister Pro

This document provides 30 pre-drafted, copy-paste responses to common questions, criticisms, and requests across launch channels.

---

## 💻 Product Hunt & General SaaS Questions

### 1. General features & updates
- **Q**: How often is the platform updated?
- **A**: "We update the core repo weekly. Major eBay/Shopify API contract changes are handled immediately to prevent listing failures."

### 2. Pricing tiers
- **Q**: What does the paid premium tier cover?
- **A**: "The free self-hosted edition is fully functional. The premium subscription ($29/mo) unlocks automated security patches and managed cloud-hosting updates."

### 3. Competitor differences
- **Q**: How is this different from Vendoo or Crosslist?
- **A**: "Lister Pro is local-first, zero-dependency, and can be self-hosted entirely on your machine. You own your inventory data without paying high recurring fees."

### 4. Custom integrations
- **Q**: Will you support Poshmark/Mercari auto-listing?
- **A**: "Poshmark and Mercari do not have public listing APIs, so we provide optimized clipboard templates you can copy and paste in under 10 seconds."

### 5. Multi-store support
- **Q**: Can I link multiple eBay or Shopify accounts?
- **A**: "Yes. You can manage multiple profiles by copying the project directory for separate stores, or configuring individual profiles in the dashboard."

### 6. Roadmap
- **Q**: Where can I see the future feature list?
- **A**: "Our roadmap is tracked in the repository's `README.md`. We prioritize double-selling syncs and aspect enforcements."

### 7. Support
- **Q**: Where do I submit bugs?
- **A**: "Please submit issues directly on our GitHub repository. For urgent support, premium subscribers can email support@ebaylisterpro.local."

### 8. Billing issues
- **Q**: Can I cancel my subscription easily?
- **A**: "Yes. You can manage and cancel subscriptions anytime via the Stripe Customer Portal link inside the dashboard settings."

### 9. Platform limits
- **Q**: Is there a limit on how many drafts I can save?
- **A**: "No. Since drafts are stored locally in flat JSON files, you are only limited by your machine's hard drive space."

### 10. Bulk uploads
- **Q**: Can I bulk-upload 100 images?
- **A**: "Yes. The background watcher daemon can process large clusters of images concurrently, dividing them into drafts based on photo timestamps."

---

## 🛠️ Hacker News & Technical Questions

### 11. Why no npm dependencies?
- **Q**: Why avoid standard packages like Express or SQLite?
- **A**: "To guarantee lightweight execution and security. Fewer dependencies means no security auditing fatigue, zero dependency drift, and sub-10ms startup times."

### 12. Local file locks
- **Q**: How do you prevent database corruption on concurrent writes without SQLite?
- **A**: "We implement custom reader/writer file locks in `utils.js` that block concurrent file write streams and automatically fall back to `.bak` files on read errors."

### 13. Image resizing implementation
- **Q**: Why use PowerShell for image watermarking/resizing?
- **A**: "Since the tool runs locally on Windows, leveraging the native GDI+ API via spawned PowerShell processes avoids compiling heavy C++ binary dependencies like Sharp."

### 14. Google OAuth security
- **Q**: How are session cookies secured?
- **A**: "We set HttpOnly, SameSite=Lax session cookies and strictly bind API calls to localhost origins via CORS checks."

### 15. Memory leaks
- **Q**: How does the watcher daemon handle long-running resource spikes?
- **A**: "All file streams are closed immediately after operations, and the directory stability checks prevent holding locks on half-transferred images."

### 16. Rate limit metrics
- **Q**: How does the token bucket limiter work under heavy loads?
- **A**: "It decays tokens chronologically inside a local memory Map. Exceeding limits returns a standard 429 status instantly."

### 17. Multi-threading
- **Q**: Does the server utilize worker threads?
- **A**: "The process manager (`start.js`) spawns the Web Server and the Watcher Daemon as separate OS-level processes, distributing load across cores."

### 18. Windows portability
- **Q**: Can this run on macOS or Linux?
- **A**: "Yes. The Node.js server and extension are cross-platform. The GDI+ image sprucer is PowerShell-based, but we fallback to native image dimensions on Linux/macOS."

### 19. Why HTTP instead of HTTP/2?
- **Q**: Why did you write a native HTTP/1.1 server?
- **A**: "For local dashboard usage, HTTP/1.1 is extremely fast and avoids the certificate configuration complexity of HTTP/2 loopbacks."

### 20. Code quality check
- **Q**: What testing suite are you running?
- **A**: "We use Node's native `node:test` runner. All 74 unit and integration tests execute mock networks and file operations in under 9 seconds."

---

## 📦 Reddit & Reseller Questions

### 21. Free tier limitations
- **Q**: Does the free version limit listing count?
- **A**: "No. The free edition has no limits on listings, channels, or inventory syncs. It is fully functional."

### 22. What is VeRO?
- **Q**: How does the VeRO brand check work?
- **A**: "eBay maintains a Verified Rights Owner (VeRO) program. Lister Pro checks your listing title against a case-insensitive brand blacklist and warns you before posting."

### 23. Double-selling sync delay
- **Q**: How fast does it end listings if an item sells?
- **A**: "The background daemon checks for inventory updates every 5 minutes. If a sale occurs, it closes the corresponding listings on other channels."

### 24. Shopify inventory levels
- **Q**: Does it update Shopify inventory numbers?
- **A**: "Yes. During cross-listing, the tool retrieves your location ID and sets the variant stock quantity directly."

### 25. Comps pricing outliers
- **Q**: How does the pricing comp search filter high/low anomalies?
- **A**: "We calculate the Interquartile Range (IQR) of active comps, and exclude prices below `Q1 - 1.5 * IQR` or above `Q3 + 1.5 * IQR` to calculate realistic market rates."

### 26. Etsy title limit
- **Q**: Does it handle Etsy's 140 character limit?
- **A**: "Yes. Etsy titles are automatically sanitized and truncated to exactly 140 characters to prevent API validation errors."

### 27. WooCommerce REST credentials
- **Q**: Where do I find WooCommerce API keys?
- **A**: "Navigate to WooCommerce > Settings > Advanced > REST API inside your WordPress dashboard to generate Consumer Key/Secret pairs."

### 28. Extension installation
- **Q**: How do I install the extension on Chrome?
- **A**: "Enable Developer Mode in `chrome://extensions/`, click 'Load unpacked', and select the project's `chrome-extension/` directory."

### 29. Can I run it on a VPS?
- **Q**: Can I run this on a remote server like Railway or Render?
- **A**: "Yes. The codebase includes a Dockerfile and railway.toml for instant remote deployment."

### 30. How do I get updates?
- **Q**: How do I update to the latest code version?
- **A**: "Run `git pull origin master` in your terminal to fetch and merge the latest upgrades."
