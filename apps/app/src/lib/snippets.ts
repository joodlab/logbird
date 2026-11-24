import type { AuditEvent, ReadScope } from '@logbird/contracts';

/** Origin the SDK/curl should talk to. The app origin proxies `/v1` to the server. */
export function ingestOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost:4600' : window.location.origin;
}

/**
 * Whether `@logbird/sdk` is on npm. Until it is, the TypeScript tab installs it the way packages/sdk/README.md does
 * (linked from a Logbird checkout): `pnpm add @logbird/sdk` answers 404 today. When the package is published, flip this
 * one value (T4 holds the publication-state PRs) and every install line follows.
 */
export const SDK_PUBLISHED = false;

/** The SDK install, one line each, shown as comments above the TypeScript snippet. */
export const SDK_INSTALL = SDK_PUBLISHED
  ? 'pnpm add @logbird/sdk'
  : `@logbird/sdk is not on npm yet. Link it from a Logbird checkout
(packages/sdk/README.md):
git clone https://github.com/joodlab/logbird.git ../logbird
pnpm -C ../logbird install
pnpm add @logbird/sdk@link:../logbird/packages/sdk`;

/** SDK_INSTALL as comment lines for the top of the TypeScript snippet. */
export const sdkInstallComment = () =>
  SDK_INSTALL.split('\n')
    .map((line) => `// ${line}`)
    .join('\n');

/**
 * Snippets are meant to be pasted and run as-is. With a freshly created secret they embed it, for a first run; without
 * one they read the key from the environment instead of showing a fake placeholder. Either way they say the key belongs
 * in an environment variable, never in committed code. Lines stay short enough for the console's code panel.
 */
const INGEST_ENV = 'LOGBIRD_INGEST_KEY';
const READ_ENV = 'LOGBIRD_READ_KEY';

/** The site's sentences (apps/web/src/content/developers.ts), so the console and the site read as one product. */
const OWN_ID = ['Send your own string id: a retry with the same id is', 'the same event, not a new one.'];
const ACK = ['A 202 lists the stored event IDs in `ids` and', 'rejected events in `rejected`.'];
const comment = (prefix: string, lines: readonly string[]) => lines.map((line) => `${prefix} ${line}`).join('\n');
/** Where the pasted first-run key should live in the person's own code. */
const keyNote = (prefix: string, indent = '') =>
  `${indent}${prefix} For this first run only. In your app, read ${INGEST_ENV}\n${indent}${prefix} from the environment; never commit a key.`;

/** `@logbird/sdk`: `new Logbird({ apiKey, endpoint })`, `track()` queues, `flush()`/`shutdown()` deliver. */
export function sdkSnippet(key?: string): string {
  const apiKey = key
    ? `${keyNote('//', '  ')}\n  apiKey: '${key}',`
    : `  // Keep the key in the environment; never commit it.\n  apiKey: process.env.${INGEST_ENV}!,`;
  return `import { Logbird } from '@logbird/sdk';

const logbird = new Logbird({
  // Your Logbird origin. In your app: process.env.LOGBIRD_ENDPOINT.
  endpoint: '${ingestOrigin()}',
${apiKey}
  // Errors, events the server rejects, failed background flushes.
  onError: (error) => console.error('[logbird]', error.message),
});

// track() never throws. It gives the event an id, queues it and
// sends it in batches; a retry reuses the id.
logbird.track({
  action: 'hotel.policy.updated',
  outcome: 'success',
  description: 'Lina changed the cancellation policy of Hotel Sunrise',
  actor: { type: 'user', id: 'usr_42', name: 'Lina Haddad' },
  tenant: { id: 'biz_7', name: 'Azure Hotels' },
  targets: [{ type: 'hotel', id: 'hotel_123', name: 'Hotel Sunrise' }],
  changes: [{ field: 'cancellationHours', before: 24, after: 48 }],
});

// On exit: deliver what is queued. It can reject, for example
// when the server stays unreachable.
await logbird
  .shutdown()
  .catch((error) => console.error('[logbird] undelivered', error));`;
}

export function curlSnippet(key?: string): string {
  return `${comment('#', OWN_ID)}
${comment(
  '#',
  [...ACK.slice(0, 1), `${ACK[1]} An empty "rejected" means stored:`].map((l) => l.replace(/`/g, '"')),
)}
#   {"accepted":1,"ids":["evt_hotel_123_policy_1"],"rejected":[],
#    "warnings":[]}
curl -X POST "${ingestOrigin()}/v1/events" \\
  -H "Authorization: Bearer ${key ?? `$${INGEST_ENV}`}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "evt_hotel_123_policy_1",
    "action": "hotel.policy.updated",
    "outcome": "success",
    "description": "Lina changed the cancellation policy of Hotel Sunrise",
    "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
    "tenant": { "id": "biz_7", "name": "Azure Hotels" },
    "targets": [{ "type": "hotel", "id": "hotel_123", "name": "Hotel Sunrise" }],
    "changes": [{ "field": "cancellationHours", "before": 24, "after": 48 }]
  }'`;
}

/**
 * C# (.NET 8+): a plain `HttpClient` POST, no package. The Logbird package for .NET is not published yet, so no install
 * command and no package name here; this works today.
 */
export function dotnetSnippet(key?: string): string {
  const auth = key
    ? `${keyNote('//')}\nhttp.DefaultRequestHeaders.Authorization = new("Bearer", "${key}");`
    : `http.DefaultRequestHeaders.Authorization =\n    new("Bearer", Environment.GetEnvironmentVariable("${INGEST_ENV}"));`;
  return `using System.Net.Http.Json;

using var http = new HttpClient();
${auth}

${comment('//', OWN_ID)} Keep it for retries.
var id = Guid.NewGuid().ToString();
var response = await http.PostAsJsonAsync("${ingestOrigin()}/v1/events", new
{
    id,
    action = "hotel.policy.updated",
    outcome = "success",
    description = "Lina changed the cancellation policy of Hotel Sunrise",
    actor = new { type = "user", id = "usr_42", name = "Lina Haddad" },
    tenant = new { id = "biz_7", name = "Azure Hotels" },
    targets = new[] { new { type = "hotel", id = "hotel_123", name = "Hotel Sunrise" } },
    changes = new[] { new { field = "cancellationHours", before = 24, after = 48 } },
});
if (response.StatusCode != System.Net.HttpStatusCode.Accepted)
    throw new Exception($"Logbird answered {(int)response.StatusCode}: " +
        await response.Content.ReadAsStringAsync());
${comment('//', ACK)}
var result = await response.Content.ReadFromJsonAsync<IngestResult>();
if (result!.rejected.Length > 0)
    throw new Exception("Logbird rejected the event: " +
        string.Join("; ", result.rejected.Select(r => r.reason)));
Console.WriteLine($"Stored {string.Join(", ", result.ids)}");

record IngestResult(string[] ids, Rejection[] rejected);
record Rejection(int index, string code, string reason);`;
}

/** Plain `fetch` (Node 18+, Deno, Bun, edge runtimes): no dependency at all. */
export function fetchSnippet(key?: string): string {
  const auth = key ? `${keyNote('//', '    ')}\n    Authorization: 'Bearer ${key}',` : `    Authorization: \`Bearer \${process.env.${INGEST_ENV}}\`,`;
  return `${comment('//', OWN_ID)} Keep it for retries.
const id = crypto.randomUUID();
const response = await fetch('${ingestOrigin()}/v1/events', {
  method: 'POST',
  headers: {
${auth}
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    id,
    action: 'hotel.policy.updated',
    outcome: 'success',
    description: 'Lina changed the cancellation policy of Hotel Sunrise',
    actor: { type: 'user', id: 'usr_42', name: 'Lina Haddad' },
    tenant: { id: 'biz_7', name: 'Azure Hotels' },
    targets: [{ type: 'hotel', id: 'hotel_123', name: 'Hotel Sunrise' }],
    changes: [{ field: 'cancellationHours', before: 24, after: 48 }],
  }),
});
if (response.status !== 202)
  throw new Error(\`Logbird answered \${response.status}: \${await response.text()}\`);
${comment('//', ACK)}
const { ids, rejected } = await response.json();
if (rejected.length)
  throw new Error(\`Logbird rejected the event: \${rejected.map((r) => r.reason).join('; ')}\`);
console.log('Stored', ids);`;
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
