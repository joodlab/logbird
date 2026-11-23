/**
 * Checks the soak stand-in against the contracts and the server's rules: every sampled exchange (request, fault,
 * status, Retry-After, answer, per-event disposition) written to stand-in-samples.jsonl by sdks/dotnet/tests/Logbird.Soak.
 * Run from the repository root:
 *   pnpm exec tsx sdks/dotnet/tests/cross-sdk/validate-stand-in.ts <report-dir>/stand-in-samples.jsonl
 * A stand-in that answered in a shape or with a code the server never uses, settled a batch inconsistently, or accepted
 * an event the server's schema refuses would make the soak's accounting meaningless, so any mismatch fails.
 */
import { readFileSync } from 'node:fs';
import { apiErrorSchema } from '../../../../packages/contracts/src/api';
import { eventInputSchema, ingestPendingDetailsSchema, ingestResponseSchema } from '../../../../packages/contracts/src/events';

const file = process.argv[2];
if (!file) throw new Error('usage: validate-stand-in.ts <stand-in-samples.jsonl>');

// The server's code for each error status the stand-in imitates (apps/server: ingest.ts, rate-limit.ts,
// immutable-ingest.ts, app.ts body limit).
const errorCodes: Record<number, readonly string[]> = {
  400: ['invalid_json'],
  401: ['invalid_api_key'],
  404: ['not_found'],
  413: ['payload_too_large'],
  422: ['validation_error'],
  429: ['rate_limited'],
  503: ['ingest_pending', 'ingest_unavailable'],
};

type Exchange = {
  kind: 'exchange';
  fault: string;
  status: number | null;
  retryAfter: string | null;
  request: unknown;
  response: unknown;
  dispositions: string[];
};

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const config = JSON.parse(lines[0] ?? '{}') as { kind?: string; mode?: string; faults?: Record<string, number> };
if (config.kind !== 'config') throw new Error('the first line must be the config line');
const exchanges = lines.slice(1).map((line) => JSON.parse(line) as Exchange);
const failures: string[] = [];
const seenFaults = new Map<string, number>();

/** The events of an ingest body, the way the server reads it: an array, { events }, or one event. */
const eventsOf = (body: unknown): unknown[] =>
  Array.isArray(body) ? body : body && typeof body === 'object' && 'events' in body ? ((body as { events: unknown[] }).events ?? []) : [body];
const idOf = (event: unknown) =>
  event && typeof event === 'object' && typeof (event as { id?: unknown }).id === 'string' ? (event as { id: string }).id.trim() : undefined;

/** Every event is settled exactly once: by index in rejected or unresolved, otherwise by its id in ids. */
function checkCoverage(
  fail: (why: string) => void,
  events: unknown[],
  result: { accepted: number; ids: string[]; rejected: { index: number }[]; indices?: number[]; eventIds?: string[] },
) {
  if (result.accepted !== result.ids.length) fail(`accepted ${result.accepted} but ${result.ids.length} ids`);
  const byIndex = new Set<number>();
  for (const r of result.rejected) {
    if (r.index < 0 || r.index >= events.length || byIndex.has(r.index)) fail(`rejected index ${r.index} out of range or repeated`);
    byIndex.add(r.index);
  }

  for (const [k, index] of (result.indices ?? []).entries()) {
    if (index < 0 || index >= events.length || byIndex.has(index)) fail(`unresolved index ${index} out of range or repeated`);
    byIndex.add(index);
    if (result.eventIds?.[k] !== idOf(events[index])) fail(`eventIds[${k}] does not name the event at index ${index}`);
  }

  const ids = [...result.ids];
  for (let index = 0; index < events.length; index++) {
    if (byIndex.has(index)) continue;
    const id = idOf(events[index]);
    const at = id === undefined ? -1 : ids.indexOf(id);
    if (at < 0) fail(`event ${index} is neither rejected, unresolved nor in ids`);
    else ids.splice(at, 1);
  }

  if (ids.length) fail(`${ids.length} ids in the answer match no event of the batch`);
}

for (const [number, x] of exchanges.entries()) {
  const key = `${x.fault} ${x.status ?? 'no answer'}`;
  const fail = (why: string) => failures.push(`line ${number + 2} (${key}): ${why}`);
  seenFaults.set(x.fault, (seenFaults.get(x.fault) ?? 0) + 1);
  if (x.status === null) {
    // Resets and hangs never answer; nothing else may end without an answer.
    if (!['Reset', 'Hang', 'ResetAfterStore'].includes(x.fault)) fail('no answer for a fault that must answer');
    continue;
  }

  const events = x.request === null || x.request === undefined ? [] : eventsOf(x.request);
  if (x.status === 202) {
    if (JSON.stringify(x.response) === '{}') {
      if (x.fault !== 'EmptyAck') fail('202 {} is only the EmptyAck fault');
      continue;
    }

    const parsed = ingestResponseSchema.strict().safeParse(x.response);
    if (!parsed.success) {
      fail(parsed.error.message);
      continue;
    }

    checkCoverage(fail, events, parsed.data);
  } else {
    const error = apiErrorSchema.safeParse(x.response);
    if (!error.success) {
      fail(error.error.message);
      continue;
    }

    const code = error.data.error.code;
    if (!errorCodes[x.status]?.includes(code)) fail(`code ${code} is not one the server answers with ${x.status}`);
    if ((x.status === 429 || x.status === 503) && !/^\d+$/.test(x.retryAfter ?? '')) fail(`${x.status} without a Retry-After in seconds`);
    if (code === 'ingest_pending') {
      // The server always sends details with ingest_pending.
      const details = ingestPendingDetailsSchema.strict().safeParse(error.data.error.details);
      if (!details.success) fail(`details: ${details.error.message}`);
      else checkCoverage(fail, events, details.data);
    } else if (error.data.error.details !== undefined) {
      fail(`${code} carries details the server does not send`);
    }
  }

  // Stand-in mode records what it did with each event; accepted events must be valid by the contracts.
  if (config.mode === 'stand-in' && x.dispositions.length) {
    if (x.dispositions.length !== events.length) fail(`${x.dispositions.length} dispositions for ${events.length} events`);
    for (const [index, disposition] of x.dispositions.entries()) {
      if (disposition !== 'accepted') continue;
      const parsed = eventInputSchema.safeParse(events[index]);
      if (!parsed.success) fail(`accepted event ${index} is invalid by the contracts: ${parsed.error.message}`);
    }
  }
}

// Every configured fault must have been exercised and sampled.
for (const [fault, weight] of Object.entries(config.faults ?? {})) {
  if (weight > 0 && !seenFaults.has(fault)) failures.push(`fault ${fault} (weight ${weight}) never appears in the samples`);
}

console.log(
  `checked ${exchanges.length} stand-in exchanges (${config.mode}): ${[...seenFaults]
    .sort()
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}`,
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
