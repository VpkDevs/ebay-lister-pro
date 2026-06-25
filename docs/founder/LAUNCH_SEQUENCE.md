# Launch Sequence — eBay Multi-Channel Lister Pro

This document provides the timestamped launch sequence checklist for our launch day.

---

## 📅 Launch Date: 2026-07-07 (Tuesday)

All times are in **US Central Time (CT)**.

---

## 🛠️ T-7 Days — Tuesday 2026-06-30

- [ ] **09:00 CT** — Run final pre-flight checks locally to verify all server endpoints:
  ```powershell
  node scratch/run-preflight.js
  ```
- [ ] **10:00 CT** — Send warmup DMs to micro-influencers and pre-launch supporters.
- [ ] **14:00 CT** — Verify Docker build locally:
  ```powershell
  docker build -t ebay-lister-pro .
  ```

---

## 🛠️ T-1 Day — Monday 2026-07-06

- [ ] **09:00 CT** — Complete asset check: Verify all copy, links, and screenshots in `LAUNCH_SCRIPTS.md` are correct.
- [ ] **12:00 CT** — Test Stripe billing in test mode to ensure webhooks resolve successfully.
- [ ] **16:00 CT** — Commit and push a `launch-ready-v1.0.0` tag to the git repository:
  ```powershell
  git tag launch-ready-v1.0.0; git push origin launch-ready-v1.0.0
  ```
- [ ] **18:00 CT** — Open the war-room monitoring logs:
  ```powershell
  node start.js
  ```

---

## 🚀 T-0 Day — Tuesday 2026-07-07 (LAUNCH DAY)

- [ ] **02:01 CT (00:01 PST)** — **Product Hunt Launch goes live!**
  - Submit the draft listing via the Product Hunt console.
  - Verification: Open `https://www.producthunt.com/posts/ebay-lister-pro` and check for 200 OK.
- [ ] **06:00 CT** — **Post Twitter Launch Thread**.
  - Publish the pre-written Twitter thread. Pin the first tweet to your profile.
- [ ] **09:00 CT** — **Submit Hacker News Show HN**.
  - Submit the HN thread (HN does not have an API, must be done manually).
- [ ] **10:00 CT** — **Submit r/flipping story thread**.
  - Post the story-driven development diary to r/flipping.
- [ ] **12:00 CT** — **Submit r/ebay thread**.
  - Post the VeRO check guide to r/ebay.
- [ ] **14:00 CT** — **Send micro-influencer outreach emails**.
  - Send pitches to targeted YouTube/Twitter resellers.
- [ ] **18:00 CT** — Run T+0 metrics check: Count impressions, active drafts, and Stripe conversions.

---

## 📈 Post-Launch

### T+1 Day — Wednesday 2026-07-08
- [ ] **09:00 CT** — Post thank-you thread on Twitter sharing launch statistics.
- [ ] **12:00 CT** — Reply to comments on Hacker News, Reddit, and Product Hunt.

### T+3 Days — Friday 2026-07-10
- [ ] **18:00 CT** — Run T+72h retrospective: Close war-room monitoring, catalog feedback, and transition to Growth Engine.
