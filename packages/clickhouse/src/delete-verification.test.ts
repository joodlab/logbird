import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClickHouseClient } from './client';
import { repairEventIndex } from './identity';
import { maintenanceQueryPrefix } from './maintenance-tag';
import { deleteAndVerify, purgeProject, rebuildProjectRollups } from './queries';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
  // An untagged client: deleteAndVerify must tag every statement itself (demo-clean passes a plain client).
  const ch = { command, query } as unknown as ClickHouseClient;
  const sleep = vi.spyOn(globalThis, 'setTimeout');
  const result = settle(deleteAndVerify(ch, 'qa95-retry', 'entities', 'entity_id IN {ids:Array(String)}', { ids: ['private-value-not-for-logs'] }));
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
    expect(args.query).toBe('DELETE FROM entities WHERE project_id={p:String} AND (entity_id IN {ids:Array(String)})');
    expect(args.query_params).toEqual({ p: 'qa95-retry', ids: ['private-value-not-for-logs'] });
    expect(args.clickhouse_settings).toEqual({ mutations_sync: '2', lightweight_deletes_sync: '2' });
    expect(args.query_id.startsWith(maintenanceQueryPrefix('qa95-retry'))).toBe(true);
  }
  expect(new Set(command.mock.calls.map(([args]) => args.query_id)).size).toBe(attempts);
  // The probe binds exactly the DELETE's predicate and params, with the maintenance budget (a filter outside the sort
  // key scans the whole project).
  for (const [args] of query.mock.calls) {
    expect(args.query).toBe(
      'SELECT count() n FROM (SELECT 1 FROM entities WHERE project_id={p:String} AND (entity_id IN {ids:Array(String)}) LIMIT 1)',
    );
    expect(args.query_params).toEqual({ p: 'qa95-retry', ids: ['private-value-not-for-logs'] });
    expect(args.clickhouse_settings.max_execution_time).toBe(60);
  }
  // Backoff between attempts: 50 ms, then 100 ms.
  expect(sleep.mock.calls.map(([, ms]) => ms)).toEqual([50, 100].slice(0, attempts - 1));
  expect(console.warn).toHaveBeenCalledTimes(attempts - 1);
  for (let i = 0; i < attempts - 1; i++)
    expect(console.warn).toHaveBeenNthCalledWith(
      i + 1,
      JSON.stringify({ level: 'warn', event: 'clickhouse.delete_retry', table: 'entities', projectId: 'qa95-retry', attempt: i + 2 }),
    );
  // Fail-closed logs one error line (no row data) for every caller; a success logs none.
  if (visible.at(-1) === 0) expect(console.error).not.toHaveBeenCalled();
  else
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ level: 'error', event: 'clickhouse.delete_incomplete', table: 'entities', projectId: 'qa95-retry', attempts: 3 }),
    );
});

it('propagates a first-DELETE storage error unchanged, without retrying or proceeding', async () => {
  const failure = new Error('storage unavailable');
  const command = vi.fn().mockRejectedValue(failure);
  const query = vi.fn();
  await expect(purgeProject({ command, query } as unknown as ClickHouseClient, 'qa95-errors')).rejects.toBe(failure);
  expect(command).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
});

it.each([
  ['a server timeout', Object.assign(new Error('Timeout exceeded: elapsed 600 seconds'), { code: '159' })],
  ['a cancelled query', Object.assign(new Error('Query was cancelled'), { code: '394' })],
  ['a client timeout', new Error('Timeout error.')],
])('fails closed as unverified when the first DELETE ends with %s', async (_label, failure) => {
  const command = vi.fn().mockRejectedValue(failure);
  const query = vi.fn();
  await expect(deleteAndVerify({ command, query } as unknown as ClickHouseClient, 'qa95-errors', 'events')).rejects.toMatchObject({
    code: 'LOGBIRD_DELETE_UNVERIFIED',
    table: 'events',
    attempts: 1,
    cause: failure,
  });
  expect(command).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
});

it('propagates a definite first-DELETE rejection unchanged', async () => {
  const failure = Object.assign(new Error('Syntax error'), { code: '62' });
  const command = vi.fn().mockRejectedValue(failure);
  await expect(deleteAndVerify({ command, query: vi.fn() } as unknown as ClickHouseClient, 'qa95-errors', 'events')).rejects.toBe(failure);
  expect(console.error).not.toHaveBeenCalled();
});

it('fails closed as unverified when the probe errors after the DELETE ran', async () => {
  const failure = Object.assign(new Error('Timeout exceeded'), { code: '159' });
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockRejectedValue(failure);
  await expect(purgeProject({ command, query } as unknown as ClickHouseClient, 'qa95-errors')).rejects.toMatchObject({
    code: 'LOGBIRD_DELETE_UNVERIFIED',
    table: 'events',
    attempts: 1,
    cause: failure,
  });
  // No retry and no further table: the purge stops at the unproven delete.
  expect(command).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ level: 'error', event: 'clickhouse.delete_unverified', table: 'events', projectId: 'qa95-errors', attempt: 1 }),
  );
});

it('fails closed as unverified when a retry DELETE errors', async () => {
  const failure = new Error('socket hang up');
  const command = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(failure);
  const query = vi.fn().mockResolvedValue({ json: async () => [{ n: 1 }] });
  await expect(settle(deleteAndVerify({ command, query } as unknown as ClickHouseClient, 'qa95-errors', 'entities'))).rejects.toMatchObject({
    code: 'LOGBIRD_DELETE_UNVERIFIED',
    table: 'entities',
    attempts: 2,
    cause: failure,
  });
  expect(command).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledTimes(1);
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
  // Non-fatal here, so no fail-closed error line: only the warning above.
  expect(console.error).not.toHaveBeenCalled();
});

it('still propagates storage errors from the stale-pointer delete, after writing the valid pointers', async () => {
  const failure = new Error('storage unavailable');
  const order: string[] = [];
  const command = vi.fn().mockImplementation(async () => {
    order.push('delete');
    throw failure;
  });
  const insert = vi.fn().mockImplementation(async () => {
    order.push('insert');
    return {};
  });
  const stored = new Map([['stored', { fingerprint: 'f', legacyFingerprint: 'legacy-f', receivedAt: new Date(), eventAt: new Date() }]]);
  await expect(
    repairEventIndex({ command, query: vi.fn(), insert } as unknown as ClickHouseClient, 'qa95-index', ['absent', 'stored'], stored),
  ).rejects.toBe(failure);
  expect(order).toEqual(['insert', 'delete']);
  expect(console.warn).not.toHaveBeenCalled();
});

it('deletes stale pointers once without a warning when the delete takes effect', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockResolvedValue({ json: async () => [{ n: 0 }] });
  const insert = vi.fn();
  await settle(repairEventIndex({ command, query, insert } as unknown as ClickHouseClient, 'qa95-index', ['absent'], new Map()));
  expect(insert).not.toHaveBeenCalled();
  expect(command).toHaveBeenCalledTimes(1);
  expect(console.warn).not.toHaveBeenCalled();
});

it('rejects a caller-supplied params.p before any statement', async () => {
  const command = vi.fn();
  const query = vi.fn();
  await expect(
    deleteAndVerify({ command, query } as unknown as ClickHouseClient, 'qa95-a', 'events', 'event_id={id:String}', { p: 'qa95-b', id: 'x' }),
  ).rejects.toThrow(/binds p to projectId/);
  expect(command).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

it('keeps an OR filter inside the project scope', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockResolvedValue({ json: async () => [{ n: 0 }] });
  await deleteAndVerify({ command, query } as unknown as ClickHouseClient, 'qa95-a', 'events', 'actor_id={a:String} OR tenant_id={t:String}', {
    a: 'x',
    t: 'y',
  });
  expect(command.mock.calls[0]?.[0].query).toBe('DELETE FROM events WHERE project_id={p:String} AND (actor_id={a:String} OR tenant_id={t:String})');
  expect(command.mock.calls[0]?.[0].query_params).toEqual({ a: 'x', t: 'y', p: 'qa95-a' });
  expect(query.mock.calls[0]?.[0].query).toContain('WHERE project_id={p:String} AND (actor_id={a:String} OR tenant_id={t:String}) LIMIT 1');
});

it('continues the purge after a delete that succeeds on its second attempt', async () => {
  const command = vi.fn().mockResolvedValue({});
  const probes = [1, 0, 0, 0, 0, 0];
  const query = vi.fn().mockImplementation(async () => ({ json: async () => [{ n: probes.shift() ?? 0 }] }));
  await settle(purgeProject({ command, query } as unknown as ClickHouseClient, 'qa95-purge'));
  expect(command.mock.calls.map(([args]) => args.query.split(' WHERE ')[0])).toEqual([
    'DELETE FROM events',
    'DELETE FROM events',
    'DELETE FROM event_ids',
    'DELETE FROM events_by_minute',
    'DELETE FROM entities',
    'DELETE FROM attribute_keys',
  ]);
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
  // The cutoff reaches the verified deletes intact, with p bound to this project.
  const cutoffDeletes = command.mock.calls.map(([p]) => p).filter((p) => /^DELETE FROM (events|event_ids) /.test(p.query));
  expect(cutoffDeletes.map((p) => p.query)).toEqual([
    'DELETE FROM events WHERE project_id={p:String} AND (timestamp < {before:DateTime64(3)})',
    'DELETE FROM event_ids WHERE project_id={p:String} AND (timestamp < {before:DateTime64(3)})',
  ]);
  for (const p of cutoffDeletes)
    expect(p.query_params).toEqual({ p: 'qa-narrow-retention', before: '2026-11-07 00:00:00.000', bucket: '2026-11-07 00:00:00.000' });
});
