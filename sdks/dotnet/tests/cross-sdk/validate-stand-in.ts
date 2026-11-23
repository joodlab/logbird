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
  undecodable?: boolean;
  delayMs?: number | null;
  passthrough?: boolean;
};

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const config = JSON.parse(lines[0] ?? '{}') as { kind?: unknown; mode?: unknown; faults?: unknown };
const faultWeights =
  config.faults && typeof config.faults === 'object' && !Array.isArray(config.faults) ? (config.faults as Record<string, unknown>) : {};
if (config.kind !== 'config' || (config.mode !== 'stand-in' && config.mode !== 'upstream')) throw new Error('the first line must be the config line');
if (!Object.values(faultWeights).every((w) => typeof w === 'number' && Number.isInteger(w) && w >= 0))
  throw new Error('every fault weight must be a whole number');
if (!Object.values(faultWeights).some((w) => (w as number) > 0)) throw new Error('the config lists no fault with a positive weight');
const dispositionValues = new Set(['accepted', 'rejected', 'unresolved']);
const exchanges = lines.slice(1).map((line, index) => {
  const x = JSON.parse(line) as Exchange;
  const shaped =
    x?.kind === 'exchange' &&
    typeof x.fault === 'string' &&
    (x.status === null || typeof x.status === 'number') &&
    (x.retryAfter === null || typeof x.retryAfter === 'string') &&
    'request' in x &&
    'response' in x &&
    Array.isArray(x.dispositions) &&
    x.dispositions.every((d) => dispositionValues.has(d)) &&
    (x.undecodable === undefined || typeof x.undecodable === 'boolean') &&
    (x.delayMs === undefined || x.delayMs === null || typeof x.delayMs === 'number') &&
    (x.passthrough === undefined || typeof x.passthrough === 'boolean');
  if (!shaped) throw new Error(`line ${index + 2} is not an exchange record`);
  return x;
});
if (exchanges.length === 0) throw new Error('the samples hold no exchange');
const failures: string[] = [];
const seenFaults = new Map<string, number>();

/** The events of an ingest body, the way the server reads it: an array, { events }, or one event. */
const eventsOf = (body: unknown): unknown[] =>
  Array.isArray(body) ? body : body && typeof body === 'object' && 'events' in body ? ((body as { events: unknown[] }).events ?? []) : [body];
const idOf = (event: unknown) =>
  event && typeof event === 'object' && typeof (event as { id?: unknown }).id === 'string' ? (event as { id: string }).id.trim() : undefined;

/**
 * Every event is settled exactly once: by index in rejected or unresolved, otherwise by its id in ids. Returns what the
 * answer says happened to each event, in order.
 */
function settle(
  fail: (why: string) => void,
  events: unknown[],
  result: { accepted: number; ids: string[]; rejected: { index: number }[]; indices?: number[]; eventIds?: string[] },
): string[] {
  const outcome: string[] = events.map(() => 'unsettled');
  if (result.accepted !== result.ids.length) fail(`accepted ${result.accepted} but ${result.ids.length} ids`);
  if ((result.indices ?? []).length !== (result.eventIds ?? []).length)
    fail(`${result.indices?.length ?? 0} unresolved indices but ${result.eventIds?.length ?? 0} eventIds`);
  for (const r of result.rejected) {
    if (r.index < 0 || r.index >= events.length || outcome[r.index] !== 'unsettled') fail(`rejected index ${r.index} out of range or repeated`);
    else outcome[r.index] = 'rejected';
  }

  for (const [k, index] of (result.indices ?? []).entries()) {
    if (index < 0 || index >= events.length || outcome[index] !== 'unsettled') fail(`unresolved index ${index} out of range or repeated`);
    else outcome[index] = 'unresolved';
    if (result.eventIds?.[k] !== idOf(events[index])) fail(`eventIds[${k}] does not name the event at index ${index}`);
  }

  // Events with an id take theirs first; an event without an id (or a blank one) takes one remaining id, which the
  // server generated for it.
  const ids = [...result.ids];
  for (let index = 0; index < events.length; index++) {
    const id = idOf(events[index]);
    if (outcome[index] !== 'unsettled' || !id) continue;
    const at = ids.indexOf(id);
    if (at < 0) fail(`event ${index} is neither rejected, unresolved nor in ids`);
    else {
      ids.splice(at, 1);
      outcome[index] = 'accepted';
    }
  }

  for (let index = 0; index < events.length; index++) {
    if (outcome[index] !== 'unsettled') continue;
    // The server generates a non-empty id (uuidv7) for an event without one.
    const generated = ids.findIndex((candidate) => candidate.trim().length > 0);
    if (generated < 0) fail(`event ${index} is neither rejected, unresolved nor given a generated id`);
    else {
      ids.splice(generated, 1);
      outcome[index] = 'accepted';
    }
  }

  if (ids.length) fail(`${ids.length} ids in the answer match no event of the batch`);
  return outcome;
}

for (const [number, x] of exchanges.entries()) {
  const key = `${x.fault} ${x.status ?? 'no answer'}`;
  const fail = (why: string) => failures.push(`line ${number + 2} (${key}): ${why}`);
  // A fault counts as exercised only when its exchange shows that fault's own answer. Whole-request errors (a body the
  // server refuses, a bad key, an oversized request) may answer first; any other answer is a mismatch.
  const code = (x.response as { error?: { code?: unknown } } | null)?.error?.code;
  const wholeRequest = x.status !== null && [400, 401, 422].includes(x.status);
  // Is this answer legal for the fault, and does it prove the fault happened? An ordinary 202 is a legal answer to the
  // partial and reject faults (the stand-in picks events at random), but only a visible effect earns coverage.
  const details = (x.response as { error?: { details?: { indices?: unknown[] } } } | null)?.error?.details;
  const rejected = (x.response as { rejected?: { code?: unknown; reason?: unknown }[] } | null)?.rejected ?? [];
  const legal: Record<string, boolean> = {
    RateLimited: x.status === 429 && code === 'rate_limited',
    Unavailable: x.status === 503 && code === 'ingest_unavailable',
    TooLarge: x.status === 413 && code === 'payload_too_large',
    Reset: x.status === null,
    Hang: x.status === null,
    ResetAfterStore: x.status === null,
    EmptyAck: x.status === 202 && JSON.stringify(x.response) === '{}',
    PartialUnavailable: (x.status === 503 && code === 'ingest_pending') || x.status === 202,
    Reject: x.status === 202,
    Ok: true,
    Latency: true,
  };
  const covers: Record<string, boolean> = {
    ...legal,
    PartialUnavailable: x.status === 503 && code === 'ingest_pending' && Array.isArray(details?.indices) && details.indices.length > 0,
    // Only the stand-in's injected rejections carry this marker; a validation rejection shares the code, not the reason.
    Reject:
      x.status === 202 &&
      Array.isArray(rejected) &&
      rejected.some((r) => r?.code === 'invalid_event' && typeof r.reason === 'string' && r.reason.endsWith('(fault injection)')),
    Latency: typeof x.delayMs === 'number' && x.delayMs > 0,
  };
  // Upstream mode: a passthrough answer is the server's own, forwarded unchanged because the fault did not apply (for
  // example a 429 from the server during emptyack). It is legal for any fault and validated as a server answer below,
  // but it earns no fault-specific coverage.
  if (covers[x.fault] === true && (!x.passthrough || x.fault === 'Ok' || x.fault === 'Latency'))
    seenFaults.set(x.fault, (seenFaults.get(x.fault) ?? 0) + 1);
  if (!x.passthrough && legal[x.fault] !== true && !wholeRequest && !(x.status === 413 && code === 'payload_too_large'))
    fail(`the ${x.fault} fault answered ${x.status ?? 'nothing'} ${code ?? ''}`.trim());

  // A request .NET could not re-encode (a lone surrogate) is sampled without its body: only its status and code, above.
  if (x.undecodable) continue;
  // In stand-in mode, every event the stand-in stored must be one the server's schema accepts, also when the answer
  // acknowledges nothing (a reset after storing, or 202 {}).
  const requestEvents = x.request === null || x.request === undefined ? [] : eventsOf(x.request);
  if (config.mode === 'stand-in') {
    for (const [index, disposition] of x.dispositions.entries()) {
      if (disposition !== 'accepted') continue;
      const parsed = eventInputSchema.safeParse(requestEvents[index]);
      if (!parsed.success) failures.push(`line ${number + 2} (${key}): stored event ${index} is invalid by the contracts: ${parsed.error.message}`);
    }
  }

  // Only the store path records dispositions: one per event for an answer that settles events, a reset after storing,
  // or 202 {}; none for an answer about the whole request (401, 400, 422, 413, 429, 503 unavailable) or a reset or hang
  // before the body was read.
  const stores =
    ((x.fault === 'ResetAfterStore' || x.fault === 'EmptyAck') && (x.status === null || x.status === 202)) ||
    x.status === 202 ||
    (x.status === 503 && code === 'ingest_pending');
  if (config.mode === 'stand-in' && !stores && x.dispositions.length)
    fail(`dispositions ${JSON.stringify(x.dispositions)} on an answer about the whole request`);
  // A reset after storing, or 202 {}, stored every valid event first (a 401 or 413 answering these faults stored nothing).
  const storedUnanswered = (x.fault === 'ResetAfterStore' || x.fault === 'EmptyAck') && (x.status === null || x.status === 202);
  if (config.mode === 'stand-in' && storedUnanswered && x.dispositions.length !== requestEvents.length) {
    fail(`${x.dispositions.length} dispositions for ${requestEvents.length} stored events`);
  }

  if (x.status === null) {
    // Resets and hangs never answer; nothing else may end without an answer.
    if (!['Reset', 'Hang', 'ResetAfterStore'].includes(x.fault)) fail('no answer for a fault that must answer');
    continue;
  }

  const events = x.request === null || x.request === undefined ? [] : eventsOf(x.request);
  let outcome: string[] | undefined;
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

    outcome = settle(fail, events, parsed.data);
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
      else outcome = settle(fail, events, details.data);
    } else if (error.data.error.details !== undefined) {
      fail(`${code} carries details the server does not send`);
    }
  }

  if (!outcome) continue;

  // Every event the answer acknowledges must be one the server's schema accepts.
  for (const [index, result] of outcome.entries()) {
    if (result !== 'accepted') continue;
    const parsed = eventInputSchema.safeParse(events[index]);
    if (!parsed.success) fail(`acknowledged event ${index} is invalid by the contracts: ${parsed.error.message}`);
  }

  // In stand-in mode the stand-in also records what it did with each event: it must match the answer exactly.
  if (config.mode === 'stand-in' && JSON.stringify(x.dispositions) !== JSON.stringify(outcome)) {
    fail(`dispositions ${JSON.stringify(x.dispositions)} do not match the answer ${JSON.stringify(outcome)}`);
  }
}

// Every configured fault must have been exercised and sampled.
for (const [fault, weight] of Object.entries(faultWeights)) {
  if (typeof weight === 'number' && weight > 0 && !seenFaults.has(fault))
    failures.push(`fault ${fault} (weight ${weight}) never appears in the samples`);
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
