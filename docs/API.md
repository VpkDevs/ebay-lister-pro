# ListAI Pro — API Documentation

The HTTP API exposed by `webServer.js` (default port **45900**, override with `PORT`).

> Regenerated in the Atlas round-4 run (2026-10-26) from the actual route
> handlers in `webServer.js`. The previous version described a removed
> "local authentication mode" and a product name that is no longer used.
> The endpoint inventory below is complete (66 method+path pairs); detailed
> request/response notes are included for the primary flows and were
> verified live or against the test suite during the run.

---

## Authentication & Rate Limits

Two identities exist:

1. **Google session** — a `sessionId` cookie issued by `/api/auth/google/callback`
   after Google Sign-In. Requires `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
   If Google Sign-In is not configured, the login route fails closed (503
   `LOGIN_NOT_CONFIGURED`) — it never mints a session.
2. **Operator API key** — the `x-lister-api-key` header (or `?apiKey=`) is
   accepted **only** when the operator has configured `API_KEY`. There is no
   shipped default key: an unconfigured deployment accepts no key, and a bare
   or wrong header never authenticates. This identity represents the operator
   (used by the Chrome extension) and is premium.

Enforcement, precisely:

- A global gate requires one of the above identities for every non-open
  route **when `GOOGLE_CLIENT_ID` is configured**.
- Generation, billing, team, BYOK-key, and config routes additionally check
  the identity **inside the handler** and refuse anonymous calls (401
  `LOGIN_REQUIRED`) in every configuration. `/api/config/save` gained its
  in-handler check in the Atlas round-4 run — before it, the route relied
  solely on the conditional global gate and rewrote deployment secrets for
  anonymous callers in clean-env boots.
- **Operational consequence:** a production deployment MUST set
  `GOOGLE_CLIENT_ID` (plus `APP_URL` and `GOOGLE_REDIRECT_URI` matching the
  real port/host) — without it, routes that rely on the global gate alone
  are unauthenticated. See `docs/founder/RUNBOOK.md`.

Open routes (no identity): `/health`, `/api/status`, `/api/metrics`,
`/api/auth/google/login`, `/api/auth/google/callback`, `/api/billing/webhook`
(Stripe-signature verified instead), and the static pages.

Rate limiting (token bucket, per client IP): standard routes — capacity 60,
refill 1/sec; `POST /api/analyze` — capacity 5, refill 5 per 60s.

---

## Primary flows

### `POST /api/analyze` — photo → listing generation (metered)
Body: `{ images: [data-URL or URL, ...], ... }`. Requires an authenticated
user. Counts 1 against the caller's monthly allotment when it completes
(Pro 300/mo, Power Seller 1,000/mo; free accounts generate only on their own
saved Gemini key, 10/mo). Anonymous → 401 `LOGIN_REQUIRED`. At cap without a
saved key → 403 (`LISTING_LIMIT_REACHED` / `SUBSCRIPTION_REQUIRED`). Runs
without any eBay connection — eBay is only needed at publish time.

### `GET /api/ebay/import?itemIdOrUrl=...` — import or keyword generation
Imports an existing eBay item by ID/URL (not a generation). On a miss, falls
back to AI keyword generation, which is metered exactly like `/api/analyze`
and refuses anonymous callers.

### Billing
- `POST /api/billing/create-checkout-session` `{ plan: "pro" | "power_seller" }`
  → `{ url }`. Fails closed (503 `BILLING_NOT_CONFIGURED`) when Stripe is not
  configured — there is no mock checkout. Amounts come from the plan config
  (Pro $19.00, Power Seller $49.00) and the session carries `metadata.plan`.
- `POST /api/billing/webhook` — Stripe webhook. Signature-verified whenever
  Stripe is configured; unsigned or unverifiable events are rejected.
  Handles checkout completion, subscription sync, cancellation, and
  past-due revocation.
- `POST /api/billing/cancel`, `POST /api/billing/portal` — act on the
  signed-in user's own subscription only (in-handler identity check).

### BYOK (bring your own key)
- `GET /api/user/gemini-key` → masked status only (never returns the key).
- `POST /api/user/gemini-key` `{ apiKey }` — saves the caller's own Gemini key.
- `DELETE /api/user/gemini-key` — clears it.
A rejected user key produces a coded error (`USER_KEY_REJECTED` /
`USER_KEY_FAILED`); generation never falls back to the house key silently.

### `POST /api/config/save` — operator configuration (secrets)
Writes allow-listed keys to `.env` + `process.env` (Stripe, Gemini, eBay,
marketplace tokens, preferences). **Requires an authenticated user
(session or operator key) in every configuration** — see the auth section
for the history. First-run local setup should use `node bootstrap.js`,
which writes `.env` directly.

### `GET /health`
Rich health report: `{ status, timestamp, version, details: { storage, system, ... } }`.

---

## Complete endpoint inventory

Auth key: **Open** = no identity · **Handler** = identity checked inside the
route handler (all configurations) · **Gate** = identity required via the
global gate (only when `GOOGLE_CLIENT_ID` is configured — see warning above).

| Method | Path | Auth |
|---|---|---|
| GET | /api/status | Open |
| GET | /api/metrics | Open |
| GET | /api/auth/google/login | Open |
| GET | /api/auth/google/callback | Open |
| POST | /api/billing/webhook | Open (Stripe signature) |
| POST | /api/analyze | Handler |
| GET | /api/analyze | Gate |
| GET | /api/ebay/import | Handler (AI fallback) |
| POST | /api/billing/cancel | Handler |
| POST | /api/billing/portal | Handler |
| GET | /api/team | Handler |
| POST | /api/team/invite | Handler |
| POST | /api/team/remove | Handler |
| POST | /api/team/accept | Handler |
| POST | /api/team/leave | Handler |
| GET | /api/user/gemini-key | Handler |
| POST | /api/user/gemini-key | Handler |
| DELETE | /api/user/gemini-key | Handler |
| POST | /api/config/save | Handler (since Atlas R4) |
| GET | /api/auth/session | Gate |
| POST | /api/auth/logout | Gate |
| GET | /api/auth/ebay/login | Gate |
| GET | /api/auth/ebay/callback | Gate |
| POST | /api/billing/create-checkout-session | Gate (+ handler billing checks) |
| GET | /api/categories/search | Gate |
| GET | /api/dlq | Gate |
| POST | /api/dlq/action | Gate |
| POST | /api/dlq/process | Gate |
| POST | /api/draft/autosave | Gate |
| GET | /api/ebay/aspects | Gate |
| GET | /api/ebay/conditions | Gate |
| GET | /api/ebay/location | Gate |
| POST | /api/ebay/location | Gate |
| GET | /api/ebay/marketing/summary | Gate |
| GET | /api/ebay/policies | Gate |
| POST | /api/end-listing | Gate |
| POST | /api/enhance | Gate (+ handler generation checks) |
| GET | /api/history | Gate |
| DELETE | /api/history | Gate |
| POST | /api/images/import-urls | Gate |
| GET | /api/images/spruce | Gate |
| POST | /api/images/spruce | Gate |
| POST | /api/listings/bulk-status | Gate |
| GET | /api/listings/export.csv | Gate |
| POST | /api/listings/import | Gate |
| POST | /api/export/mercari | Gate |
| POST | /api/export/poshmark | Gate |
| GET | /api/logs | Gate |
| POST/DELETE | /api/logs | Gate |
| GET | /api/logs/stream | Gate |
| GET | /api/notifications | Gate |
| POST | /api/notifications/dismiss | Gate |
| POST | /api/offers/auto-send | Gate |
| POST | /api/publish | Gate (+ handler checks) |
| POST | /api/publish-draft | Gate (+ handler checks) |
| POST | /api/publish/etsy | Gate |
| POST | /api/publish/woocommerce | Gate |
| POST | /api/relist | Gate |
| POST | /api/repricer | Gate |
| POST | /api/repricer/run | Gate |
| POST | /api/save-draft | Gate |
| POST | /api/sync | Gate |
| GET | /api/templates | Gate |
| POST | /api/templates | Gate |
| DELETE | /api/user/account | Gate |
| GET | /api/vero-brands | Gate |

Static/open pages: `/` (dashboard), `/landing`, `/press`, `/terms`, `/privacy`, `/health`.
