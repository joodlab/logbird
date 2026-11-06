# vue local example

From the repository root, set LOGBIRD_INGEST_KEY and LOGBIRD_READ_KEY to disposable project
keys in your shell (never commit them). Set LOGBIRD_ENDPOINT if different from http://127.0.0.1:4731.
Run `pnpm --filter @logbird/example-vue dev`, then POST http://127.0.0.1:4730/demo and
GET http://127.0.0.1:4730/history (Nuxt: /api/demo and /api/_logbird/events).
Only run one example at a time. These unauthenticated localhost examples are fictional; production
must resolve identity and authorize history requests using your application's session and tenant.
