/**
 * Checks the soak stand-in against the contracts: every answer it gave and every batch it accepted, as sampled in
 * stand-in-samples.jsonl by sdks/dotnet/tests/Logbird.Soak. Run from the repository root:
 *   pnpm exec tsx sdks/dotnet/tests/cross-sdk/validate-stand-in.ts <report-dir>/stand-in-samples.jsonl
 * A stand-in that answered in a shape the server never uses, or accepted an event the server's schema refuses, would
 * make the soak's accounting meaningless, so any mismatch fails.
 */
import { readFileSync } from 'node:fs';
import { apiErrorSchema } from '../../../../packages/contracts/src/api';
import { eventInputSchema, ingestBodySchema, ingestPendingDetailsSchema, ingestResponseSchema } from '../../../../packages/contracts/src/events';

const file = process.argv[2];
if (!file) throw new Error('usage: validate-stand-in.ts <stand-in-samples.jsonl>');

// The server's error codes for the answers the stand-in imitates (apps/server: immutable-ingest.ts, rate-limit.ts, app.ts).
const errorCodes: Record<number, readonly string[]> = {
  400: ['invalid_body', 'validation_error'],
  404: ['not_found'],
  413: ['payload_too_large'],
  429: ['rate_limited'],
  503: ['ingest_pending', 'ingest_unavailable'],
};

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const counts: Record<string, number> = {};
const failures: string[] = [];
for (const [number, line] of lines.entries()) {
  const sample = JSON.parse(line) as { kind: string; status?: number; body: unknown };
  const key = sample.kind === 'request' ? 'request' : `response ${sample.status}`;
  counts[key] = (counts[key] ?? 0) + 1;
  const fail = (why: string) => failures.push(`line ${number + 1} (${key}): ${why}`);
  if (sample.kind === 'request') {
    // Every batch the stand-in accepted must be one the server's schemas accept.
    const body = ingestBodySchema.safeParse(sample.body);
    if (!body.success) fail(`body: ${body.error.message}`);
    const events = (sample.body as { events?: unknown[] }).events ?? [];
    for (const [index, event] of events.entries()) {
      const parsed = eventInputSchema.safeParse(event);
      if (!parsed.success) fail(`event ${index}: ${parsed.error.message}`);
    }
    continue;
  }

  if (sample.status === 202) {
    // An empty object is the deliberate "proxy answered for the server" fault; anything else must be the server's shape.
    if (JSON.stringify(sample.body) === '{}') continue;
    const parsed = ingestResponseSchema.strict().safeParse(sample.body);
    if (!parsed.success) fail(parsed.error.message);
    continue;
  }

  const error = apiErrorSchema.safeParse(sample.body);
  if (!error.success) {
    fail(error.error.message);
    continue;
  }

  const allowed = errorCodes[sample.status ?? 0];
  if (!allowed?.includes(error.data.error.code)) fail(`code ${error.data.error.code} is not a code the server answers with ${sample.status}`);
  if (sample.status === 503 && error.data.error.details !== undefined) {
    const details = ingestPendingDetailsSchema.strict().safeParse(error.data.error.details);
    if (!details.success) fail(`details: ${details.error.message}`);
  }
}

console.log(
  `checked ${lines.length} stand-in samples: ${Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}`,
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

if (!counts.request || !counts['response 202']) {
  console.error('the samples hold no accepted batch or no 202 answer; the soak did not exercise the stand-in');
  process.exit(1);
}
