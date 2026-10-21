# Billing Policy — ListAI Pro

> Status: **DECIDED** (recorded 2026-10-18, Wave 1A).
> Implementation status: **policy-only**. No credit-consumption or per-action
> billing code exists in the codebase today (verified by search: zero code paths
> meter listing generation, edits, or any other action). These policies take
> effect in code once Stripe-connected metering is built. <!-- [WAVE1-A] -->

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

## Open questions (not decided)

- Exact per-tier credit allotments and overage pricing.
- Whether failed AI generations (timeouts, validation failures) refund the
  credit — recommended: yes, only successful generations consume credits.
- Grace behavior when a subscription lapses mid-dunning (Stripe retry
  schedule vs. immediate feature cutoff).
