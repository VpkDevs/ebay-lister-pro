# ListAI Pro — Compliance Checklist (Atlas Phase 3, 2026-10-26)

Product category: SaaS (subscription web app) + AI content generation +
marketplace publishing + browser extension. Founder jurisdiction: Texas, US.
Users may be anywhere (GDPR/CCPA handled by design, see below).

## Documents & routes
- [x] Terms of Service — product-specific, served at `/terms` (public/terms.html; canonical text: docs/legal/TERMS_OF_SERVICE.md)
- [x] Privacy Policy — names actual processors, served at `/privacy` (public/privacy.html; canonical: docs/legal/PRIVACY_POLICY.md)
- [x] Refund policy stated in ToS §4 *(policy text drafted by Atlas in the 2026-10-26 run; confirmed by founder 2026-11-10)*
- [x] AI output disclaimer in ToS §6 (FTC guidance + EU AI Act transparency) ✅ High confidence
- [x] AI processing disclosure in Privacy §2 (provider, data types, purpose, opt-out) ✅ High confidence
- [x] Governing law: Texas (ToS §9) ✅ High confidence
- [ ] **Lawyer review recommended** before scale: ToS §8 liability cap + §4 refund policy — ⚠️ Medium confidence (standard shapes, jurisdiction-dependent)

## Data rights
- [x] Account deletion endpoint `DELETE /api/user/account` — deletes session, billing/usage record, saved BYOK key, and (since this run) team data; covered by regression tests
- [x] No advertising/analytics cookies → no consent banner required; one functional session cookie disclosed in Privacy §4
- [x] Data-sale posture: none (no sale of personal data; CCPA "sale" opt-out N/A, disclosed)

## Category obligations
- [ ] **DMCA designated agent registration** — userMust `um-dmca-agent` (founder step, $6, ~15 min, copyright.gov). Product processes user photos = UGC-adjacent. ToS §5 carries the takedown procedure; safe harbor starts at registration.
- [x] Marketplace rules: acceptable-use clause covers VeRO/counterfeit/restricted items (ToS §3)
- [x] Extension: manifest permissions are activeTab/scripting/storage + hosts; extension stores the operator key in browser-local storage only (fixed this run); Chrome Web Store privacy disclosure must match Privacy Policy when listed — ⚠️ at listing time
- [x] CAN-SPAM: no marketing email is sent by the product today; if added, include address + opt-out — ongoing obligation below

## Risk radar (Phase 3)
| Risk | Sev | Likelihood | Fix | Owner |
|---|---|---|---|---|
| Photos pass through third-party temp hosts (tmpfiles.org/file.io) at eBay publish | 🟡 Med | Certain (by design) | Disclosed in Privacy §3; consider eBay's own image service (EPS) post-launch | Atlas disclosed; founder roadmap |
| AI-generated listing errors → marketplace policy strikes against sellers | 🟡 Med | Medium | ToS §6 disclaimer + review-before-publish design; never auto-publish | Done |
| EU AI Act transparency for AI output | 🟢 Low | Low (minimal-risk category) | Disclaimer + "Powered by AI" disclosures in place | Done |
| Stripe tax/VAT obligations as sales grow | 🟡 Med | Medium | Stripe Tax evaluation at first revenue; Texas SaaS taxability check | Founder/accountant at revenue |
| WCAG 2.1 AA full compliance | 🟡 Med | — | Automated pass done (all imgs have alt); contrast + keyboard-nav manual review still open | Founder/manual review |

## Ongoing obligations
- GDPR deletion/ access requests: respond ≤30 days (endpoint covers deletion; other requests via support contact)
- CCPA requests: respond ≤45 days
- Privacy policy review: annually, and whenever a processor is added/removed
- If email sending or analytics are ever added: update Privacy §3/§4 and re-run this checklist
- DMCA: keep agent registration current with the Copyright Office directory
