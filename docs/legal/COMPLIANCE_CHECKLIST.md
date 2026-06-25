# Compliance Checklist

This checklist tracks ongoing compliance obligations and audit points for **eBay Multi-Channel Lister Pro**.

---

## 🚦 Regulatory Audits & Status

### 1. FTC AI & Marketing Compliance
- [x] AI-generated disclaimer text placed adjacent to comp results and suggestions.
- [x] Clear warning to verify pricing, aspects, and category suggestions manually.
- [x] Marketing claims (e.g., in README/landing page) verified to avoid inflating AI accuracy.

### 2. GDPR/CCPA Data Governance
- [x] Implemented `DELETE /api/user/account` endpoint to wipe user session and Stripe mapping.
- [x] Privacy Policy specifically names third-party services (Stripe, Google OAuth, Gemini, Shopify, Etsy, WooCommerce).
- [x] Data storage uses secure file locks and clean local folder separation.

### 3. IP and DMCA Copyright Actions
- [x] DMCA designated legal agent information listed in the Terms of Service.
- [x] DMCA notice format requirement instructions documented.
- [x] VeRO case-insensitive check library updated with 30+ top restricted brands to prevent intellectual property violations on drafts.

---

## 📅 Actionable Checklist

| Compliance Area | Action Required | Frequency | Target |
|---|---|---|---|
| Privacy Policy Review | Update third-party processors if new channels are integrated | Annual | Vincent Kinney |
| VeRO Brand List | Fetch and update restricted eBay brand list | Quarterly | Automated script |
| GDPR Data Requests | Process incoming erase/delete requests within 30 days | On-demand | `DELETE /api/user/account` |
| Cookie Consent Review | Check if tracking pixels are added | On-demand | Developer |
