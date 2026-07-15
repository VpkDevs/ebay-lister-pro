# Production-Readiness Takeover Design

## Goal

Turn the current eBay Lister Pro worktree into a release candidate that is safe to run, clear to operate, resilient when integrations are unavailable, and supported by repeatable release checks. The existing in-progress product is the scope; no clean-slate rewrite is planned.

## Current Context

The project is a Node.js/Express application with a static dashboard, eBay listing workflow, optional Google/Gemini, Shopify, WooCommerce, Etsy, Stripe, image-processing, and Chrome-extension integrations. The worktree contains substantial uncommitted product work, including the Express application, routers, SQLite-backed modules, and dashboard updates. This pass must preserve that work while making it releasable.

## Design

### Release Boundary and Git Health

Treat the current worktree as the release candidate. Inventory every changed, new, and deleted path before editing; distinguish application artifacts from generated local data and scratch files; and retain only source, tests, configuration examples, and operational documentation in version control. Make small, attributable commits after verification rather than bundling unrelated work.

### Application Reliability

Establish one clear startup path and validate required configuration at the boundary. Ensure routing, authentication, body parsing, static assets, database initialization, background work, and graceful shutdown behave consistently in local development and production. External integrations must report actionable configuration or availability errors without exposing secrets, crashing the process, or corrupting local state.

### Security and Data Safety

Review the exposed HTTP surface for authorization gaps, permissive CORS/origin handling, unsafe file and URL handling, unbounded inputs, secret disclosure, and development-only routes. Preserve the loopback-friendly local workflow while making externally deployed behavior explicit and safe. Keep logs redacted, validate data at route boundaries, and prevent generated uploads, databases, logs, and credentials from being committed.

### Product Experience

Polish the primary dashboard and listing flow before secondary surfaces. The UI will use a coherent visual system and work across desktop and small screens. Every async user action will have visible loading, success, error, and empty states; form errors will be understandable; keyboard focus and contrast will be reliable; and product claims will match the availability of configured integrations.

### Verification and Operations

Improve the existing test suite with regression coverage for production risks uncovered during the pass. Run syntax, tests, a production-mode startup/health check, and targeted browser smoke checks. Finish the release documentation with setup, environment-variable guidance, architecture, operations, security notes, rollback, and an actionable release checklist.

## Delivery Sequence

1. Audit the worktree, application surface, configuration, tests, and startup paths; create a release inventory.
2. Fix verified functional, reliability, and security defects with tests added first for each behavioral change.
3. Polish and validate the dashboard’s primary flows and responsive/accessibility behavior.
4. Remove or ignore generated artifacts, complete operational documentation, and establish a clean release-ready Git history.
5. Run the full verification gate, record evidence, and report any remaining external setup required for live integrations.

## Constraints

- Preserve existing in-progress functionality unless a change is necessary for correctness, security, or a coherent user experience.
- Do not use real production credentials, publish listings, charge payments, or send external messages during verification.
- Never commit `.env`, local databases, uploads, logs, or scratch artifacts.
- No migration that can lose listing or user data without a backup and rollback path.

## Success Criteria

- A new developer can configure, start, and health-check the app from documented instructions.
- The application passes its automated tests and syntax/type-level checks, starts in production mode, and serves the primary interface without console or server errors.
- Protected routes and sensitive operations have deliberate access controls; errors and logs do not reveal secrets.
- Core dashboard and listing workflows communicate their current state clearly and remain usable on supported screen sizes.
- The repository has a documented release process and no accidental local runtime artifacts staged for release.
