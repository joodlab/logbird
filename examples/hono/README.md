# hono local example

From the repository root, set TRAILMARK_INGEST_KEY and TRAILMARK_READ_KEY to disposable project
keys in your shell (never commit them). Set TRAILMARK_ENDPOINT if different from http://127.0.0.1:4731.
Run `pnpm --filter @trailmark/example-hono dev`, then POST http://127.0.0.1:4730/demo and
GET http://127.0.0.1:4730/history (Nuxt: /api/demo and /api/_trailmark/events).
Only run one example at a time. These unauthenticated localhost examples are fictional; production
must resolve identity and authorize history requests using your application's session and tenant.
