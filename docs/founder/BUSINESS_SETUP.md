# Business Setup — eBay Multi-Channel Lister Pro

This document details the recommended legal structure, banking setup, accounting procedures, and exit readiness parameters for Lister Pro.

---

## 🏢 Entity Recommendation & Formation Guide

For a solo founder operating from US Central Time (Vince Kinney) with projected SaaS subscription revenues, we recommend forming a **Single-Member LLC** in Texas.

- **Recommended Structure**: Texas Single-Member LLC
- **Reasoning**: It shields personal assets from business liabilities, provides pass-through taxation, is simple to maintain, and has lower annual fees compared to Delaware for local residents. If you decide to raise venture capital later, you can easily convert this LLC into a Delaware C-Corporation.
- **Estimated Setup Cost**: $300 (State filing fee) + $50 (Optional name reservation/helper tools).
- **Timeline**: 3–5 business days.

### Step-by-Step Formation Action Plan

1. **Name Availability Search**:
   - Go to [Texas SOS Direct](https://www.sos.state.tx.us/corp/sosdirect/index.shtml) to search for "eBay Multi-Channel Lister Pro LLC" or "Lister Pro LLC".
2. **File Articles of Organization**:
   - Submit Form 205 (Certificate of Formation) online via [Texas SOSUpload](https://www.sos.state.tx.us/corp/index.shtml).
   - Fee: $300.
3. **Obtain an EIN (Employer Identification Number)**:
   - Apply online for free on the [IRS EIN Assistant](https://www.irs.gov/businesses/small-businesses-self-employed/apply-for-an-employer-identification-number-ein-online).
   - Timeline: Instant on approval.
4. **Draft an Operating Agreement**:
   - Establish that you are the sole member with 100% ownership and manager authority.

---

## 🏦 Banking & Payout Separation

Keep business transactions completely separate from personal spending to protect your LLC liability shield.

- **Business Checking Account**: **Mercury Bank** (https://mercury.com)
  - *Why*: Built for startups and software founders. Zero monthly fees, zero minimum balances, free domestic wires, and a robust API for automated accounting sync.
- **Business Savings**: **Mercury Vault**
  - *Why*: Automatically routes excess cash into high-yield funds.
- **Credit Card**: **Chase Ink Business Cash** (or Spark Cash Plus)
  - *Why*: 2% to 5% cashback on software/telecom subscriptions, perfect for API fees (Gemini, hosting).

---

## 📊 Accounting & Bookkeeping Setup

- **Tool Recommendation**: **QuickBooks Simple Start** (or Wave Accounting for a free tier).
- **Chart of Accounts to Configure**:
  - `Income`: SaaS Subscriptions (Stripe payouts)
  - `Expense - Software / API`: Google Gemini API, eBay Developer fees, Shopify / Etsy developer account renewals.
  - `Expense - Hosting / Infrastructure`: Railway / Vercel hosting charges, domain names.
  - `Expense - Marketing`: Plausible Analytics, content calendar scheduling tools, micro-influencer product codes.

---

## 📈 S-Corp Election Timing Math

When net business profits grow, self-employment taxes (15.3%) become a heavy burden. Electing S-Corp status allows you to pay yourself a reasonable salary and take the rest as distributions, escaping self-employment tax on distributions.

```text
Self-employment tax savings from S-Corp:
  At $50,000 profit: Break-even (S-Corp admin costs equal tax savings)
  At $100,000 profit: Save ~$3,500/year (Tax savings minus payroll processing fees)
  At $150,000 profit: Save ~$7,000/year
```

- **Recommendation**: Maintain a sole-prop LLC initially. Once net business profit reaches **$80,000/year**, file Form 2553 to elect S-Corp tax status.

---

## 📉 Acquisition Readiness & Exit Strategy

Lister Pro fits the **Developer Tool / Niche SaaS** profile. Buyers pay a premium for local-first apps due to low maintenance overhead and high margins.

### Initial Acquisition Readiness Score: 60/100

- **Documentation (15/20)**: Clean RUNBOOK.md and API.md, but lacks investor templates.
- **Revenue Quality (10/20)**: Pre-revenue. Subscription SaaS tier planned via Stripe.
- **Bus Factor (15/15)**: 100%. The app is designed as a zero-maintenance local desktop engine.
- **Growth Rate (5/15)**: Pre-launch.
- **Clean Books (10/15)**: Setup planned, pending actual Stripe transaction logs.
- **IP Ownership (5/15)**: Base codebase complete and clean, but needs official trademark filing.

### Steps to Reach 85+ Score (Premium Multiple)
1. Launch Stripe billing and secure the first 10 paying subscribers (Revenue Quality).
2. Maintain a clean, structured ledger of operating expenses (QuickBooks) for 3 months (Clean Books).
3. Secure the `Lister Pro` brand trademark (IP Ownership).
