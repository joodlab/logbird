import {
  AmbiguousInsertError,
  type EventRow,
  INGEST_ASYNC_MAX_DATA_SIZE,
  INGEST_CLAIM_LEASE_MS,
  InsertLeaseExhaustedError,
  normalizeEvent,
} from '@logbird/clickhouse';
import { afterEach, expect, it, vi } from 'vitest';
import { isolateIngestRows, MAX_PARSE_ISOLATION_MS, MAX_PARSE_ISOLATION_STATEMENTS } from './ingest-parse-isolation';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const parseError = (row?: number) =>
  Object.assign(new Error(`Cannot parse fixture ${row === undefined ? '' : `(at row ${row})`}: While executing WaitForAsyncInsert.`), { code: '25' });
function rows(n: number) {
  return Array.from({ length: n }, (_, index) => {
    const normalized = normalizeEvent({ id: `row-${index}`, action: 'qa91.unit' }, { projectId: 'qa91-unit', receivedAt: new Date() });
    if (!normalized.ok) throw new Error(normalized.reason);
    return normalized.row;
  });
}
const lease = () => Date.now() + INGEST_CLAIM_LEASE_MS;
function uniqueBodies(insert: ReturnType<typeof vi.fn>) {
  const bodies = insert.mock.calls.map(([part]) => JSON.stringify(part));
  expect(new Set(bodies).size).toBe(bodies.length);
}
it('writes each reported prefix before rejecting the named row and continuing with the suffix', async () => {
  const input = rows(1000),
    bad = new Set([input[5], input[500], input[998]]);
  const insert = vi.fn(async (part: EventRow[]) => {
    const index = part.findIndex((r) => bad.has(r));
    if (index >= 0) throw parseError(index + 1);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(result.rejected).toEqual([...bad]);
  expect(result.written).toEqual(input.filter((r) => !bad.has(r)));
  expect(insert.mock.calls.map(([part]) => part.length)).toEqual([1000, 1, 5, 994, 1, 494, 499, 1, 497, 1]);
  for (const row of result.rejected) expect(insert.mock.calls.some(([part]) => part.length === 1 && part[0] === row)).toBe(true);
  uniqueBodies(insert);
});
it('proves a named row with a singleton canary before rejecting it', async () => {
  const input = rows(5);
  const insert = vi.fn(async (part: EventRow[]) => {
    const index = part.indexOf(input[2]!);
    if (index >= 0) throw parseError(index + 1);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(insert.mock.calls.map(([part]) => part)).toEqual([input, [input[2]], input.slice(0, 2), input.slice(3)]);
  expect(result.rejected).toEqual([input[2]]);
  expect(result.written).toEqual([input[0], input[1], input[3], input[4]]);
  uniqueBodies(insert);
});
it('reads the real row number after an input excerpt that contains a fake one', async () => {
  const input = rows(5);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const insert = vi.fn(async (part: EventRow[]) => {
    const index = part.indexOf(input[2]!);
    // ClickHouse prints the excerpt (here a row value carrying "(at row 1)") before the real row number.
    if (index >= 0)
      throw Object.assign(new Error(`Cannot parse input: before: 'x (at row 1)': (at row ${index + 1}): While executing WaitForAsyncInsert.`), {
        code: '27',
      });
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(insert.mock.calls.map(([part]) => part)).toEqual([input, [input[2]], input.slice(0, 2), input.slice(3)]);
  expect(result.rejected).toEqual([input[2]]);
  expect(warning).not.toHaveBeenCalled();
  uniqueBodies(insert);
});
it('canaries later named rows even after the first row number was correct', async () => {
  const input = rows(8);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.includes(input[1]!)) throw parseError(part.indexOf(input[1]!) + 1);
    // The second report names a healthy row; only the final row is actually bad.
    if (part.includes(input[7]!)) throw parseError(1);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(result.rejected).toEqual([input[1], input[7]]);
  expect(new Set(result.written)).toEqual(new Set(input.filter((_, index) => index !== 1 && index !== 7)));
  expect(warning).toHaveBeenCalledOnce();
  for (const row of result.rejected) expect(insert.mock.calls.some(([part]) => part.length === 1 && part[0] === row)).toBe(true);
  uniqueBodies(insert);
});

// Exercise the actual 64 MiB boundary with cached byte lengths, without allocating huge fixture strings.
function cachedRowSizes(input: EventRow[], sizes: number[]) {
  const lengths = new Map(input.map((row, index) => [`${JSON.stringify(row)}\n`, sizes[index]!]));
  const byteLength = Buffer.byteLength;
  vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => lengths.get(String(value)) ?? byteLength(value, encoding));
}
it('chunks consecutive rows at the inclusive async pin and merges independent outcomes', async () => {
  const input = rows(6),
    pin = INGEST_ASYNC_MAX_DATA_SIZE;
  cachedRowSizes(input, [pin / 2, pin / 2, 1, pin, pin + 1, 1]);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part[0] === input[2]) throw parseError(1);
    if (part[0] === input[3]) throw Object.assign(new Error('Unknown table'), { code: '60' });
    if (part[0] === input[4]) throw new AmbiguousInsertError();
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(insert.mock.calls.map(([part]) => part)).toEqual([input.slice(0, 2), [input[2]], [input[3]], [input[4]], [input[5]]]);
  expect(result.written).toEqual([input[0], input[1], input[5]]);
  expect(result.rejected).toEqual([input[2]]);
  expect(result.unavailable).toEqual([input[3]]);
  expect(result.pending).toEqual([input[4]]);
  expect(result.unresolved).toEqual([]);
});
it('shares the statement cap across chunks', async () => {
  const input = rows(70);
  cachedRowSizes(
    input,
    input.map(() => INGEST_ASYNC_MAX_DATA_SIZE),
  );
  const insert = vi.fn(async () => {
    throw parseError(1);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(insert).toHaveBeenCalledTimes(1 + MAX_PARSE_ISOLATION_STATEMENTS);
  expect(result.rejected).toEqual(input.slice(0, 65));
  expect(result.unresolved).toEqual(input.slice(65));
  expect(result.limitReason).toBe('statements');
});
it('computes the shared byte budget over all chunks', async () => {
  const input = rows(101),
    pin = INGEST_ASYNC_MAX_DATA_SIZE;
  const rowBytes = Math.floor(pin / 100);
  cachedRowSizes(input, [...input.slice(0, 100).map(() => rowBytes), pin]);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part[0] !== input[100]) throw parseError(1);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  // One chunk alone stops at five bad rows. The second chunk contributes to the global budget.
  expect(result.rejected.length).toBeGreaterThan(5);
  expect(result.written).toEqual([]);
  expect(result.unresolved).toContain(input[100]); // The next chunk does not get a fresh byte budget.
  expect(result.limitReason).toBe('bytes');
  const sizes = new Map(input.map((row, index) => [row, index === 100 ? pin : rowBytes]));
  const extraBytes = insert.mock.calls.slice(1).reduce((sum, [part]) => sum + part.reduce((n, row) => n + sizes.get(row)!, 0), 0);
  expect(extraBytes).toBeLessThanOrEqual(4 * (100 * rowBytes + pin));
});
it.each(['wall clock', 'lease'] as const)('shares the %s deadline across chunks', async (cap) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const input = rows(3),
    expires = cap === 'lease' ? Date.now() + 45_000 : lease();
  cachedRowSizes(
    input,
    input.map(() => INGEST_ASYNC_MAX_DATA_SIZE),
  );
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part[0] === input[0]) throw parseError(1);
    vi.setSystemTime(Date.now() + (cap === 'lease' ? 6000 : MAX_PARSE_ISOLATION_MS));
  });
  const result = await isolateIngestRows(input, expires, insert);
  expect(result.rejected).toEqual([input[0]]);
  expect(result.written).toEqual([input[1]]);
  expect(result.unresolved).toEqual([input[2]]);
  expect(result.limitReason).toBe(cap === 'lease' ? 'lease' : 'wall_clock');
});
it('writes a healthy canary, logs a row-number mismatch and bisects for the rest of the attempt', async () => {
  const input = rows(8),
    bad = new Set([input[3], input[7]]);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const insert = vi.fn(async (part: EventRow[]) => {
    // Every non-singleton error lies about its row number, including after the canary.
    if (part.some((row) => bad.has(row))) throw parseError(1);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(insert.mock.calls[1]![0]).toEqual([input[0]]);
  expect(result.rejected).toEqual([input[3], input[7]]);
  expect(new Set(result.written)).toEqual(new Set(input.filter((row) => !bad.has(row))));
  expect(result.written).toHaveLength(6);
  expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
    { level: 'warn', event: 'ingest.parse_row_number_mismatch', projectId: 'qa91-unit' },
  ]);
  uniqueBodies(insert);
});
it.each(['ambiguous', 'unavailable'] as const)('does not reject a named canary whose singleton outcome is %s', async (failure) => {
  const input = rows(4);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.length === 4) throw parseError(1);
    if (part[0] === input[0]) {
      if (failure === 'ambiguous') throw new AmbiguousInsertError();
      throw Object.assign(new Error('Unknown table'), { code: '60' });
    }
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(result.rejected).toEqual([]);
  expect(result.pending).toEqual(failure === 'ambiguous' ? [input[0]] : []);
  expect(result.unavailable).toEqual(failure === 'unavailable' ? [input[0]] : []);
  expect(result.written).toEqual(input.slice(1));
  expect(warning).not.toHaveBeenCalled();
  uniqueBodies(insert);
});
it.each([5, 20, 80])('preserves proven prefixes at the byte limit and converges over unsettled rows with %i bad rows', async (badCount) => {
  const input = rows(1000);
  // Equal-size serialized rows keep the byte limit independent of fixture id lengths.
  for (const [index, row] of input.entries()) {
    row.event_id = String(index).padStart(4, '0');
    row.payload = '{}';
  }
  const bad = new Set(input.filter((_, index) => index % Math.floor(1000 / badCount) === 9).slice(0, badCount));
  expect(bad.size).toBe(badCount);
  const confirmed = new Set<EventRow>();
  const named = new Set<EventRow>();
  const insert = vi.fn(async (part: EventRow[]) => {
    const index = part.findIndex((row) => bad.has(row));
    if (index >= 0) {
      if (part.length === 1) named.add(part[index]!);
      throw parseError(index + 1);
    }
    for (const row of part) {
      expect(confirmed.has(row)).toBe(false);
      confirmed.add(row);
    }
  });
  const first = await isolateIngestRows(input, lease(), insert);
  expect(first.rejected.every((row) => named.has(row))).toBe(true);
  if (first.limited) {
    expect(first.limitReason).toBe('bytes');
    const lastRejected = input.indexOf(first.rejected.at(-1)!);
    expect(first.written).toEqual(input.slice(0, lastRejected).filter((row) => !bad.has(row)));
    expect(first.written.length).toBeGreaterThan(0);
    // Retry only unsettled rows: confirmed and individually rejected rows leave the work set.
    const second = await isolateIngestRows(first.unresolved, lease(), insert);
    expect(second.written.length).toBeGreaterThan(0);
    expect(second.rejected.every((row) => named.has(row))).toBe(true);
    let remaining = second.unresolved;
    // Complete 503 details let the SDK omit settled indices within the same send.
    for (let attempt = 0; remaining.length; attempt++) {
      expect(attempt).toBeLessThan(badCount);
      const result = await isolateIngestRows(remaining, lease(), insert);
      expect(result.rejected.every((row) => named.has(row))).toBe(true);
      expect(result.unresolved.length).toBeLessThan(remaining.length);
      remaining = result.unresolved;
    }
  }
  expect([...confirmed]).toEqual(input.filter((row) => !bad.has(row)));
});
it.each(['ambiguous', 'unavailable', 'lease'] as const)('keeps a parse-proven prefix %s through the normal visit path', async (failure) => {
  const input = rows(5);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.length === 5) throw parseError(3);
    if (part[0] === input[2]) throw parseError(1);
    if (part[0] === input[0]) {
      if (failure === 'ambiguous') throw new AmbiguousInsertError();
      if (failure === 'lease') throw new InsertLeaseExhaustedError();
      throw Object.assign(new Error('Unknown table'), { code: '60' });
    }
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(result.rejected).toEqual([input[2]]);
  expect(result.written).toEqual(input.slice(3));
  expect(result.pending).toEqual(failure === 'ambiguous' ? input.slice(0, 2) : []);
  expect(result.unavailable).toEqual(failure === 'unavailable' ? input.slice(0, 2) : []);
  expect(result.unresolved).toEqual(failure === 'lease' ? input.slice(0, 2) : []);
  uniqueBodies(insert);
});
it.each([undefined, 0, 1001])('falls back for row %s, bisects inferred siblings and confirms the final singleton', async (row) => {
  const input = rows(8),
    bad = input[7];
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.includes(bad!)) throw parseError(row);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(result.rejected).toEqual([bad]);
  expect(result.written).toHaveLength(7);
  expect(insert.mock.calls.map(([part]) => part.length)).toEqual([8, 4, 2, 1, 1]);
  expect(insert.mock.calls.at(-1)![0]).toEqual([bad]);
  uniqueBodies(insert);
});
it('caps statements without rejecting unchecked healthy rows when bytes are below budget', async () => {
  const input = rows(1000),
    bad = new Set(input.filter((_, i) => i === 0 || i % 2));
  // Removing the large first poison row makes subsequent statements small enough to reach the statement cap.
  input[0]!.payload = 'x'.repeat(20_000_000);
  const insert = vi.fn(async (part: EventRow[]) => {
    const i = part.findIndex((r) => bad.has(r));
    if (i >= 0) throw parseError(i + 1);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(insert).toHaveBeenCalledTimes(1 + MAX_PARSE_ISOLATION_STATEMENTS);
  expect(result.rejected).toHaveLength(22);
  expect(result.written).toEqual(input.slice(2, 42).filter((_, i) => i % 2 === 0));
  expect(result.unresolved).toContain(input[42]);
  expect(result.rejected.every((r) => bad.has(r))).toBe(true);
  expect(result.unresolved).toHaveLength(958);
  expect(result.limited).toBe(true);
  uniqueBodies(insert);
  expect(result.limitReason).toBe('statements');
});
it('serializes each row once and caps isolation UTF-8 bytes at four original bodies', async () => {
  const input = rows(100);
  for (const row of input) row.description = 'qa91-€'.repeat(100);
  const stringify = vi.spyOn(JSON, 'stringify');
  const insert = vi.fn(async (_part: EventRow[], _body: string) => {
    throw parseError(1);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  for (const row of input) expect(stringify.mock.calls.filter(([value]) => value === row)).toHaveLength(1);
  const originalBytes = Buffer.byteLength(insert.mock.calls[0]![1]);
  const isolationBytes = insert.mock.calls.slice(1).reduce((total, [, body]) => total + Buffer.byteLength(body), 0);
  expect(insert).toHaveBeenCalledTimes(10);
  expect(isolationBytes).toBeLessThanOrEqual(4 * originalBytes);
  const nextBody = result.unresolved.map((row) => `${JSON.stringify(row)}\n`).join('');
  expect(isolationBytes + Buffer.byteLength(nextBody)).toBeGreaterThan(4 * originalBytes);
  expect(result.rejected).toEqual(input.slice(0, 5));
  expect(result.unresolved).toEqual(input.slice(5));
  expect(result.written).toEqual([]);
  expect(result).toMatchObject({ limited: true, limitReason: 'bytes' });
  uniqueBodies(insert);
});
it('does not log an isolation limit when the lease expires before the original statement', async () => {
  const input = rows(2),
    insert = vi.fn();
  const result = await isolateIngestRows(input, Date.now(), insert);
  expect(result.unresolved).toEqual(input);
  expect(result).toMatchObject({ limited: false, limitReason: undefined });
  expect(insert).not.toHaveBeenCalled();
});
it.each(['lease', 'wall clock'] as const)('leaves unchecked rows retryable at the %s cap', async (cap) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const input = rows(8),
    expires = lease();
  const insert = vi.fn(async () => {
    vi.setSystemTime(Date.now() + (cap === 'lease' ? 21_000 : MAX_PARSE_ISOLATION_MS));
    throw parseError(1);
  });
  const result = await isolateIngestRows(input, expires, insert);
  expect(result.limited).toBe(true);
  expect(result.rejected).toEqual(cap === 'lease' ? [] : [input[0]]);
  expect(result.unresolved).toEqual(input.slice(cap === 'lease' ? 0 : 1));
  uniqueBodies(insert);
});
it('only a typed pre-body lease error becomes unresolved; a definite error near expiry stays unavailable', async () => {
  const input = rows(2);
  const typed = await isolateIngestRows(input, lease(), async () => {
    throw new InsertLeaseExhaustedError();
  });
  expect(typed.unresolved).toEqual(input);
  vi.useFakeTimers({ toFake: ['Date'] });
  const expires = lease();
  const other = await isolateIngestRows(input, expires, async () => {
    vi.setSystemTime(Date.now() + 21_000);
    throw Object.assign(new Error('Unknown table'), { code: '60' });
  });
  expect(other.unavailable).toEqual(input);
  expect(other.unresolved).toEqual([]);
});
it('never retries an ambiguous child and continues with its sibling', async () => {
  const input = rows(4);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.length === 4) throw parseError();
    if (part[0] === input[0]) throw new AmbiguousInsertError();
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(result.pending).toEqual(input.slice(0, 2));
  expect(result.written).toEqual(input.slice(2));
  expect(insert).toHaveBeenCalledTimes(3);
  uniqueBodies(insert);
});
it('never splits an ambiguous original', async () => {
  const input = rows(8),
    insert = vi.fn(async () => {
      throw new AmbiguousInsertError();
    });
  expect((await isolateIngestRows(input, lease(), insert)).pending).toEqual(input);
  expect(insert).toHaveBeenCalledTimes(1);
});
it('preserves written siblings beside a definite unavailable child', async () => {
  const input = rows(4);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.length === 4) throw parseError();
    if (part[0] === input[0]) throw Object.assign(new Error('Unknown table'), { code: '60' });
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(result.unavailable).toEqual(input.slice(0, 2));
  expect(result.written).toEqual(input.slice(2));
});
