import type { AuditEvent, ReadScope } from '@logbird/contracts';

/** Origin the SDK/curl should talk to. The app origin proxies `/v1` to the server. */
export function ingestOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost:4600' : window.location.origin;
}

export const SDK_INSTALL = 'pnpm add @logbird/sdk';

/**
 * Snippets are meant to be pasted and run as-is. With a freshly created secret they embed it;
 * without one they read the key from the environment instead of showing a fake placeholder.
 */
const INGEST_ENV = 'LOGBIRD_INGEST_KEY';
const READ_ENV = 'LOGBIRD_READ_KEY';

/** `@logbird/sdk`: `new Logbird({ apiKey, endpoint })`, `track()` queues, `flush()`/`shutdown()` deliver. */
export function sdkSnippet(key?: string): string {
  const apiKey = key ? `'${key}'` : `process.env.${INGEST_ENV}!`;
  return `import { Logbird } from '@logbird/sdk';

const logbird = new Logbird({
  apiKey: ${apiKey},
  endpoint: '${ingestOrigin()}',
  onError: (error) => console.error('[logbird]', error.message),
});

// track() never throws: it queues the event and sends it in batches.
logbird.track({
  action: 'hotel.policy.updated',
  outcome: 'success',
  description: 'Lina changed the cancellation policy of Hotel Sunrise',
  actor: { type: 'user', id: 'usr_42', name: 'Lina Haddad' },
  tenant: { id: 'biz_7', name: 'Azure Hotels' },
  targets: [{ type: 'hotel', id: 'hotel_123', name: 'Hotel Sunrise' }],
  changes: [{ field: 'cancellationHours', before: 24, after: 48 }],
});

// Deliver everything queued before the process exits.
await logbird.shutdown();`;
}

export function curlSnippet(key?: string): string {
  return `curl -X POST "${ingestOrigin()}/v1/events" \\
  -H "Authorization: Bearer ${key ?? `$${INGEST_ENV}`}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "action": "hotel.policy.updated",
    "outcome": "success",
    "description": "Lina changed the cancellation policy of Hotel Sunrise",
    "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
    "tenant": { "id": "biz_7", "name": "Azure Hotels" },
    "targets": [{ "type": "hotel", "id": "hotel_123", "name": "Hotel Sunrise" }],
    "changes": [{ "field": "cancellationHours", "before": 24, "after": 48 }]
  }'`;
}

/** Plain `fetch` (Node 18+, Deno, Bun, edge runtimes): no dependency at all. */
export function fetchSnippet(key?: string): string {
  const auth = key ? `'Bearer ${key}'` : `\`Bearer \${process.env.${INGEST_ENV}}\``;
  return `const response = await fetch('${ingestOrigin()}/v1/events', {
  method: 'POST',
  headers: { Authorization: ${auth}, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'hotel.policy.updated',
    outcome: 'success',
    description: 'Lina changed the cancellation policy of Hotel Sunrise',
    actor: { type: 'user', id: 'usr_42', name: 'Lina Haddad' },
    tenant: { id: 'biz_7', name: 'Azure Hotels' },
    targets: [{ type: 'hotel', id: 'hotel_123', name: 'Hotel Sunrise' }],
  }),
});
if (response.status !== 202) throw new Error(await response.text());`;
}

/** Read the audit trail from a product backend (read keys only). */
export function readFetchSnippet(key?: string): string {
  const auth = key ? `'Bearer ${key}'` : `\`Bearer \${process.env.${READ_ENV}}\``;
  return `// Latest events, newest first. Filter with the query language, e.g. one customer's history:
// new URLSearchParams({ q: 'tenant:biz_7', limit: '20' })
const params = new URLSearchParams({ limit: '20' });
const response = await fetch(\`${ingestOrigin()}/v1/events?\${params}\`, {
  headers: { Authorization: ${auth} },
});
const { data, nextCursor } = await response.json();`;
}

/** The fields that move conformance the most, in the order operators usually add them. */
export const ENVELOPE_CORE = `{
  "action": "hotel.policy.updated",
  "occurredAt": "2026-11-04T14:32:10.123Z",
  "outcome": "success",
  "description": "Lina changed the cancellation policy of Hotel Sunrise",
  "actor":    { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
  "tenant":   { "id": "biz_7", "name": "Azure Hotels" },
  "executor": { "type": "api", "id": "booking-api" },
  "targets":  [{ "type": "hotel", "id": "hotel_123", "name": "Hotel Sunrise" }],
  "context":  { "operationId": "op_101", "requestId": "req_abc" }
}`;

export const OPERATION_EXAMPLE = `// 1. The API handler starts an operation and passes its id along (job payload, message headers…)
const operationId = request.id; // any stable id: request id, trace id, ULID
logbird.track({ action: 'booking.created', context: { operationId }, /* … */ });
await queue.add('send-confirmation', { bookingId, operationId });

// 2. The worker reuses it, so the job's events join the same operation
logbird.track({
  action: 'booking.confirmation.sent',
  executor: { type: 'worker', id: 'mail-worker', jobId: job.id },
  context: { operationId: job.data.operationId },
});`;

/**
 * Read the trail with a read key. The first call is unfiltered so it returns the starter events right after
 * onboarding (they are all `outcome:success`); the second, labelled call shows a query-language filter.
 */
export function readCurlSnippet(key?: string): string {
  const auth = `-H "Authorization: Bearer ${key ?? `$${READ_ENV}`}"`;
  return `# Latest events, newest first (includes the ones you just sent)
curl --get "${ingestOrigin()}/v1/events" \\
  ${auth} \\
  --data-urlencode "limit=20"

# Only failures: filter with the query language
curl --get "${ingestOrigin()}/v1/events" \\
  ${auth} \\
  --data-urlencode "q=outcome:failure" \\
  --data-urlencode "limit=20"`;
}

/**
 * Viewer tokens: the console never mints them. A server holding a read or scoped-read key mints one per page view and
 * hands only the token to the browser (docs/scoped-read-access.md). With a scoped key the example asks for the key's
 * own scope (a token may be equal or narrower); with a read key it uses an example tenant.
 */
export function viewerTokenSnippet(key?: string, scope?: ReadScope | null): string {
  const auth = `-H "Authorization: Bearer ${key ?? `$${READ_ENV}`}"`;
  // Single-quoted for the shell: an id containing ' is closed, escaped and reopened.
  const body = JSON.stringify({ scope: scope ?? { tenantId: 'biz_5' }, ttlSeconds: 900 }).replaceAll("'", `'"'"'`);
  const what = scope ? "this key's own scope (or a narrower one)" : 'one tenant (biz_5 is an example)';
  return `# 1. On your server: mint a token for ${what}, valid 60 to 3600 seconds
curl -X POST "${ingestOrigin()}/v1/viewer-tokens" \\
  ${auth} \\
  -H "Content-Type: application/json" \\
  -d '${body}'
# Answers {"token":"lbv1.…","expiresAt":"…","scope":{…}}. Give the browser only the token.

# 2. In the browser: read with the token, always in the Authorization header, never in a URL
curl --get "${ingestOrigin()}/v1/events" \\
  -H "Authorization: Bearer $LOGBIRD_VIEWER_TOKEN" \\
  --data-urlencode "limit=20"`;
}

/** "Copy as curl" for an event: fetch it through the public read API. */
export function eventCurl(event: AuditEvent): string {
  return `curl "${ingestOrigin()}/v1/events/${encodeURIComponent(event.id)}" \\
  -H "Authorization: Bearer $${READ_ENV}"`;
}

export const ENVELOPE_EXAMPLE = `{
  "id": "01JCDX3V7Q8N4M2K9F5H6T1RZA",
  "action": "hotel.policy.updated",
  "occurredAt": "2026-11-04T14:32:10.123Z",
  "environment": "production",
  "outcome": "success",
  "severity": "info",
  "description": "Lina changed the cancellation policy of Hotel Sunrise",
  "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad", "email": "lina@example.com" },
  "impersonator": { "id": "usr_1", "name": "Lina (support)" },
  "executor": { "type": "worker", "id": "crm-worker", "name": "CRM worker", "jobId": "456", "attempt": 2 },
  "tenant": { "id": "biz_7", "name": "Azure Hotels" },
  "source": "channel-manager",
  "targets": [
    { "type": "hotel", "id": "hotel_123", "name": "Hotel Sunrise" },
    { "type": "website", "id": "web_a", "name": "azurehotels.com" }
  ],
  "changes": [{ "field": "cancellationHours", "before": 24, "after": 48 }],
  "context": {
    "operationId": "op_101",
    "parentEventId": "01JCDX3TZ2…",
    "requestId": "req_abc",
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "ip": "203.0.113.9",
    "userAgent": "Mozilla/5.0…"
  },
  "metadata": { "plan": "pro" },
  "schemaVersion": "1"
}`;
