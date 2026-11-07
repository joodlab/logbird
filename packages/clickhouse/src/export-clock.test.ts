import { expect, it, vi } from 'vitest';
import type { ClickHouseClient } from './client';
import { normalizeEvent } from './normalize';
import { exportEvents } from './queries';
import { freezeSqlClock } from './sql-guard';

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
