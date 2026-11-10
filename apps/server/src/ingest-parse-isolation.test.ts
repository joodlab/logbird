import { AmbiguousInsertError, type EventRow, INGEST_CLAIM_LEASE_MS, normalizeEvent } from '@logbird/clickhouse';
import { afterEach, expect, it, vi } from 'vitest';
import { isolateIngestRows, MAX_PARSE_ISOLATION_STATEMENTS } from './ingest-parse-isolation';

afterEach(() => vi.useRealTimers());
const parseError = () => Object.assign(new Error('Cannot parse fixture'), { code: '25' });
function rows(n: number) {
  return Array.from({ length: n }, (_, index) => {
    const normalized = normalizeEvent({ id: `row-${index}`, action: 'qa91.unit' }, { projectId: 'qa91-unit', receivedAt: new Date() });
    if (!normalized.ok) throw new Error(normalized.reason);
    return normalized.row;
  });
}

it('bounds sparse-error bisection and passes the same lease to every statement', async () => {
  const input = rows(1000);
  const bad = input[501];
  const lease = Date.now() + INGEST_CLAIM_LEASE_MS;
  const insert = vi.fn(async (part: EventRow[], expires: number) => {
    expect(expires).toBe(lease);
    if (part.includes(bad as EventRow)) throw parseError();
  });
  const result = await isolateIngestRows(input, lease, insert);
  expect(result.rejected).toEqual([bad]);
  expect(result.written).toHaveLength(999);
  expect(result.pending).toEqual([]);
  expect(result.limited).toBe(false);
  expect(insert.mock.calls.length).toBeLessThanOrEqual(1 + 2 * Math.ceil(Math.log2(input.length)));
});

it('caps extra statements and preserves the same cap boundary on exact retries', async () => {
  const input = rows(1000);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.some((r) => Number(r.event_id.slice(4)) % 2)) throw parseError();
  });
  const result = await isolateIngestRows(input, Date.now() + INGEST_CLAIM_LEASE_MS, insert);
  expect(insert).toHaveBeenCalledTimes(1 + MAX_PARSE_ISOLATION_STATEMENTS);
  expect(result.rejected.length + result.unresolved.length).toBeGreaterThan(500);
  expect(result.unresolved.length).toBeGreaterThan(0);
  expect(result.written.length + result.rejected.length + result.unresolved.length).toBe(1000);
  expect(result.pending).toEqual([]);
  expect(result.limited).toBe(true);
  insert.mockClear();
  const retry = await isolateIngestRows(input, Date.now() + INGEST_CLAIM_LEASE_MS, insert, new Set(result.written.map((r) => r.event_id)));
  expect(retry.rejected).toEqual(result.rejected);
  expect(retry.unresolved).toEqual(result.unresolved);
  expect(retry.written).toEqual([]);
  expect(insert.mock.calls.every(([part]) => part.every((r) => !result.written.includes(r)))).toBe(true);
});

it('reports unsent rows as unresolved when the original lease budget is exhausted', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const input = rows(4);
  const lease = Date.now() + INGEST_CLAIM_LEASE_MS;
  const insert = vi.fn(async () => {
    vi.setSystemTime(Date.now() + 21_000);
    throw parseError();
  });
  const result = await isolateIngestRows(input, lease, insert);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(result.rejected).toEqual([]);
  expect(result.unresolved).toEqual(input);
  expect(result.pending).toEqual([]);
  expect(result.limited).toBe(true);
});

it('never subdivides or retries an ambiguous child and continues settling siblings', async () => {
  const input = rows(4);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.length === 4) throw parseError();
    if (part[0] === input[0]) throw new AmbiguousInsertError();
  });
  const result = await isolateIngestRows(input, Date.now() + INGEST_CLAIM_LEASE_MS, insert);
  expect(insert.mock.calls.map(([part]) => part.map((r) => r.event_id))).toEqual([
    ['row-0', 'row-1', 'row-2', 'row-3'],
    ['row-0', 'row-1'],
    ['row-2', 'row-3'],
  ]);
  expect(result.pending).toEqual(input.slice(0, 2));
  expect(result.written).toEqual(input.slice(2));
  expect(result.rejected).toEqual([]);
});

it('does not split an ambiguous original statement', async () => {
  const input = rows(8);
  const insert = vi.fn(async () => {
    throw new AmbiguousInsertError();
  });
  const result = await isolateIngestRows(input, Date.now() + INGEST_CLAIM_LEASE_MS, insert);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(result.pending).toEqual(input);
});

it('releases a definite non-parse child failure without discarding acknowledged siblings', async () => {
  const input = rows(2);
  const insert = vi.fn(async (part: EventRow[]) => {
    if (part.length === 2) throw parseError();
    if (part[0] === input[1]) throw Object.assign(new Error('Unknown table'), { code: '60' });
  });
  const result = await isolateIngestRows(input, Date.now() + INGEST_CLAIM_LEASE_MS, insert);
  expect(result.written).toEqual(input.slice(0, 1));
  expect(result.unavailable).toEqual(input.slice(1));
  expect(result.pending).toEqual([]);
});
