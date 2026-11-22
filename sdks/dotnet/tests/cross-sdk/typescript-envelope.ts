/**
 * Records the shared fixture event through the TypeScript SDK and writes the exact JSON it sends.
 * The .NET test CrossSdkTests must produce the same bytes. Run from the repository root:
 *   pnpm exec tsx sdks/dotnet/tests/cross-sdk/typescript-envelope.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Logbird } from '../../../../packages/sdk/src/index';

const output = 'sdks/dotnet/tests/Logbird.Tests/Fixtures/typescript-envelope.golden.txt';
let body = '';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  body = String(init?.body ?? '');
  return new Response(JSON.stringify({ accepted: 1, ids: [], rejected: [], warnings: [] }), { status: 202 });
}) as typeof fetch;

const client = new Logbird({ endpoint: 'https://audit.example.invalid', apiKey: 'lb_ingest_fictional' });
// Keys are listed in the order the .NET serializer writes them, so the comparison is byte for byte.
client.track({
  id: '0193f2b6-6c00-7abc-8def-0123456789ab',
  action: 'invoice.updated',
  occurredAt: '2026-11-22T08:00:00.123Z',
  environment: 'staging',
  outcome: 'success',
  severity: 'notice',
  description: 'Fictional user changed INV-1 مرحبا ✓ "quoted" \\ back, tab\t',
  actor: { type: 'user', id: 'user_42', name: 'Fictional User', email: 'fictional@example.invalid' },
  impersonator: { id: 'support_1', name: 'Support' },
  executor: { type: 'worker', id: 'billing-worker', name: 'Billing worker', jobId: 'job_1', attempt: 2 },
  tenant: { id: 'acct_7', name: 'Fictional Co' },
  source: 'billing-service',
  targets: [
    { type: 'invoice', id: 'inv_1', name: 'INV-1' },
    { type: 'customer', id: 'cus_9' },
  ],
  changes: [
    { field: 'status', before: 'draft', after: 'sent' },
    { field: 'limit', before: 24, after: 48 },
    { field: 'note', after: 'new' },
    { field: 'flags', before: null, after: { vip: true, tags: ['a', 'b'] } },
  ],
  context: {
    operationId: 'op_1',
    parentEventId: 'evt_parent',
    requestId: 'req_1',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    ip: '203.0.113.9',
    userAgent: 'Fictional/1.0',
  },
  metadata: { plan: 'pro', seats: 3, ratio: 1.5, nested: { ok: true, none: null } },
  schemaVersion: '1',
});
// The minimal envelope: the TypeScript SDK always adds empty context and metadata objects, and the server
// fingerprints the parsed input, so the .NET SDK must send the same shape for a replay to match.
client.track({ id: '0193f2b6-6c00-7abc-8def-0123456789ac', action: 'session.started', occurredAt: '2026-11-22T08:00:01.000Z' });
// Text the .NET encoder would otherwise change: an emoji (raw), a lone surrogate (escaped, never replaced), U+2028
// and DEL (raw), plus explicitly empty arrays, which are part of the server's identity fingerprint.
client.track({
  id: '0193f2b6-6c00-7abc-8def-0123456789ad',
  action: 'unicode.checked',
  occurredAt: '2026-11-22T08:00:02.000Z',
  description: 'emoji \u{1F600} lone \uD800 ls \u2028 del \u007F',
  targets: [],
  changes: [],
  context: {},
  metadata: { list: [1, 'two', null, { deep: [] }] },
});
// Number layout and key order follow JavaScript: integer-like keys first (ascending), 1.0 as 1, 1e21 and 1e-7 in
// exponent form, -0 as 0.
client.track({
  id: '0193f2b6-6c00-7abc-8def-0123456789ae',
  action: 'numbers.checked',
  occurredAt: '2026-11-22T08:00:03.000Z',
  context: {},
  metadata: { '10': 'a', b: 'x', '2': 'y', '01': 'z', ratio: 1.5, one: 1.0, big: 1e21, tiny: 1e-7, neg0: -0, tenth: 0.1, max: 9_007_199_254_740_991 },
});
await client.shutdown();
globalThis.fetch = realFetch;

const events: unknown[] = JSON.parse(body).events;
// Re-serializing each parsed event keeps key order and escapes, matching what the SDK sent.
const lines = events.map((event) => JSON.stringify(event));
if (events.length !== 4 || !lines.every((line) => body.includes(line))) throw new Error('Unexpected TypeScript SDK body shape');
const event = `${lines.join('\n')}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== event) throw new Error(`${output} is stale: run this script without --check`);
  console.log('typescript-envelope.golden.txt matches the TypeScript SDK');
} else {
  writeFileSync(output, event);
  console.log(`wrote ${output}`);
}
