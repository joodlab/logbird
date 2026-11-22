# Scoped read access: show each customer only its own audit trail

A multi-tenant product often needs to show a business, or one of its websites, only its own activity. Logbird
enforces that on the server, so your product doesn't need to build a query proxy, and a browser never holds a
long-lived key.

There are two ways to grant scoped access:

- **Scoped read keys** (`kind: "scoped-read"`): a server-side key that can only ever read one scope.
- **Viewer tokens** (`lbv1.…`): short-lived (15 minutes by default, 1 hour at most) tokens that your server mints
  for one scope and hands to a browser.

The recommended pattern is **one unscoped `read` key on your server**. For every dashboard view, your server mints a
viewer token for that business or website and gives only the token to the browser.

> **Status.** In this release the scope is enforced in Logbird's query builders on every read path (below). A second,
> independent layer (ClickHouse row policies on the tenant) follows in the next release. Until then, treat the query
> builders as the single enforcement layer.

## The scope

```jsonc
{
  "tenantId": "biz_5",                              // required: the event's tenant.id must equal it
  "target": { "type": "website", "id": "site_42" }, // optional: the event has ONE target with this type AND id
  "actionPrefixes": ["booking.", "auth."],          // optional: the action starts with one of these
  "mask": ["ip", "user_agent", "actor_email"]       // optional field masks
}
```

- **Business dashboard:** `{ "tenantId": businessId }`.
- **Website dashboard:** `{ "tenantId": businessId, "target": { "type": "website", "id": websiteId } }`. The type and
  id must match on the same target: an event that touched `page:site_42` and `website:other` does not match.
- Events without a tenant are never visible to a scoped caller.
- One tenant per scope in this version.

The scope is a predicate the server ANDs **outside** your `q` filter. Nothing in `q` can widen it: `tenant:other`,
`OR`, negation, `tenant:*` and free text all stay inside the scope. SQL mode (`lang=sql`) is console-only.

## Where the scope applies

| Route | Scoped behaviour |
| --- | --- |
| `GET /v1/events` | Only in-scope events; `total` counts in-scope events only. Cursors are bound to the scope that minted them: a cursor from another scope (or from an unscoped key) is refused with 422 `validation_error`. |
| `GET /v1/events/:id` | An out-of-scope id answers 404 exactly like an id that was never stored. The parent chain stops at the first out-of-scope parent; `childCount` and `operationSize` count in-scope events only. The event's own `context.parentEventId` is kept as recorded (it is the event's content), and following it answers that same 404. |
| `GET /v1/facets` | Counts over in-scope events only (any envelope field or `attr.<path>`, optional second level `by`). |
| `GET /v1/export` | Only in-scope rows, through the same engine, admission limits and audit trail as console exports. |

## Masks

- `ip` empties `context.ip`; `user_agent` empties `context.userAgent`.
- `actor_email` replaces `actor.email` with `masked:<24 hex>`, a keyed hash that is stable per project, so a viewer
  can still group by person without seeing the address.
- **Any mask also drops the original payload:** detail returns `payload: null`, and `jsonl-evidence` exports answer
  422 `masked_export`.
- A masked scope can't filter or facet on a masked field (422 `invalid_query`, reason `not_allowed`), because the
  answer would reveal the hidden value.

## Keys

Create keys in the console or with `POST /api/projects/:projectId/keys`:

```http
POST /api/projects/:projectId/keys
{ "name": "Website site_42", "kind": "scoped-read",
  "scope": { "tenantId": "biz_5", "target": { "type": "website", "id": "site_42" } },
  "expiresAt": "2027-01-01T00:00:00Z" }
```

- `scope` is required for `scoped-read` and refused on other kinds. All read kinds use `lb_read_…` secrets.
- `embedOrigins` (read kinds only): browser origins allowed to use this key's viewer tokens, for example
  `https://cms.example.com`. Exact origins, lowercase, no path.
- `expiresAt` (optional, in the future): an expired key is rejected like a revoked one, and so are its tokens.
- Scope, origins and expiry are fixed at creation. **Rolling** (`POST …/keys/:keyId/roll`) copies the scope and
  origins and keeps the old key's absolute expiry; pass `{ "expiresAt": "…" }` to give the replacement a different
  one. Rolling an expired key requires a new `expiresAt` (409 `key_expired` otherwise).
- `api_key.created` and `api_key.revoked` in workspace activity record the scope, origins and expiry.

## Viewer tokens

```http
POST /v1/viewer-tokens
Authorization: Bearer lb_read_…
{ "scope": { "tenantId": "biz_5", "target": { "type": "website", "id": "site_42" } }, "ttlSeconds": 900 }

201 Cache-Control: no-store
{ "token": "lbv1.<payload>.<mac>", "expiresAt": "2026-11-22T10:15:00.000Z", "scope": { … } }
```

- Only a read or scoped-read key can mint; a viewer token can't mint another (403).
- `ttlSeconds` is 60–3600, default 900.
- The token's scope must be equal to or narrower than the key's: the same tenant; the key's target if it has one;
  action prefixes inside the key's prefixes; and at least the key's masks. Otherwise 403 `scope_exceeded`.
- Send the token as `Authorization: Bearer lbv1…` on the four read routes above. Never put it in a URL. It is never
  accepted for ingest or management.
- Revoking or expiring the minting key invalidates its tokens within 30 seconds (each API process caches the key
  lookup for up to 30 seconds).
- Tokens are not stored. Your server may cache a token for its lifetime.

### Browser use (CORS)

- Responses to viewer-token requests are readable only from the minting key's `embedOrigins`. A request from any
  other browser origin answers 403 `origin_not_allowed`. A key with no origins mints tokens that work server to
  server only.
- No cookies are used, and `Access-Control-Allow-Credentials` is never sent.
- A 401 (expired or revoked token) is readable from any origin, so an embed can tell it must fetch a new token.
- Read keys get no CORS at all: keep them on servers.

## Rate limits

- Viewer-token reads count toward the project read limit (`READ_RATE_LIMIT_PER_MINUTE`) **and** toward a bucket per
  minting key and tenant (`VIEWER_READ_RATE_LIMIT_PER_MINUTE`, default 300), so one tenant's dashboards can't use up
  another's budget. `RateLimit-*` headers report the tighter bucket.
- Minting is limited per key (`VIEWER_TOKEN_MINT_RATE_LIMIT_PER_MINUTE`, default 600).

## Exports

`GET /v1/export?format=csv|jsonl|jsonl-evidence&q=&from=&to=` streams like the console export
([exports](exports.md)): `X-Logbird-Export-Id` and `X-Logbird-Export-Schema` headers, the same CSV columns, and the
same admission limits (one running export per API key, two per workspace). There is no trailer: a complete file ends
with a newline and a normal end of the response; a failure after the headers aborts the connection, so discard any
download that ends with a transport error.

Each export is recorded in workspace activity as `export.requested`, then `export.completed` or `export.failed`, with
the API key as the actor and `metadata.access = { via, apiKeyId, viaToken, tenantId, jti, scope }`.

## Security notes

See [security](security.md#viewer-tokens) for the token format and secret derivation.
