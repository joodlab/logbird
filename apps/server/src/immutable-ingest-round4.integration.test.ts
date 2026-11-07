import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { read } from '@logbird/clickhouse';
import { ProjectBusyError, prisma } from '@logbird/database';
import { logIngestRecoveryFailure, probeIngestRecovery, recoverProjectIngest } from '@logbird/worker/ingest-recovery';
import { enforceProjectRetention } from '@logbird/worker/retention';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { ingest } from './ingest';

let f: ImmutableFixture,
  clock = Date.now();
const wallClock = Date.now;
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
beforeEach(async () => {
  f = await immutableFixture();
  await f.authorize();
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Math.max(clock, Date.now()) + 61_000;
  vi.setSystemTime(clock);
});
afterEach(async () => {
  clock = Math.max(clock, Date.now());
  vi.useRealTimers();
  vi.restoreAllMocks();
  await f.cleanup();
});
const pending = { id: 'abandoned', action: 'repair.pending' };
async function populated() {
  expect((await f.post({ id: 'retained', action: 'retained.event', actor: { id: 'person', type: 'user' }, metadata: { key: 'value' } })).status).toBe(
    202,
  );
}
function url(path: string) {
  return `/api/projects/${f.project}/${path}?from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`;
}
async function unavailable() {
  for (const path of ['entities?kind=actor', 'overview', 'entities/actor/person']) {
    const response = await f.management(url(path).replace('?kind=actor?', '?kind=actor&'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect((await response.json()).error).toMatchObject({ code: 'retention_unavailable', message: 'Project data is being rebuilt. Retry shortly.' });
  }
}
async function consistent(events: number) {
  const entities = await f.management(url('entities?kind=actor').replace('?kind=actor?', '?kind=actor&'));
  expect(entities.status).toBe(200);
  expect((await entities.json()).data.some((e: { id: string }) => e.id === 'person')).toBe(true);
  const overview = await f.management(url('overview'));
  expect(overview.status).toBe(200);
  expect((await overview.json()).kpis.events).toBe(events);
}
it('fences readers after all rollup DELETEs, excludes repair from settings, and completes before replay', async () => {
  await populated();
  await f.pending(pending, { expired: true });
  const command = clickhouse.command.bind(clickhouse),
    insert = clickhouse.insert.bind(clickhouse);
  let release: () => void = () => undefined,
    entered: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    deleted = new Promise<void>((r) => {
      entered = r;
    });
  vi.spyOn(clickhouse, 'command').mockImplementation(async (params) => {
    const result = await command(params);
    if (params.query.startsWith('DELETE FROM attribute_keys')) {
      entered();
      await gate;
    }
    return result;
  });
  vi.spyOn(clickhouse, 'insert').mockImplementation(async (params) => {
    if (params.table === 'events')
      expect(await prisma.retentionRun.count({ where: { projectId: f.project, kind: 'ingest_repair', status: { in: ['running', 'failed'] } } })).toBe(
        0,
      );
    return insert(params);
  });
  const response = f.post(pending);
  try {
    await deleted;
    expect(await prisma.retentionRun.findFirstOrThrow({ where: { projectId: f.project } })).toMatchObject({
      kind: 'ingest_repair',
      status: 'running',
    });
    expect((await read<{ n: number }>(clickhouse, 'SELECT count() n FROM entities WHERE project_id={p:String}', { p: f.project }))[0]?.n).toBe(0);
    await unavailable();
    release();
    expect((await response).status).toBe(202);
    await consistent(2);
    const settings = await f.management(`/api/projects/${f.project}/retention`);
    expect(settings.status).toBe(200);
    expect((await settings.json()).lastRun).toBeNull();
  } finally {
    release();
    await response;
  }
});
it('keeps failed repairs read-fenced while healthy siblings commit, then retention restores every destination', async () => {
  await populated();
  await f.pending(pending, { expired: true });
  const command = clickhouse.command.bind(clickhouse);
  const spy = vi.spyOn(clickhouse, 'command').mockImplementation(async (params) => {
    const result = await command(params);
    if (params.query.startsWith('DELETE FROM attribute_keys')) throw Object.assign(new Error('QA rebuild memory limit'), { code: '241' });
    return result;
  });
  const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const response = await f.post([pending, { id: 'healthy', action: 'healthy.event' }]);
  expect(response.status).toBe(503);
  expect((await response.json()).error.details).toMatchObject({ accepted: 1, ids: ['healthy'], indices: [0], eventIds: ['abandoned'] });
  expect(await f.count()).toBe(2);
  await unavailable();
  expect(logs.mock.calls.some(([line]) => String(line).includes('ingest.recovery_failed') && String(line).includes('241'))).toBe(true);
  // Once the first repair fails, requests defer to retention even after the flush throttle expires.
  for (const id of ['healthy-2', 'healthy-3']) {
    vi.setSystemTime(Date.now() + 61_000);
    const retry = await f.post([pending, { id, action: 'healthy.event' }]);
    expect(retry.status).toBe(503);
    expect(retry.headers.get('Retry-After')).toBe('60');
    expect((await retry.json()).error.details).toMatchObject({ accepted: 1, ids: [id], indices: [0], eventIds: ['abandoned'] });
  }
  expect(spy.mock.calls.filter(([p]) => /^DELETE FROM (events_by_minute|entities|attribute_keys)\b/.test(p.query))).toHaveLength(3);
  expect(await prisma.retentionRun.count({ where: { projectId: f.project, kind: 'ingest_repair', status: 'failed' } })).toBe(1);
  spy.mockRestore();
  await enforceProjectRetention(f.project);
  await consistent(4);
  expect(await prisma.retentionRun.count({ where: { projectId: f.project, kind: 'ingest_repair', status: { in: ['running', 'failed'] } } })).toBe(0);
});
it('repairs a process killed after destructive deletes without exposing an empty model after lease expiry', async () => {
  vi.useRealTimers();
  await populated();
  await f.pending(pending);
  await prisma.ingestReceipt.updateMany({
    where: { projectId: f.project, eventId: pending.id },
    data: { claimedAt: new Date(wallClock() - 80_000) },
  });
  const child = fork(fileURLToPath(new URL('./ingest-crash-fixture.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deleted = new Promise<{ stage: string }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Repair child IPC timeout')), 20_000);
      child.once('message', (m) => resolve(m as { stage: string }));
      child.once('exit', () => reject(new Error('Repair child exited early')));
    });
    child.send({ projectId: f.project, input: pending, phase: 'rebuild-deleted' });
    expect((await deleted).stage).toBe('deleted');
    if (timer) clearTimeout(timer);
    await unavailable();
    child.kill('SIGKILL');
    await exited;
    vi.useFakeTimers({ toFake: ['Date'] });
    clock = Math.max(clock, wallClock()) + 11 * 60_000;
    vi.setSystemTime(clock);
    await unavailable();
    expect((await prisma.retentionRun.findFirstOrThrow({ where: { projectId: f.project, kind: 'ingest_repair' } })).status).toBe('failed');
    await enforceProjectRetention(f.project);
    await consistent(1);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});
it('ready-only and grace-only recovery perform no rollup DELETE and expose the remaining ready grace', async () => {
  await f.pending(pending, { expired: true });
  await recoverProjectIngest(clickhouse, f.project);
  const commands = vi.spyOn(clickhouse, 'command');
  const different = { ...pending, action: 'different' };
  const waiting = await f.post(different);
  expect(waiting.status).toBe(503);
  expect(waiting.headers.get('Retry-After')).toBe('600');
  expect((await f.post(pending)).status).toBe(202);
  expect(commands.mock.calls.some(([p]) => /^DELETE FROM (events_by_minute|entities|attribute_keys)\b/.test(p.query))).toBe(false);
  await f.pending({ id: 'grace', action: 'old' }, { expired: true });
  await recoverProjectIngest(clickhouse, f.project);
  commands.mockClear();
  vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
  expect((await f.post({ id: 'grace', action: 'new' })).status).toBe(202);
  expect(commands.mock.calls.some(([p]) => /^DELETE FROM (events_by_minute|entities|attribute_keys)\b/.test(p.query))).toBe(false);
});
it('flush failures retain the pending index and store siblings with a throttled Retry-After', async () => {
  await f.pending(pending, { expired: true });
  const command = clickhouse.command.bind(clickhouse);
  const calls = vi
    .spyOn(clickhouse, 'command')
    .mockImplementation((params) =>
      params.query === 'SYSTEM FLUSH ASYNC INSERT QUEUE'
        ? Promise.reject(Object.assign(new Error('QA flush denied'), { code: '497' }))
        : command(params),
    );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const [id, delay] of [
    ['healthy-1', 60],
    ['healthy-2', 60],
  ] as const) {
    const response = await f.post([pending, { id, action: 'healthy.event' }]);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe(String(delay));
    expect((await response.json()).error.details).toMatchObject({ accepted: 1, ids: [id], indices: [0] });
  }
  vi.setSystemTime(Date.now() + 30_000);
  const response = await f.post([pending, { id: 'healthy-3', action: 'healthy.event' }]);
  expect(response.headers.get('Retry-After')).toBe('30');
  expect(calls.mock.calls.filter(([p]) => p.query === 'SYSTEM FLUSH ASYNC INSERT QUEUE')).toHaveLength(1);
  expect(await f.count()).toBe(3);
});
it('sample removal uses the same durable read fence around its rollup rebuild', async () => {
  await populated();
  expect((await f.post({ id: 'sample', action: 'sample', source: 'logbird-sample' })).status).toBe(202);
  const command = clickhouse.command.bind(clickhouse);
  let release: () => void = () => undefined,
    entered: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    deleted = new Promise<void>((r) => {
      entered = r;
    });
  vi.spyOn(clickhouse, 'command').mockImplementation(async (params) => {
    const result = await command(params);
    if (params.query.startsWith('DELETE FROM attribute_keys')) {
      entered();
      await gate;
    }
    return result;
  });
  const response = f.management(`/api/projects/${f.project}/sample-data`, 'DELETE');
  try {
    await deleted;
    await unavailable();
    release();
    expect((await response).status).toBe(204);
    await consistent(1);
  } finally {
    release();
    await response;
  }
});
it('uses parsed wire payload identity for internal audit Date and undefined values', async () => {
  const at = new Date();
  const event = {
    id: 'internal-date',
    action: 'internal.audit',
    actor: { id: 'person', createdAt: at },
    metadata: { nested: { at } },
    changes: undefined,
  };
  expect(await ingest(f.project, event)).toMatchObject({ accepted: 1, rejected: [] });
  expect(await ingest(f.project, event)).toMatchObject({ accepted: 1, rejected: [] });
  expect((await f.post(event)).status).toBe(202);
  expect(await f.count()).toBe(1);
});
it('probes the flush grant at startup and emits actionable recovery diagnostics', async () => {
  vi.spyOn(clickhouse, 'command').mockRejectedValueOnce(Object.assign(new Error('QA ACCESS_DENIED'), { code: '497' }));
  const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await probeIngestRecovery(clickhouse)).toBe(false);
  expect(logs.mock.calls.some(([line]) => String(line).includes('ingest.recovery_failed') && String(line).includes('497'))).toBe(true);
  expect(logs.mock.calls.some(([line]) => String(line).includes('SYSTEM FLUSH ASYNC INSERT QUEUE'))).toBe(true);
});

it('does not log ordinary project-lock contention as an ingest recovery failure', () => {
  const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  logIngestRecoveryFailure(new ProjectBusyError(), f.project);
  expect(logs).not.toHaveBeenCalled();
});
