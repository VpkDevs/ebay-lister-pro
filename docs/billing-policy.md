# Billing Policy — ListAI Pro

> Status: **DECIDED** (recorded 2026-10-18, Wave 1A).
> Implementation status: **metering implemented** (2026-10-24, [METERING] in
> webServer.js); **BYOK implemented** (2026-10-26, [BYOK] in webServer.js,
> geminiClient.js, and the Settings view). Per-user monthly generation
> counts and plan-cap enforcement now exist in code: POST /api/analyze and
> the /api/ebay/import Gemini fallback are metered; /api/enhance is not
> (Policy 1). Allotments in code: Pro 300/month, Power Seller 1,000/month,
> Starter 0 — or 10/month when the account has saved its own Gemini key
> (BYOK-gated free tier, Policy 4). Only successful generations consume.
> Counts are keyed by billing account + month; Power Seller seats count
> against the workspace owner's shared pool. <!-- [WAVE1-A] -->
>
> **Hardening (2026-10-26, [HARDENING] in webServer.js/config.js):**
> premium is granted ONLY by the Stripe webhook, and the webhook rejects
> every event it cannot verify — signature verification is mandatory
> (constant-time, 5-minute timestamp tolerance), and with no webhook
> secret configured all events are refused. There is no mock checkout:
> an unconfigured Stripe makes checkout fail closed (503), and the old
> mock-success endpoint that granted premium for $0 is deleted. Checkout
> sessions are built from the plan config (Pro $19/300, Power Seller
> $49/1,000) and carry `metadata.plan` on the session and the
> subscription, so fulfillment delivers the plan actually bought.
> Anonymous generation requests are refused (401) at both generation
> endpoints, the folder watcher daemon's unmetered generations are
> disabled, the shipped default API key is removed (operator API-key
> auth exists only when API_KEY is configured), an unconfigured Google
> login no longer mints an admin session, and all mutable state lives
> under one state root (LISTER_STATE_DIR / Railway volume) so billing
> records survive redeploys.

## Policy 1 — Edits never consume credits

**Editing a listing is always free, at every tier.**

- Saving a draft, re-saving, updating price/title/description/aspects, and
  republishing changes to an existing listing never decrement a credit balance
  and never trigger a charge.
- Only the initial creation of a listing (the AI generation pass) is a
  billable event, per the tier's credit allotment.
- Rationale: sellers iterate. Charging for edits punishes the exact behavior
  (tightening titles, re-pricing against comps) that makes listings sell, and
  it creates support tickets every time a typo costs money.

## Policy 2 — Instant upgrades with proration

**Upgrades apply immediately; Stripe's native proration handles the billing math.**

- When a user upgrades mid-cycle, the new tier's limits and credit allotment
  take effect at once — no waiting for the next billing date, no manual
  credit grants.
- The dollar math is delegated to Stripe's subscription proration
  (`proration_behavior` on subscription updates): Stripe computes the unused
  portion of the old plan against the remainder of the new plan and invoices
  or credits the difference automatically.
- Downgrades take effect at the end of the current billing period (standard
  SaaS behavior) unless support intervenes.

## Policy 3 — Team seats (Power Seller) <!-- [WAVE1-D] implemented -->

**Power Seller workspaces include 3 seats. Owner/member only — no roles matrix.**

- The billing plan is recorded from the Stripe checkout session's
  `metadata.plan` (`"pro"` or `"power_seller"`, defaulting to `"pro"` when
  absent). **The Power Seller price in Stripe must carry
  `metadata: { plan: "power_seller" }`** or seats will not unlock.
- Only an active Power Seller subscription unlocks seat management. Starter
  and Pro accounts see the Team view as an upsell, never as an error.
- Pending invites hold a seat: a workspace cannot invite beyond 3 total
  (active + invited). Invites are accepted by signing in — no email delivery
  exists in this codebase, so there is no emailed invitation; the owner tells
  the teammate to sign in.
- Seats go dormant if the owner's subscription lapses: members lose workspace
  access until billing is current. Removing a member never deletes listings.
- The workspace is shared structurally: the app keeps a single-tenant data
  store, so every seat inherently sees the same listings. A true multi-tenant
  split is future work, not a launch blocker.

## Policy 4 — Bring your own key (BYOK) <!-- [BYOK] implemented 2026-10-26 -->

**A user may save their own Google Gemini API key; the software is the
product, the key is fuel the user may supply. There is no BYOK discount
and no separate BYOK plan.**

- **Storage:** the key lives in the `geminiApiKey` field of the account's
  billing record (Settings → Your Gemini API Key, `/api/user/gemini-key`).
  It is a secret: never logged, never returned to a client — the Settings
  surface only ever shows a masked form (bullets + last 4 characters).
  Keys are keyed to the billing account: a Power Seller seat shares the
  owner's pool and the owner's key.
- **Free tier:** a Starter account with a saved key generates **on its
  own key**, counting toward the 10/month free allotment (a product limit,
  not a cost limit). Without a saved key, a Starter account generates 0.
- **Paid tiers below the cap:** generations run on the house key and
  count as usual — a saved key changes nothing until the cap.
- **Overflow valve (paid tiers at the cap):** with a saved key, the
  account keeps generating **on its own key, uncounted**, at no AI cost
  to the operator. There is no dollar overage charge for this (see Open
  questions). A free account at its 10 gets no valve — it hears the
  paid-plan pitch.
- **Failure rules:** a call made on the user's key **never falls back to
  the house key**, and a failed generation is never counted. If Google
  rejects the key, the user hears exactly that in plain language ("Your
  Gemini API key was rejected by Google — check it in Settings") with
  error code `USER_KEY_REJECTED`; other failures on their key return
  `USER_KEY_FAILED`. Raw provider errors are never forwarded to the
  client (request URLs carry keys).
- **Edits:** /api/enhance stays uncounted (Policy 1), but when an
  account's generations run on its own key (free tier, or paid at cap),
  the polish runs on that key too, so free-tier AI work stays off the
  house key. Keyless accounts enhance on the house key, as before.

## Policy 5 — Cancellation, payment failure, and self-serve billing <!-- [HARDENING] implemented 2026-10-26 -->

**Cancel anytime is real and self-serve.**

- `POST /api/billing/cancel` (signed-in) sets the Stripe subscription to
  cancel at period end: the customer keeps the access they paid for, is
  not charged again, and premium is revoked when
  `customer.subscription.deleted` arrives at period end.
- `POST /api/billing/portal` (signed-in) returns a Stripe Billing Portal
  session URL — update payment method, switch plans (proration per
  Policy 2), or cancel there.
- **Plan changes:** `customer.subscription.created` / `.updated` webhook
  events sync the local plan and status from the subscription's
  `metadata.plan`; a subscription that leaves the active states
  (canceled / unpaid / incomplete_expired) stops granting premium at
  once, not at deletion time.
- **Failed renewals:** `invoice.payment_failed` marks the account
  `past_due` but does not revoke premium mid-dunning — Stripe's retry
  schedule decides, and if it gives up, the subscription deletion
  revokes. `invoice.paid` clears the past-due mark. (This settles the
  mechanics of the grace question below; the grace *length* is Stripe's
  retry schedule, not an app setting.)

## Open questions (not decided)

- Dollar overage pricing beyond the cap. (Allotments themselves are now
  decided and implemented — see the implementation status above. At the
  cap, generation is refused unless the paid account uses the own-key
  BYOK valve, Policy 4; a free BYOK account at its 10 is pointed at the
  paid plans.)
- Grace behavior when a subscription lapses mid-dunning — mechanics
  settled by Policy 5 (mark past due, premium held during Stripe's retry
  schedule, revoked on deletion); only the retry schedule itself remains
  a Stripe-side setting.

## Resolved

- Failed AI generations never consume: only a generation that completes
  and produces a listing increments the monthly count (implemented
  2026-10-24).
