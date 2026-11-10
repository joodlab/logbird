import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClickHouseClient } from './client';
import { repairEventIndex } from './identity';
import { maintenanceQueryPrefix, projectMaintenance } from './maintenance-tag';
import { deleteAndVerify, purgeProject, rebuildProjectRollups } from './queries';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // Retry backoff is real setTimeout in production; tests advance it instantly.
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
// Run a maintenance call to completion while advancing the retry backoff timers.
async function settle<T>(promise: Promise<T>) {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

it.each([
  { visible: [0], attempts: 1 },
  { visible: [1, 0], attempts: 2 },
  { visible: [1, 1, 1], attempts: 3 },
])('verifies deletion after $attempts attempt(s), failing closed when all probes see rows', async ({ visible, attempts }) => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn();
  for (const n of visible) query.mockResolvedValueOnce({ json: async () => [{ n }] });
  const ch = projectMaintenance({ command, query } as unknown as ClickHouseClient, 'qa95-retry');
  const result = settle(
    deleteAndVerify(ch, 'qa95-retry', 'entities', 'project_id={p:String} AND entity_id IN {ids:Array(String)}', {
      p: 'qa95-retry',
      ids: ['private-value-not-for-logs'],
    }),
  );
  if (visible.at(-1) === 0) await expect(result).resolves.toBeUndefined();
  else
    await expect(result).rejects.toMatchObject({
      code: 'LOGBIRD_DELETE_INCOMPLETE',
      table: 'entities',
      attempts: 3,
      message: expect.stringMatching(/^Delete left visible rows in entities after 3 attempts\. Retry the operation;/),
    });
  expect(command).toHaveBeenCalledTimes(attempts);
  expect(query).toHaveBeenCalledTimes(attempts);
  for (const [args] of command.mock.calls) {
    expect(args.query).toBe('DELETE FROM entities WHERE project_id={p:String} AND entity_id IN {ids:Array(String)}');
    expect(args.query_params).toEqual({ p: 'qa95-retry', ids: ['private-value-not-for-logs'] });
    expect(args.clickhouse_settings).toEqual({ mutations_sync: '2', lightweight_deletes_sync: '2' });
    expect(args.query_id.startsWith(maintenanceQueryPrefix('qa95-retry'))).toBe(true);
  }
  expect(new Set(command.mock.calls.map(([args]) => args.query_id)).size).toBe(attempts);
  expect(console.warn).toHaveBeenCalledTimes(attempts - 1);
  for (let i = 0; i < attempts - 1; i++)
    expect(console.warn).toHaveBeenNthCalledWith(
      i + 1,
      JSON.stringify({ level: 'warn', event: 'clickhouse.delete_retry', table: 'entities', projectId: 'qa95-retry', attempt: i + 2 }),
    );
});

it.each(['command', 'query'])('propagates %s errors without retrying or proceeding', async (method) => {
  const failure = new Error('storage unavailable');
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockResolvedValue({ json: async () => [{ n: 0 }] });
  (method === 'command' ? command : query).mockRejectedValue(failure);
  await expect(purgeProject({ command, query } as unknown as ClickHouseClient, 'qa95-errors')).rejects.toBe(failure);
  expect(command).toHaveBeenCalledTimes(1);
  expect(console.warn).not.toHaveBeenCalled();
});

it('writes valid identity pointers first and only reports stale pointers that stay visible', async () => {
  const order: string[] = [];
  const command = vi.fn(async () => {
    order.push('delete');
    return {};
  });
  const query = vi.fn().mockResolvedValue({ json: async () => [{ n: 1 }] });
  const insert = vi.fn(async () => {
    order.push('insert');
    return {};
  });
  await settle(
    repairEventIndex(
      { command, query, insert } as unknown as ClickHouseClient,
      'qa95-index',
      ['absent', 'stored'],
      new Map([['stored', { fingerprint: 'f', legacyFingerprint: 'legacy-f', receivedAt: new Date(), eventAt: new Date() }]]),
    ),
  );
  expect(order).toEqual(['insert', 'delete', 'delete', 'delete']);
  expect(console.warn).toHaveBeenLastCalledWith(
    JSON.stringify({ level: 'warn', event: 'clickhouse.event_index_stale_pointers', projectId: 'qa95-index', count: 1 }),
  );
});

it('still propagates storage errors from the stale-pointer delete', async () => {
  const failure = new Error('storage unavailable');
  const command = vi.fn().mockRejectedValue(failure);
  const insert = vi.fn().mockResolvedValue({});
  await expect(
    repairEventIndex({ command, query: vi.fn(), insert } as unknown as ClickHouseClient, 'qa95-index', ['absent'], new Map()),
  ).rejects.toBe(failure);
});

it.each(['events_by_minute', 'entities', 'attribute_keys'])('refuses to rebuild when completed deletes leave rows in %s', async (table) => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockImplementation(async ({ query: sql }: { query: string }) => ({
    json: async () => [{ n: sql.includes(`FROM ${table} `) ? 1 : 0 }],
  }));
  const ch = { command, query } as unknown as ClickHouseClient;
  await expect(settle(rebuildProjectRollups(ch, 'qa-restored'))).rejects.toMatchObject({ code: 'LOGBIRD_DELETE_INCOMPLETE' });
  expect(command.mock.calls.every(([args]) => args.query.startsWith('DELETE FROM'))).toBe(true);
});

it('refuses further rollup writes when a raw-event delete leaves visible rows', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockResolvedValue({ json: async () => [{ n: 1 }] });
  const ch = { command, query } as unknown as ClickHouseClient;
  await expect(settle(purgeProject(ch, 'qa-restored'))).rejects.toMatchObject({ code: 'LOGBIRD_DELETE_INCOMPLETE' });
  expect(command).toHaveBeenCalledTimes(3);
});

it('refuses selective rollup inserts when a scoped delete leaves visible rows', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockImplementation(async ({ query: sql }: { query: string }) => ({
    json: async () => (sql.startsWith('SELECT DISTINCT') ? [] : [{ n: sql.includes('FROM events_by_minute ') ? 1 : 0 }]),
  }));
  const ch = { command, query } as unknown as ClickHouseClient;
  await expect(settle(purgeProject(ch, 'qa-restored', new Date()))).rejects.toMatchObject({ code: 'LOGBIRD_DELETE_INCOMPLETE' });
  expect(command.mock.calls.filter(([args]) => args.query.startsWith('DELETE FROM'))).toHaveLength(5);
  expect(command.mock.calls.some(([args]) => /^INSERT INTO (events_by_minute|entities|attribute_keys)\b/.test(args.query))).toBe(false);
});

it('refuses further writes when the identity-index delete leaves visible rows', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi
    .fn()
    .mockImplementation(async ({ query: sql }: { query: string }) => ({ json: async () => [{ n: sql.includes('FROM event_ids ') ? 1 : 0 }] }));
  await expect(settle(purgeProject({ command, query } as unknown as ClickHouseClient, 'qa-restored'))).rejects.toMatchObject({
    code: 'LOGBIRD_DELETE_INCOMPLETE',
  });
  expect(command).toHaveBeenCalledTimes(4);
  expect(command.mock.calls.every(([args]) => args.query.startsWith('DELETE FROM'))).toBe(true);
});

it('cutoff cleanup preserves narrow affected-key reads without repairing retained identity history', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockImplementation(async ({ query: sql }: { query: string }) => ({
    json: async () => (sql.startsWith('SELECT DISTINCT') ? [] : [{ n: 0 }]),
  }));
  await purgeProject({ query, command } as unknown as ClickHouseClient, 'qa-narrow-retention', new Date('2026-11-07T00:00:00.000Z'));
  expect(command.mock.calls.some(([p]) => p.query.startsWith('DELETE FROM event_ids'))).toBe(true);
  expect(command.mock.calls.some(([p]) => p.query.startsWith('INSERT INTO event_ids'))).toBe(false);
  expect(query.mock.calls.some(([p]) => /key_bytes|identityBuckets|NOT IN/.test(p.query))).toBe(false);
  const affected = query.mock.calls.find(([p]) => p.query.startsWith('SELECT DISTINCT'))?.[0].query as string;
  expect(affected).toContain('SELECT DISTINCT kind,id');
  expect(affected).not.toMatch(/payload|search_text|SELECT \*/);
});
