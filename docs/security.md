# Security notes: derived keys and tokens

Logbird derives several keys from `BETTER_AUTH_SECRET` with HKDF-SHA256 (empty salt, 32-byte output), so
self-hosters configure one secret. Each use has its own `info` string, so one derived key never doubles as another.

| Use | HKDF info | Rotating `BETTER_AUTH_SECRET` |
| --- | --- | --- |
| Viewer-token MAC | `logbird-viewer-token-v1` | Every outstanding viewer token stops working at once. They live at most 1 hour; clients mint new ones. |
| `actor_email` field mask | `logbird-field-mask-v1` | Masked email hashes change, so a viewer's grouping by masked address restarts. Stored data is unaffected. |
| Webhook secret encryption (unless `WEBHOOK_SECRET_KEY` is set) | `logbird-webhook-secrets-v1` | Stored webhook secrets become unreadable; see [self-hosting](self-hosting.md#webhook-endpoint-settings). |

Rotating `BETTER_AUTH_SECRET` also signs every user out.

## Viewer tokens

Format: `lbv1.<base64url(payload)>.<base64url(HMAC-SHA256(key, "lbv1." + base64url(payload)))>`.

The payload is JSON: `{ v: 1, kid, p, s, iat, exp, jti }`, where `kid` is the minting API key id, `p` the project, `s`
the scope, `iat`/`exp` Unix seconds and `jti` a random id. It is signed, not encrypted: anyone holding the token can
read its scope, so never put secrets in a scope.

The server accepts a token only when:

- the MAC matches (constant-time compare) and the payload has exactly these fields;
- `exp` is in the future and `iat` is not in the future, each with 30 seconds of clock skew;
- the minting key still exists, is a read key of that project, is not revoked or expired, and its scope still
  contains the token's scope. The key lookup is cached for at most 30 seconds per API process, which bounds how
  long a revoked key's tokens keep working.

No token table is kept. To cut off all tokens of a key, revoke the key.

See [scoped read access](scoped-read-access.md) for what a scope enforces.

## Scopes name stored ids

A scope (on a scoped read key or a viewer token) is enforced on the stored, indexed ids. It never reads the original
payload: that would cost a JSON parse per candidate event (measured at 5-10x slower for large tenants). Stored ids are
what the console uses for tenant pages, filters, facets and exports, so a scope shows exactly what the console shows
for that id, never more.

The one case where two different sent ids share a stored id is surrounding whitespace, which ingest has trimmed so
far: `" biz_5"` is stored, and scoped, as `biz_5`. Capped or Unicode-repaired ids can't match, because scope ids must
already be in stored form. This is a maintainer decision (#180); ingest is being changed to store ids exactly as
sent, after which it applies only to events stored before that change. A read-only operator query that counts
stored ids differing from the sent ones ships with that change.
