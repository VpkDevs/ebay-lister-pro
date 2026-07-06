# Unified Local Image Sourcing and Curation Engine

This commit records the architecture/spec handoff for the new image sourcing engine.

Full user-facing spec:
- [outputs/unified-local-image-sourcing-curation-engine.md](../../../../Documents/Codex/2026-07-05/you-are-the-lead-ai-systems/outputs/unified-local-image-sourcing-curation-engine.md)

Summary:
- Deprecate and replace `lib/photoSourcing.js`.
- Enforce a two-phase discovery flow: eBay first, Google PSE fallback only after rejection or empty results.
- Add a deterministic state machine for `FULLY_AUTOMATED` and `ASSISTED_OVERRIDE`.
- Materialize approved assets locally, then serve them through a local HTTP asset service plus a temporary tunnel.
- Persist sourcing telemetry, tunnel URLs, file paths, and downstream state in SQLite.
- Use a strict Gemini Vision prompt that returns selected candidate indexes and confidence reasoning as JSON.
