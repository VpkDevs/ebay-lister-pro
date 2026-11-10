# Security Policy — ListAI Pro

## Reporting a vulnerability

Email the founder at the contact address published on the ListAI Pro
landing page with:

- what the issue is and where (URL, endpoint, or file),
- steps to reproduce, and
- the impact as you understand it.

Please do not open a public issue for security reports, and give us a
reasonable window to fix before disclosing publicly. We aim to acknowledge
reports within 3 business days. We do not run a paid bug bounty at this
stage; credited thanks in the release notes for valid reports.

## Scope

- The hosted ListAI Pro web app and API.
- The ListAI Pro Chrome extension.
- Out of scope: self-hosted copies modified by their operators, and
  third-party services we integrate with (report those to their owners).

## Operator security notes

- Premium access is granted **only** by Stripe's signed webhook events.
  There is no manual or URL-based way to activate a plan.
- Users may generate listings with their own Gemini API key (BYOK); keys
  are stored per-user, displayed masked, and never returned by the API.
- The Chrome extension stores the operator's API key in browser-local
  storage only. It contains no built-in credential.
