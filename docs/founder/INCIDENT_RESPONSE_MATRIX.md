# Incident Response Matrix — eBay Multi-Channel Lister Pro

This document defines the severity classifications, detection mechanisms, and recovery playbooks for outages, failures, and bugs during and after launch.

---

## 🚨 Incident Severity Definitions

| Severity | Impact | SLA (Detect) | SLA (Resolve) | Primary Action |
|---|---|---|---|---|
| **P0 (Critical)** | Core application offline, database corruption, or payments entirely broken. | < 5 mins | < 30 mins | Execute emergency rollback script and post status page update. |
| **P1 (High)** | Single-channel integration down (e.g., eBay API offline, Shopify sync failing), or OAuth logins failing. | < 15 mins | < 2 hours | Hotfix, alert channel users, or queue sync actions in DLQ. |
| **P2 (Medium)** | Non-blocking feature failure (e.g., GDI+ image watermarking slow, comp price lookup returns 0). | < 1 hour | < 12 hours | Queue bugfix, apply local workarounds, document transient issue. |
| **P3 (Low)** | UI alignment issue, copy typos, or non-critical documentation mismatches. | < 4 hours | < 48 hours | Standard git commit and routine deployment. |

---

## 🚦 Contingency & Playbook Matrix

| Incident | Detection Metric / Trigger | Target Platform Action | Manual Operator Fallback Action |
|:---|:---|:---|:---|
| **Downtime (Core Server Offline)** | Healthcheck `/health` returns non-200 or times out for 2+ consecutive checks. | Auto-redeploy current revision on hosting platform; if fail, trigger `scripts/rollback.sh` to stable tag. | Verify hosting dashboard (Railway/Render); toggle DNS in Cloudflare to static maintenance page. |
| **Database Corruption (JSON File Lock Jam)** | `database-error` or `corruption-alert` in server stdout logs. | Self-healing script restores `.bak` replicas automatically on boot. | Stop start.js; inspect database files in `/data`; manually rename latest `.bak` to `.json`. |
| **Stripe Webhook Verification Failure** | 400 Bad Request returned on `/api/payments/webhook`. | Ignore unverified payload to prevent fraud; log payload signature error. | Check Stripe dashboard for webhook signing secret update; update environment variable `STRIPE_WEBHOOK_SECRET`. |
| **eBay API Token Outage** | 401 Unauthorized / expired token returned from eBay client. | Automatically trigger OAuth token refresh flow. | Direct the merchant to the Settings panel to click "Re-authenticate eBay Account". |
| **Shopify / WooCommerce / Etsy Webhook Lags** | Cross-posting sync queue processing delay > 5 minutes. | Store items in Dead-Letter Queue (DLQ); execute automatic retry backoff. | Check `/api/admin/dlq` dashboard; click "Retry All Pending Synchronizations". |
| **API Rate Limits Exceeded (Gemini / eBay)** | 429 Too Many Requests received. | Dynamic rate-limiting wrapper activates backoff delay; pauses automated scans. | Enable basic local image parsing (fallback mode); instruct users to supply their own Gemini API Keys. |
| **Negative Launch Feedback / Spammer Attack** | Rapid comment alerts on Hacker News, Reddit, or Product Hunt. | Alert creator via monitoring channel (Discord/Email). | Reference `WAR_ROOM_RESPONSES.md`; copy-paste the pre-drafted measured technical response. |

---

## 🛠️ Auto-Rollback Execution Protocol

If a P0 incident is detected and cannot be resolved with a hotfix within 15 minutes, execute the emergency rollback sequence:

### Step 1: Run the rollback script
From the project workspace root:
```powershell
./scripts/rollback.sh
```

### Step 2: Manually trigger git checkout (fallback)
If the automated script fails, run:
```powershell
git fetch --tags
git checkout launch-ready-v1.0.0
# For Railway deployment:
railway redeploy
```

### Step 3: Broadcast status update
Update the status banner on the landing page or post an incident card:
> *"We are currently experiencing a system disruption. The team is actively investigating. Sync queues are held and will resume shortly once services are fully restored."*

---

## 📢 Outage Communication Templates

### 1. Core Platform Downtime (Email & Socials)
> **Subject**: System Interruption Update - eBay Lister Pro
>
> **Body**:
> "Hi everyone, eBay Multi-Channel Lister Pro is currently experiencing an unexpected outage. Our self-healing systems are active, and we are working to restore complete availability.
> 
> Rest assured: your active listings on eBay, Shopify, and Etsy are safe, and the background synchronization has been paused to prevent any duplicate sales or inventory desync.
> 
> You can check progress directly on our status updates page. Thank you for your patience."

### 2. eBay API Sync Issue (SaaS Interface Banner)
> **Banner Text**:
> "⚠️ **Notice**: eBay API authentication is temporarily disrupted. New listings will queue locally and post automatically once the integration is re-established. Shopify and WooCommerce sync remain fully functional."
