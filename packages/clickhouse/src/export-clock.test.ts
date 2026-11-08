import { expect, it, vi } from 'vitest';
import type { ClickHouseClient } from './client';
import { normalizeEvent } from './normalize';
import { exportEvents, read } from './queries';
import { freezeSqlClock } from './sql-guard';

function payloadClient(payload: string) {
  const normalized = normalizeEvent({ id: 'stored', action: 'stored.test' }, { projectId: 'stored', receivedAt: new Date() });
  if (!normalized.ok) throw new Error(normalized.reason);
  return {
    query: async ({ query }: { query: string }) => ({
      json: async () => (query.includes('count()') ? [{ n: 1 }] : [{ ...normalized.row, payload }]),
    }),
  } as unknown as ClickHouseClient;
}

it.each(['read-first', 'kill-first'])('waits for both the SELECT and KILL acknowledgement (%s)', async (order) => {
  let finishRead!: () => void, finishKill!: () => void;
  const deferredRead = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const deferredKill = new Promise<void>((resolve) => {
    finishKill = resolve;
  });
  const query = vi.fn(async (_params: { query_id?: string }) => ({
    json: async () => {
      await deferredRead;
      return [];
    },
  }));
  const cancelQuery = vi.fn(async (_id: string) => {
    await deferredKill;
  });
  const abort = new AbortController();
  let settled = false;
  const pending = read({ query } as unknown as ClickHouseClient, 'SELECT 1', {}, 10, true, { signal: abort.signal, cancelQuery });
  const failed = expect(pending)
    .rejects.toMatchObject({ name: 'AbortError' })
    .then(() => {
      settled = true;
    });
  await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  abort.abort();
  expect(cancelQuery).toHaveBeenCalledWith(expect.any(String));
  expect(query.mock.calls[0]?.[0]).toMatchObject({ query_id: cancelQuery.mock.calls[0]?.[0] });
  if (order === 'kill-first') finishKill();
  else finishRead();
  await Promise.resolve();
  expect(settled).toBe(false);
  finishRead();
  finishKill();
  await failed;
  expect(settled).toBe(true);
});

it.each(['', '{"broken":'])('rejects invalid stored JSON instead of producing malformed evidence (%j)', async (payload) => {
  const output = exportEvents(payloadClient(payload), 'stored', { format: 'jsonl-evidence' });
  await expect(output.next()).rejects.toThrow('Export payload is not valid stored JSON');
});

it('validates stored JSON without reserializing large-number text', async () => {
  const payload = '{"precise":9007199254740993}';
  const output = exportEvents(payloadClient(payload), 'stored', { format: 'jsonl-evidence' });
  expect((await output.next()).value).toContain(`"payload":${payload}}`);
});

it.each(['\n', '\r'])('rejects stored line separators instead of splitting evidence framing (%j)', async (separator) => {
  await expect(exportEvents(payloadClient(`{${separator}"valid":true}`), 'stored', { format: 'jsonl-evidence' }).next()).rejects.toThrow(
    'line separator',
  );
});

it.each(['\n', '\r', '\u2028', '\u2029'])('keeps backslash-escaped separators inside SQL literals (%j)', (separator) => {
  const literal = `description = 'x\\${separator}now()'`;
  const frozen = freezeSqlClock(`${literal} AND timestamp < now()`, 1234);
  expect(frozen.sql).toContain(literal);
  expect(frozen.sql.match(/fromUnixTimestamp64Milli/g)).toHaveLength(1);
});

it('reuses one compiled relative boundary after consumption delays across pages', async () => {
  const start = Date.parse('2026-11-07T12:00:00Z');
  const now = vi.spyOn(Date, 'now').mockReturnValue(start);
  const params: Record<string, unknown>[] = [];
  const events = Array.from({ length: 205 }, (_, i) => {
    const result = normalizeEvent(
      { id: `clock-${String(i).padStart(3, '0')}`, action: 'clock.test', occurredAt: new Date(start - 3_600_000 + 1).toISOString() },
      { projectId: 'clock', receivedAt: new Date(start) },
    );
    if (!result.ok) throw new Error(result.reason);
    return result.row;
  });
  const ch = {
    query: vi.fn(async ({ query, query_params }: { query: string; query_params: Record<string, unknown> }) => {
      if (query.includes('count()')) return { json: async () => [{ n: 205 }] };
      params.push(query_params);
      return { json: async () => events.filter((e) => !query_params.cursorId || e.event_id > String(query_params.cursorId)).slice(0, 201) };
    }),
  } as unknown as ClickHouseClient;
  try {
    const iterator = exportEvents(ch, 'clock', { format: 'jsonl', q: 'occurredAt:>now-1h' });
    const output: string[] = [];
    for (let i = 0; i < 200; i++) output.push((await iterator.next()).value as string);
    now.mockReturnValue(start + 10_000);
    for await (const row of iterator) output.push(row);
    expect(output).toHaveLength(205);
    expect(params).toHaveLength(2);
    expect(params[1]?.q0).toBe(params[0]?.q0);
    expect(params[1]?.from).toBe(params[0]?.from);
    expect(params[1]?.to).toBe(params[0]?.to);
    expect(params[1]?.exportReceivedBefore).toBe(params[0]?.exportReceivedBefore);
    expect((ch.query as ReturnType<typeof vi.fn>).mock.calls.some(([call]) => call.query.includes('count()'))).toBe(false);
    expect(JSON.parse(output[0] ?? '{}').exportSchemaVersion).toBe(1);
  } finally {
    now.mockRestore();
  }
});

it('freezes SQL clock calls without changing quoted text or time zones', () => {
  const frozen = freezeSqlClock(
    "timestamp > now64(3, 'UTC') - INTERVAL 1 HOUR AND description != 'now()' AND timestamp < now() AND timestamp >= yesterday() AND timestamp >= today()",
    1234,
  );
  expect(frozen.sql).toContain("toDateTime64(fromUnixTimestamp64Milli({exportClockMillis:Int64},'UTC'),3,'UTC')");
  expect(frozen.sql).toContain("description != 'now()'");
  expect(frozen.sql).toContain('subtractDays(toDate(fromUnixTimestamp64Milli({exportClockMillis:Int64})),1)');
  expect(frozen.params).toEqual({ exportClockMillis: 1234 });
  expect(() => freezeSqlClock("timestamp < now(lower('UTC'))", 1234)).toThrow('literal time zone');
});
