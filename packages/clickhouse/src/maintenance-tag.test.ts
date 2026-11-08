import type { ClickHouseClient } from '@clickhouse/client';
import { expect, it } from 'vitest';
import { repairEventIndex } from './identity';
import { maintenanceQueryPrefix, projectMaintenance, stopProjectMaintenance } from './maintenance-tag';
import { purgeProject, rebuildProjectRollups } from './queries';

function fakeClient(processes: string[][] = []) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let processCalls = 0;
  const client = {
    calls,
    query: async (params: Record<string, unknown>) => {
      calls.push({ method: 'query', params });
      const ids = String(params.query).includes('system.processes') ? (processes[Math.min(processCalls++, processes.length - 1)] ?? []) : [];
      return { json: async () => ids.map((query_id) => ({ query_id })) };
    },
    command: async (params: Record<string, unknown>) => {
      calls.push({ method: 'command', params });
      return {};
    },
    insert: async (params: Record<string, unknown>) => {
      calls.push({ method: 'insert', params });
      return {};
    },
    exec: async (params: Record<string, unknown>) => {
      calls.push({ method: 'exec', params });
      return {};
    },
    close: async () => undefined,
  };
  return client as typeof client & ClickHouseClient;
}

it('tags every maintenance statement of a project with a unique, project-scoped query id', async () => {
  const ch = fakeClient();
  const tagged = projectMaintenance(ch, 'proj_1');
  await tagged.command({ query: 'INSERT INTO entities SELECT 1' });
  await tagged.insert({ table: 'event_ids', values: [], format: 'JSONEachRow' });
  await tagged.exec({ query: 'SELECT 1' });
  await tagged.query({ query: 'SELECT 1', format: 'JSONEachRow' });
  const ids = ch.calls.map((c) => String(c.params.query_id));
  expect(ids.every((id) => id.startsWith(maintenanceQueryPrefix('proj_1')))).toBe(true);
  expect(new Set(ids).size).toBe(4);
  await expect(tagged.close()).resolves.toBeUndefined();
});

it('a caller-supplied query id cannot escape the tag, and wrapping twice is a no-op', async () => {
  const ch = fakeClient();
  const tagged = projectMaintenance(ch, 'proj_1');
  await tagged.command({ query: 'SELECT 1', query_id: 'mine' });
  expect(ch.calls.at(-1)?.params.query_id).toBe(`${maintenanceQueryPrefix('proj_1')}mine`);
  expect(projectMaintenance(tagged, 'proj_1')).toBe(tagged);
  await projectMaintenance(tagged, 'proj_1').command({ query: 'SELECT 1', query_id: 'again' });
  expect(ch.calls.at(-1)?.params.query_id).toBe(`${maintenanceQueryPrefix('proj_1')}again`);
});

it('reads methods at call time, so patches on the underlying client still apply', async () => {
  const ch = fakeClient();
  const tagged = projectMaintenance(ch, 'proj_1');
  let patched = '';
  ch.command = (async (params: { query_id?: string }) => {
    patched = params.query_id ?? '';
    return {};
  }) as never;
  await tagged.command({ query: 'SELECT 1' });
  expect(patched.startsWith(maintenanceQueryPrefix('proj_1'))).toBe(true);
});

it('encodes the project id, so no project prefix is a prefix of another (p1 vs p1:child, p10)', () => {
  const p1 = maintenanceQueryPrefix('p1');
  expect(p1).toBe('logbird-maint:cDE:');
  for (const other of ['p1:child', 'p10', 'ws:p1', 'p1:']) expect(`${maintenanceQueryPrefix(other)}x`.startsWith(p1), other).toBe(false);
  expect(maintenanceQueryPrefix('ws:org').includes('ws:org')).toBe(false);
});

it('helper boundary: purge, rollup rebuild and index repair tag every statement even with a bare client', async () => {
  const projectId = 'p1:child';
  const prefix = maintenanceQueryPrefix(projectId);
  for (const run of [
    (ch: ClickHouseClient) => purgeProject(ch, projectId),
    (ch: ClickHouseClient) => purgeProject(ch, projectId, new Date('2026-11-01T00:00:00Z')),
    (ch: ClickHouseClient) => rebuildProjectRollups(ch, projectId),
    (ch: ClickHouseClient) =>
      repairEventIndex(
        ch,
        projectId,
        ['gone', 'kept'],
        new Map([['kept', { fingerprint: 'f', receivedAt: new Date(), eventAt: new Date() }]]) as never,
      ),
  ]) {
    const bare = fakeClient();
    await run(bare);
    expect(bare.calls.length).toBeGreaterThan(0);
    for (const call of bare.calls)
      expect(String(call.params.query_id), String(call.params.query ?? call.params.table)).toMatch(new RegExp(`^${prefix}`));
  }
});

it('stops running maintenance with KILL QUERY … SYNC and verifies nothing is left', async () => {
  const id = `${maintenanceQueryPrefix('proj_1')}a`;
  const ch = fakeClient([[id], []]);
  expect(await stopProjectMaintenance(ch, 'proj_1')).toBe(1);
  const kill = ch.calls.find((c) => c.method === 'command');
  expect(String(kill?.params.query)).toBe(`KILL QUERY WHERE query_id IN ('${id}') SYNC`);
  // Nothing running: no KILL at all.
  const idle = fakeClient([[]]);
  expect(await stopProjectMaintenance(idle, 'proj_1')).toBe(0);
  expect(idle.calls.some((c) => c.method === 'command')).toBe(false);
});

it('fails when a statement survives the kill (the caller must not purge)', async () => {
  const id = `${maintenanceQueryPrefix('proj_1')}stuck`;
  await expect(stopProjectMaintenance(fakeClient([[id], [id]]), 'proj_1')).rejects.toMatchObject({ code: 'LOGBIRD_MAINTENANCE_RUNNING' });
});

it('quotes ids safely in the KILL statement', async () => {
  const id = "logbird-maint:x:o'brien\\x";
  const ch = fakeClient([[id], []]);
  await stopProjectMaintenance(ch, 'any');
  expect(String(ch.calls.find((c) => c.method === 'command')?.params.query)).toContain("'logbird-maint:x:o\\'brien\\\\x'");
});
