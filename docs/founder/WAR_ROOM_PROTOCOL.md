# War Room Protocol — eBay Multi-Channel Lister Pro

This document governs live-ops monitoring and response playbooks for launch day (T+0) through T+72h.

---

## 👁️ Live Monitoring Routine

During the first 72 hours post-launch, monitor the following metrics every 2 hours:
1. **Server Status**: Run `/api/status` and verify output is `CONNECTED` with diagnostics `OK`.
2. **Process Health**: Check that `start.js` has not logged any crashes or process restarts.
3. **Queue Health**: Check `data/pending-syncs.json` (DLQ) for failed syncs. If items are present, review logs in `data/lister-audit.log`.
4. **User Sessions**: Check `/api/metrics` for request counts and latency distribution.

---

## 🛠️ Live Objection & Comment Playbook

When responding to posts or comments on Hacker News, Reddit, or Product Hunt:
1. **Be polite, open, and transparent**: Avoid defensive language. Acknowledge valid criticisms.
2. **Clarify tech stack choices**: Explain that the zero-dependency model is an architectural design constraint to guarantee performance and security, not a shortcut.
3. **Address pricing objections**: Reiterate that the local core tool is free and open-source. The premium tier is purely optional for users who want hosted SaaS updates.

---

## 🚨 Escalation Paths

- **P0 Incidents** (Server crash, data corruption, Stripe webhook signature failures):
  - Action: Execute the auto-rollback script immediately.
  - SLA: Diagnose in 5 minutes, resolve or roll back in 30 minutes.
- **P1 Incidents** (Third-party API changes, minor layout breakage):
  - Action: Hotfix within 4 hours.
- **P2 Incidents** (Typos, minor aspect suggestions improvements):
  - Action: Address in weekly maintenance cycle.
