# Design: eBay Lister Pro Command Center Upgrade

## Goal

Tremendously improve `ebay-lister-pro` by turning the existing dashboard into a more usable seller command center while preserving the current native Node.js and vanilla HTML/CSS/JS architecture. The upgrade should make daily listing work faster, make cross-channel failures easier to understand and recover from, and reduce maintenance risk in the most active code paths.

## Current Context

- The app is a CommonJS Node service with a vanilla single-page dashboard served from `public/index.html`.
- Core backend surfaces live mostly in `webServer.js`, with integration helpers in `ebayClient.js`, `geminiClient.js`, `crossPost.js`, `simple-lister-pro.js`, and `utils.js`.
- The dashboard already supports image upload/import/sprucing, AI analysis, eBay publish, draft save/publish, history, repricing, logs, channel onboarding, and DLQ retry management.
- The worktree currently has large uncommitted edits across frontend, backend, tests, and the Chrome extension. Implementation must preserve those changes and avoid unrelated rewrites.
- Documentation for architecture, setup, dependencies, environment, roadmap, and testing exists but several files are sparse placeholders.

## Product Design

The first screen should feel like a seller operating cockpit, not a collection of separate tools. The existing "New Listing", "Listing History", and "Sync Queue" views remain, but the dashboard should add a compact operational summary near the top of the workspace:

- Readiness: eBay auth, Gemini readiness, channel connections, diagnostics, and DLQ count.
- Work in progress: draft count, active count, ended count, and total inventory value from history.
- Recovery: failed sync jobs grouped by platform/status with retry availability.
- Next actions: start listing, sync from eBay, process ready sync jobs, review drafts, and open setup for disconnected channels.

The listing creation flow should stay familiar but become more decisive. After AI analysis, the form should highlight missing critical fields, policy warnings, duplicate/VeRO blocking states, selected image count, and publish readiness. Browser `prompt` and `confirm` interactions should be replaced where practical with existing modal patterns so high-risk actions are clear, reversible where possible, and visually consistent.

## Reliability And Observability Design

Operational state should be easier to trust. The backend already exposes `/api/status`, `/api/metrics`, `/api/logs`, `/api/logs/stream`, and DLQ endpoints. The UI should consolidate those signals into a "system health" strip or panel that shows:

- Channel connectivity and auth status.
- Circuit breaker status and active sockets/request counts when available.
- DLQ summary counts: total, ready, backing off, exhausted.
- Recent log stream with clearer empty/error states.
- Last successful refresh time and refresh action.

Error messages should distinguish user-fixable setup problems from platform/API failures. Cross-post failures should point users to the sync queue and preserve enough context to retry safely.

## Architecture

Keep the current stack and avoid a framework migration. The implementation should favor small, scoped modules and helpers that can be introduced without destabilizing the app:

- Add frontend state/render helpers inside `public/index.html` only if extracting files would create server/CSP risk in this phase.
- Add lightweight backend response helpers only where they reduce duplication for new or touched endpoints.
- Reuse existing `/api/status`, `/api/history`, `/api/dlq`, `/api/metrics`, and `/api/logs` contracts where possible.
- Add new API fields only when the UI cannot derive a signal safely from current responses.
- Avoid changing eBay, Shopify, WooCommerce, Etsy, Gemini, or Chrome extension behavior unless directly needed by the command center.

The monolithic files should not be fully split in this pass. Instead, changes should create clearer seams around the touched UI sections and data-fetching helpers so a future extraction is easier.

## Data Flow

1. On dashboard load, fetch session, status, history, DLQ summary, and metrics.
2. Normalize those responses into a single frontend dashboard state object.
3. Render readiness, inventory, sync queue, and next-action panels from that state.
4. Refresh status and DLQ state on an interval, and refresh history after listing, draft, sync, repricer, or DLQ actions.
5. Keep listing generation/publish flows using existing `/api/analyze`, `/api/save-draft`, `/api/publish`, and `/api/publish-draft` paths.

The frontend should degrade gracefully if metrics or DLQ calls fail: the listing workflow must still be usable, with warning states in the affected panels.

## Error Handling

- Use toast notifications for transient success/failure updates.
- Use modal confirmations for destructive or policy-sensitive actions: publish despite duplicate, publish despite VeRO, delete local record, clear DLQ, end listing, and custom category entry.
- Preserve existing server-side duplicate and VeRO gates as the source of truth.
- Show setup-focused messages for missing credentials and retry-focused messages for platform errors.
- Do not expose secrets, raw tokens, or full environment values in UI or logs.

## Testing And Verification

Automated verification should include:

- Existing `node test-suite.js`.
- New or updated tests for any backend contract changes, especially `/api/status`, `/api/dlq`, `/api/metrics`, and history-derived dashboard counts.
- If frontend-only, at minimum run the existing suite plus a manual browser smoke test of the dashboard.

Manual verification should include:

- Load the dashboard in local dev mode.
- Confirm command center cards render with empty and populated history/DLQ data.
- Run through image upload/import, AI analysis error state, draft save, history filtering, repricer modal, DLQ retry/dismiss, and logs panel.
- Check desktop and mobile widths for no overlapping controls or clipped action labels.

## Scope Boundaries

In scope:

- Seller workflow polish.
- Reliability/status visibility.
- Safer action confirmations.
- Focused backend/UI contracts.
- Docs updates that explain how to run, configure, test, and operate the improved app.

Out of scope for this implementation cycle:

- Framework migration.
- Database migration away from JSON files.
- Replacing the Chrome extension architecture.
- Deep eBay/Shopify/WooCommerce/Etsy API rewrites.
- Production billing/auth redesign beyond making current states clearer.

## Success Criteria

- A reseller can open the app and immediately know what is ready, what needs setup, what failed, and what to do next.
- Listing creation remains functional and gains clearer readiness/warning states.
- Cross-post failures are visible, grouped, and recoverable from the UI.
- The current large dirty worktree is preserved.
- Tests and manual smoke checks provide confidence that existing publishing, draft, history, repricing, and DLQ behavior did not regress.
