# Privacy Policy

Last Updated: June 25, 2026

Vincent Kinney ("we", "us", or "our") operates **eBay Multi-Channel Lister Pro** ("the Service"). This Privacy Policy explains what data we collect, how it is used, and your rights under GDPR and CCPA.

---

## 1. Information We Collect

We limit collection to what is technically necessary to perform multi-channel reselling operations:
- **Profile Information**: Email address, name, and profile picture collected via Google Accounts OAuth.
- **Listing Drafts & Data**: Product titles, descriptions, SKU, UPC barcodes, item condition, pricing data, brand, model, and local image file paths.
- **Integration Credentials**: API keys and tokens for eBay, Shopify, WooCommerce, and Etsy (stored locally in your environment `.env` file).
- **Billing Details**: Stripe subscription IDs and premium tier flags.
- **Audit Logs**: Timestamps, requested endpoints, client IP addresses, and HTTP headers stored locally.

---

## 2. How We Share Your Data (Third-Party Processing)

We share data with third-party processors only to execute listing operations:
1. **Google Gemini API**: Image files and listing text inputs are sent to Google Gemini to extract metadata and perform defect analysis.
2. **Stripe**: Billing transactions and subscription statuses are processed directly by Stripe.
3. **Connected Marketplaces**: Your credentials and product payloads are sent directly to the marketplace APIs you configure (eBay, Shopify, WooCommerce, Etsy).
4. **Temporary Image Hosts**: Product images are uploaded temporarily to `tmpfiles.org` or `file.io` to generate remote image URLs required by marketplace publishing systems.

---

## 3. Data Retention & Deletion Rights (GDPR/CCPA)

- **Local Storage**: All draft history and logs reside locally on your host environment. You can wipe this data at any time by deleting the files inside the `data/` directory.
- **GDPR Right to Erasure**: You have the right to request deletion of all profile data and billing subscription mappings.
- **Self-Service Deletion**: You can request immediate deletion of your active session and billing record directly through the `/api/user/account` endpoint.

---

## 4. Contact Information
For any data inquiries, privacy questions, or erasure requests, contact:
- **Email**: privacy@ebaylisterpro.local
- **Operator**: Vincent Kinney
