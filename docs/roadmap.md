# Roadmap

Updated 2026-11-08. Logbird is an audit-log platform for existing backends.
See [Integrating an existing backend](integrating-a-backend.md) for event modelling,
redaction and delivery. These are candidates, not delivery commitments.

The product principles remain: accept varied event shapes, let clients capture
events, avoid historical reconstruction, enforce per-project retention, and keep
the console for operators. Products expose customer history through an authorized
backend using the read API.

## Integration and distribution

- Distribute versioned SDK and framework packages through documented releases.
- Expand examples for authenticated requests, background jobs and durable outboxes.
- Document measured ingest latency, availability and capacity limits, and provide
  signals for stopped ingestion.

## Customer-facing history

- Consider tenant-scoped read tokens with enforced filters and field masks.
- Add project-level redaction controls behind client redaction.
- Benchmark record and tenant history over long retention windows with fictional
  data before choosing additional indexes or projections.
- Provide a deny-by-default Hono read proxy helper with explicit authorization.

## Later candidates

- Action alerts, signed webhooks and archive exports.
- Scoped customer exports and action schema hints.
- Console SSO and data-subject erasure with explicit deletion semantics.

## Available foundations

Event ingestion, explorer and entity timelines, onboarding, invitations, saved
views, role checks, per-project retention, the TypeScript SDK, and Hono, TanStack
Start, Vue and Nuxt adapters. Consult the [specification](SPEC.md),
[concepts](concepts.md) and package documentation for current behavior and limits.
