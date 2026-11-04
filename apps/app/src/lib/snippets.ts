import type { AuditEvent } from '@trailmark/contracts';

/** Origin the SDK/curl should talk to. The app origin proxies `/v1` to the server. */
export function ingestOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost:4600' : window.location.origin;
}

export const SDK_INSTALL = 'pnpm add @trailmark/sdk';

export function sdkSnippet(key: string): string {
  return `import { Trailmark } from '@trailmark/sdk';

const trailmark = new Trailmark({
  apiKey: '${key}',
  endpoint: '${ingestOrigin()}',
});

trailmark.track({
  action: 'hotel.policy.updated',
  description: 'Raed changed the cancellation policy of Hotel Sunrise',
  actor: { type: 'user', id: 'usr_42', name: 'Raed' },
  tenant: { id: 'biz_7', name: 'Azure Hotels' },
  targets: [{ type: 'hotel', id: 'hotel_123', name: 'Hotel Sunrise' }],
  changes: [{ field: 'cancellationHours', before: 24, after: 48 }],
  context: { requestId: req.id },
});

// Events are batched and retried; flush before the process exits.
await trailmark.flush();`;
}

export function curlSnippet(key: string): string {
  return `curl -X POST ${ingestOrigin()}/v1/events \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "action": "user.signed_in",
    "outcome": "success",
    "actor": { "type": "user", "id": "usr_1", "name": "Ada" },
    "description": "Ada signed in"
  }'`;
}

export function readCurlSnippet(key: string): string {
  return `curl "${ingestOrigin()}/v1/events?q=outcome:failure&limit=20" \\
  -H "Authorization: Bearer ${key}"`;
}

/** "Copy as curl" for an event: fetch it through the public read API. */
export function eventCurl(event: AuditEvent): string {
  return `curl "${ingestOrigin()}/v1/events/${event.id}" \\
  -H "Authorization: Bearer $TRAILMARK_READ_KEY"`;
}

export const ENVELOPE_EXAMPLE = `{
  "id": "01JCDX3V7Q8N4M2K9F5H6T1RZA",
  "action": "hotel.policy.updated",
  "occurredAt": "2026-11-04T14:32:10.123Z",
  "environment": "production",
  "outcome": "success",
  "severity": "info",
  "description": "Raed changed the cancellation policy of Hotel Sunrise",
  "actor": { "type": "user", "id": "usr_42", "name": "Raed", "email": "raed@example.com" },
  "impersonator": { "id": "usr_1", "name": "Lina (support)" },
  "executor": { "type": "worker", "id": "crm-worker", "name": "CRM worker", "jobId": "456", "attempt": 2 },
  "tenant": { "id": "biz_7", "name": "Azure Hotels" },
  "source": "joodbooking",
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
