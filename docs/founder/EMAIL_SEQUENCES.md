# Automated Onboarding Email Sequences — eBay Multi-Channel Lister Pro

This document contains the copy and templates for our automated customer welcome, onboarding, and upgrade sequences.

---

## 📧 Welcome & Onboarding Drip Campaign

### Email 0: Instant Value (Sent immediately on signup)
- **Subject**: ⚡ Welcome to Lister Pro - Let's get listing
- **Body**:
  ```text
  Hi there,

  Thanks for joining eBay Multi-Channel Lister Pro.

  Lister Pro is designed to help you run a fast, private, and zero-dependency cross-listing engine directly on your computer.

  To start listing immediately, follow these 3 quick steps:
  1. Boot your local app server: `node start.js`
  2. Access your dashboard in your browser: http://localhost:45900
  3. Upload your first inventory photo and let Gemini extract comps.

  All your credentials and history remain in your local .env and database. No cloud leaks. Absolute privacy.

  Need help setting up your eBay or Shopify API keys? Check out the RUNBOOK:
  https://ebaylisterpro.com/docs/runbook

  Happy flippin'!
  ```

---

### Email 1: The First Win (Sent Day 1)
- **Subject**: 🔄 How to sync your first cross-listing in 90 seconds
- **Body**:
  ```text
  Hi reseller,

  Now that you've got Lister Pro running, let's post your first item concurrently to eBay and Shopify.

  Here’s the step-by-step workflow:
  1. Snap a photo of your item and upload it to the dashboard.
  2. Let Gemini Vision extract aspects (like brand, size, and model specifics).
  3. Review the outlier-filtered comp pricing suggestion.
  4. Click "Publish Draft".

  Our Promise-backed parallel queue uploads your item to eBay, Shopify, and Etsy simultaneously. If any platform encounters a network error, it's safe-queued in the Dead-Letter Queue (DLQ) for automatic retry.

  Try listing an item today and see the speed for yourself!
  ```

---

### Email 3: The Secret Feature (Sent Day 3)
- **Subject**: 👁️ How to auto-detect brand restrictions with Gemini Vision
- **Body**:
  ```text
  Hi reseller,

  Getting a VeRO warning on eBay can hurt your seller rating or get your account suspended. 

  Lister Pro includes a built-in safety net.

  We maintain a curated database of 400+ VeRO brand restrictions. When you upload a photo or write a listing title, Lister Pro scans it case-insensitively. If a match is found, it raises an amber warning before you publish.

  It's like having a compliance auditor sitting on your shoulder.

  Upload a draft today to see how the VeRO scan keeps your account safe.
  ```

---

### Email 7: Outlier Pricing Comps (Sent Day 7)
- **Subject**: 📈 Stop guessing your pricing: our outlier-filter comps
- **Body**:
  ```text
  Hi reseller,

  Are you pricing items based on raw averages? 
  Spam listings and statistical outliers can skew your numbers, causing your inventory to sit or sell too cheap.

  Lister Pro handles this differently.

  When checking active eBay comps, our browse query automatically strips out the top and bottom 10% outlier pricing. This calculates a true market average.

  Check out your pricing comp dashboard to see how accurate pricing speeds up inventory turnover.
  ```

---

### Email 14: Re-Engagement (Sent Day 14)
- **Subject**: Are you stuck somewhere? Let's fix it.
- **Body**:
  ```text
  Hi reseller,

  It's been two weeks since you set up Lister Pro. 

  If you haven't published a multi-channel listing yet, you might be hitting a setup block.
  - Setting up eBay Developers keys?
  - Configuring Shopify Private App access?
  - Native Windows GDI+ script issues?

  Reply directly to this email. I read every reply and can walk you through the configuration step-by-step. Let's get your lister running.
  ```

---

### Email 21: Premium Upgrade Offer (Sent Day 21)
- **Subject**: ⚡ Upgrade to Lister Pro Premium (Stripe Active)
- **Body**:
  ```text
  Hi reseller,

  You've been using Lister Pro for three weeks.

  Our self-hosted core will always be free and open-source. But if you want to unlock advanced automated repricing, daily stock photo queries, and automated double-sell protections, consider upgrading to Lister Pro Premium.

  Premium benefits:
  - Daily repricing: automatically undercuts active comps by $0.05.
  - Stock Photo Search: automatically pulls clean retail images.
  - Premium OAuth & Stripe signature webhook integration.

  Upgrade directly in your dashboard with one click.
  ```
