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

## Open questions (not decided)

- Exact per-tier credit allotments and overage pricing.
- Whether failed AI generations (timeouts, validation failures) refund the
  credit — recommended: yes, only successful generations consume credits.
- Grace behavior when a subscription lapses mid-dunning (Stripe retry
  schedule vs. immediate feature cutoff).
