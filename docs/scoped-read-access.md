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

> **Two layers.** The scope is enforced in Logbird's query builders on every read path (below). When the restricted
> ClickHouse query user is configured (`CLICKHOUSE_QUERY_USER`, the same account SQL mode uses), scoped reads also
> run as that user with the tenant bound in a row policy, so ClickHouse itself returns no other tenant's events even
> if a query forgot the scope. Without that user, the query builders are the single layer. The row policy covers the
> tenant; the target and action-prefix limits are enforced by the query builders.

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

The scope is a predicate the server ANDs **outside** your `q` filter, on the indexed search columns. Nothing in `q`
can widen it: `tenant:other`, `OR`, negation, `tenant:*` and free text all stay inside the scope. SQL mode
(`lang=sql`) is console-only.

### A scope names stored ids

A scope matches the ids Logbird **stored**, the same ids the console shows on a tenant's page and matches with
`tenant:<id>`. A scoped key never sees more than the console shows for that same stored id.

- Today ingest trims surrounding whitespace from ids. Events sent with `" biz_5"` or `"biz_5 "` are stored as
  `biz_5` and belong to the `biz_5` scope, as they already do on every other Logbird surface. Ids are being changed
  to be stored exactly as sent; once that ships, this applies only to events stored before it.
- Ingest also caps ids (256 characters) and replaces invalid Unicode. Scope ids are refused unless they are already
  in stored form (at most 250 characters, no surrounding whitespace, no U+FFFD), so a capped or repaired stored id can
  never match a scope.
- An id sent as a JSON number is stored as one canonical text of its exact value: its plain decimal in the usual
  case (42, 42.0 and 4.2e1 are all stored as `"42"`), scientific notation for very large or very small values
  (the number 1e33 is stored as `"1e33"`); see [numbers and ids](integrating-a-backend.md#numbers-and-ids). A scope
  written as `"42"` therefore matches a tenant sent as the number 42 in any spelling and as the string `"42"`, not
  the string `"42.0"`: a numeric id and a string id with the same stored text are one tenant and one scope. A string
  holding the expanded digits of 1e33 is a different tenant from the number. Events stored before 0.2.0 whose
  tenant id was a number were not indexed under a tenant, so no scope sees them. Before 0.2.0, Logbird indexed a numeric target id as an empty string, so that target cannot satisfy a scope naming its numeric id, but another target can independently satisfy the scope. A numeric actor id does not affect a tenant-only scope.
- A read-only operator query that counts stored ids differing from the sent ones ships with the ingest change.

## Where the scope applies

| Route | Scoped behaviour |
| --- | --- |
| `GET /v1/events` | Only in-scope events; `total` counts in-scope events only. Cursors are bound to the scope that minted them: a cursor from another scope (or from an unscoped key) is refused with 422 `validation_error`. |
| `GET /v1/events/:id` | An out-of-scope id answers 404 exactly like an id that was never stored. The parent chain stops at the first out-of-scope parent; `childCount` and `operationSize` count in-scope events only. The event's own `context.parentEventId` is kept as recorded (it is the event's content), and following it answers that same 404. |
| `GET /v1/facets` | Counts over in-scope events only (any query field, or `attr.<path>` / `attributes.<path>`, optional second level `by`). Attribute values are stored as text: a value that is JSON array text (a sent array, or a string that looks like one) counts each element; an array whose stored text was cut at 2048 bytes counts as one value. |
| `GET /v1/export` | Only in-scope rows, through the same engine, admission limits and audit trail as console exports. |
| `GET /v1/project` | `oldestEventAt` is the oldest in-scope event (null when the scope has none): the first event an ascending search over the widest window returns to the same caller, so it adds nothing the scope could not already find. `retentionDays` is the project's retention window, the same for every scope. |

## Masks

- `ip` empties `context.ip`; `user_agent` empties `context.userAgent`.
- `actor_email` replaces `actor.email` with `masked:<24 hex>`, a keyed hash that is stable per project, so a viewer
  can still group by person without seeing the address.
- Because the pseudonym is stable per project, it is also linkable. A reader who can cause an event with an address
  of their choosing (their own profile email, for example) and see that event's masked actor email learns that
  address's pseudonym. They can then recognise the same address in any other masked results they can read in the
  project. Where that matters, don't give that reader the actor fields at all. Keying pseudonyms per read key or scope
  is tracked in #370.
- It also hides an actor **name that carries an address**: lower-cased with all whitespace removed, the name contains
  `@`, equals the email, or (cut at its 512-character cap) is a prefix of it. That covers a producer that used the
  address as the display name, put it inside the name (`Ada <ada@example.org>`), or sent an address only as the name.
  Events, facets (values, groups and labels), filters and masked webhook filters treat such a name the same way:
  - It shows as a pseudonym (the email's own when the name contains it).
  - Filters read it as an empty name. An `actor.name` filter for the address, a prefix of it or a wildcard never
    matches it, but a filter that an empty name satisfies does (for example `NOT actor.name:"x"`, or a regex that
    accepts an empty string).
  - Free text matches such an event only through its other text.
  - A pseudonym can't be inverted, so `actor.name:"masked:…"` matches only a name a producer literally sent as that
    text. Filter by actor id instead.
- Under `actor_email`, if an id's earliest `(received_at, timestamp)` pair holds more than one distinct stored payload
  (legacy data), detail answers 404 and parent traversal stops at that id: choosing between them would read the hidden
  fields. Identical copies, and an earliest version that is unique, are served as usual.
- The mask covers the actor's own email and name. Addresses a producer writes into other fields (descriptions, target
  names, attributes) are not masked. The masks are fixed presets (`ip`, `user_agent`, `actor_email`), so keep
  addresses out of those fields when scoped readers must not see them.
- Case-insensitive matching follows the Unicode case tables of the server's Node.js runtime and of ClickHouse. A test
  pins their agreement for the examples it lists (ASCII, Latin-1, Greek, Cyrillic, Turkish and German). Case pairs
  added in Unicode 17 can differ between them (#365).
- **Any mask also drops the original payload:** detail returns `payload: null`, and `jsonl-evidence` exports answer
  422 `masked_export`.
- A masked scope can't filter or facet on a masked field or on the matching attribute paths (`context.ip`,
  `context.userAgent`, `actor.email`) (422 `invalid_query`, reason `not_allowed`), because the answer would reveal the
  hidden value.

## Keys

Create scoped keys in the console (project **Settings → API keys → Create key → Scoped read**) or with
`POST /api/projects/:projectId/keys`. The console form shows each limit before you submit, previews what the key can
read, and afterwards shows the kind, scope and expiry the server actually returned, with a warning if they differ from
the request:

```http
POST /api/projects/:projectId/keys
{ "name": "Website site_42", "kind": "scoped-read",
  "scope": { "tenantId": "biz_5", "target": { "type": "website", "id": "site_42" } },
  "expiresAt": "2027-01-01T00:00:00Z" }
```

- `scope` is required for `scoped-read` and refused on other kinds. All read kinds use `lb_read_…` secrets.
- Scope identifiers must be in stored form: at most 250 characters (60 for a target type, 190 for an action prefix),
  with no leading or trailing whitespace and no invalid Unicode (see [A scope names stored ids](#a-scope-names-stored-ids)).
- Keys with a scope or an expiry have 48 random characters after the prefix (other keys have 32). Releases before
  scoped keys reject that format, so if you roll back, these keys stop working instead of becoming project-wide.
- `embedOrigins` (read kinds only): browser origins allowed to use this key's viewer tokens, for example
  `https://cms.example.com`. Exact origins, lowercase, no path.
- `expiresAt` (optional, in the future): an expired key is rejected like a revoked one, and so are its tokens.
- **Check the response before you hand out a secret.** A server older than 0.2.0 (during a rolling upgrade, or
  after a rollback) ignores `expiresAt` on `read` and `ingest` keys and returns a permanent key, and ignores `expiresAt` on
  a roll. Compare the returned key's `kind`, `scope` and `expiresAt` with what you asked for; if they differ, revoke it.
  Older servers refuse `kind: "scoped-read"` outright (422).
- Scope, origins and expiry are fixed at creation. **Rolling** (`POST …/keys/:keyId/roll`) copies the scope and
  origins and keeps the old key's absolute expiry; pass `{ "expiresAt": "…" }` to give the replacement a different
  one. Rolling an expired key requires a new `expiresAt` (409 `key_expired` otherwise). In the console, **Roll** asks
  whether the replacement keeps the current expiry or gets a new one, and offers only a new one for an expired key.
  A database trigger refuses any replacement that drops the scope or the expiry: 0.2.0 and later answer
  409 `key_restricted`; an older release (after a rollback) fails that roll with a server error and creates nothing.
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

- Viewer-token reads are charged first to a bucket per minting key and tenant (`VIEWER_READ_RATE_LIMIT_PER_MINUTE`,
  default 300) and, only when that admits them, to the project read limit (`READ_RATE_LIMIT_PER_MINUTE`), in one atomic
  step. A throttled tenant can't use up the project's budget. `RateLimit-*` headers report the tighter bucket.
- Minting is limited per key (`VIEWER_TOKEN_MINT_RATE_LIMIT_PER_MINUTE`, default 600).

## Exports

`GET /v1/export?format=csv|jsonl|jsonl-evidence&q=&from=&to=` streams like the console export
([exports](exports.md)): `X-Logbird-Export-Id` and `X-Logbird-Export-Schema` headers, the same CSV columns, and the
same admission limits (one running export per API key, two per workspace; a busy key answers 429 `export_busy`). When
scoped reads run as the restricted query user (see "Two layers"), a scoped export takes both of the workspace's export
slots by itself, like a console SQL export, so another key's export answers 429 `export_busy` while it runs, and each
scoped query runs under that user's limits (10 s, 5,000,000 rows read and 1 GiB per query). There
is no trailer: a complete download is one that ends normally (a non-empty file ends with a newline; no matching events
gives an empty JSONL body or a CSV header only). A failure after the headers aborts the connection, so discard any
download that ends with a transport error.

Each export is recorded in workspace activity as `export.requested`, then `export.completed` or `export.failed`, with
the API key as the actor and `metadata.access = { via, apiKeyId, viaToken, tenantId, jti, scope }`.

## Security notes

See [security](security.md#viewer-tokens) for the token format and secret derivation.

## Limits

- One tenant per scope.
- A target scope matches an indexed target of an event. Every release indexes at most the first 64 targets of an
  event (see [limits](limits.md)), so a target scope on a record named only after them does not see that event. Such
  an event stored by this release or later carries `logbird.truncated.targets` with the number of targets sent.
- Field masks are presets (`ip`, `user_agent`, `actor_email`), not arbitrary paths.
- Revoking a key reaches its viewer tokens within 30 seconds.
