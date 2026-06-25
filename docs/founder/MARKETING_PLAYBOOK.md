# Marketing Playbook — eBay Multi-Channel Lister Pro

This playbook details the strategy, personas, execution workflows, and tracking metrics for our post-launch marketing engine.

---

## 🎯 Target Reseller Personas

We target three distinct reseller segments who experience the pain of cross-listing fees and tool bloat:

### 1. The Part-Time Flipping Hustler
- **Profile**: Side-hustle reseller selling 50–150 items a month on eBay. Looking to expand to Shopify to build a brand, but can't justify Vendoo's $29–$49/month plans.
- **Key Pain**: Subscription overhead cutting into narrow margins.
- **Lister Pro Hook**: *"100% Free self-hosted tier. Cross-list without recurring monthly bills."*

### 2. The Full-Time Multichannel Merchant
- **Profile**: Professional seller with 1,000+ items in inventory. Runs eBay and a custom Shopify storefront. Needs automated double-sell protection so they don't get negative feedback.
- **Key Pain**: Double-selling items, inventory desync, laggy sync queues.
- **Lister Pro Hook**: *"Lightning-fast local synchronization with concurrent Promise-backed DLQ retries. Instant double-sell prevention."*

### 3. The Tech-Savvy Reseller / Developer
- **Profile**: Reseller who knows how to run a terminal. Appreciates clean, local-first code, data security, and zero npm dependencies.
- **Key Pain**: Bloated chrome extensions, privacy concerns (third parties holding store API keys).
- **Lister Pro Hook**: *"Your store keys stay in your local .env file. Zero telemetry. Starts in 10ms."*

---

## 📊 Acquisition Channels & Weekly Workflow

Lister Pro leverages a 3-pillar organic acquisition engine:

### 1. Niche Communities (Reddit / Discord)
- **Workflow**: Monitor `r/flipping`, `r/ebay`, and e-commerce Discord servers.
- **Rules of Play**: Follow a 9:1 value-to-promo ratio. Answer tax, shipping, and listing aspect questions first. Only mention Lister Pro when someone complains about Vendoo/ListPerfected pricing or Shopify sync failures.

### 2. Micro-Influencer Partners
- **Workflow**: Target YouTube/Twitter reseller channels with 2K–30K subscribers.
- **Pitch Value**: Provide them with a free premium license key in exchange for an honest video walk-through of the GDI+ watermarking or Gemini Vision aspect extractor.

### 3. Technical Build-in-Public Content (Twitter/X & Show HN)
- **Workflow**: Share codebase lessons, benchmarks (e.g., "how we resize images natively without sharp or canvas"), and daily active merchant statistics.

---

## 📈 Marketing Metrics & KPIs

We track these metrics weekly in the `growth_log.md` file:

| Metric | Source | Launch Target | Steady State Target |
|---|---|---|---|
| **Unique Visits** | Plausible / PostHog | 2,000 / week | 5,000 / month |
| **Github Stars** | Github API | 50 | 250 |
| **Extension Installations** | Chrome Web Store | 150 | 500 |
| **Active Listing Syncs** | Admin dashboard | 500 | 5,000 / month |
| **Paid Premium Signups** | Stripe dashboard | 3–5 | 25+ ($500+ MRR) |
