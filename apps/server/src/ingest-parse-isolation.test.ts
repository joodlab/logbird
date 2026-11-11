import { AmbiguousInsertError, type EventRow, INGEST_CLAIM_LEASE_MS, InsertLeaseExhaustedError, normalizeEvent } from '@logbird/clickhouse';
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
  expect(insert.mock.calls.map(([part]) => part.length)).toEqual([1000, 5, 994, 494, 499, 497, 1]);
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
      named.add(part[index]!);
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
it.each([undefined, 0, 1001])('falls back for row %s and infers an unwritten right sibling without sending it', async (row) => {
  const input = rows(8),
    bad = input[7];
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.includes(bad!)) throw parseError(row);
  });
  const result = await isolateIngestRows(input, lease(), insert);
  expect(result.rejected).toEqual([bad]);
  expect(result.written).toHaveLength(7);
  expect(insert.mock.calls.map(([part]) => part.length)).toEqual([8, 4, 2, 1]);
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
  expect(result.rejected).toHaveLength(34);
  expect(result.written).toEqual(input.slice(2, 64).filter((_, i) => i % 2 === 0));
  expect(result.unresolved).toContain(input[64]);
  expect(result.rejected.every((r) => bad.has(r))).toBe(true);
  expect(result.unresolved).toHaveLength(935);
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
  expect(insert).toHaveBeenCalledTimes(5);
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
  expect(result.rejected).toEqual(cap === 'lease' ? [input[0]] : [input[0], input[1]]);
  expect(result.unresolved).toEqual(input.slice(cap === 'lease' ? 1 : 2));
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
