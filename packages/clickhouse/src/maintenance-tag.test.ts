import type { ClickHouseClient } from '@clickhouse/client';
import { expect, it } from 'vitest';
import { maintenanceQueryPrefix, projectMaintenance, stopProjectMaintenance } from './maintenance-tag';

function fakeClient(processes: string[][] = []) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let processCalls = 0;
  const client = {
    calls,
    query: async (params: Record<string, unknown>) => {
      calls.push({ method: 'query', params });
      const ids = processes[Math.min(processCalls++, processes.length - 1)] ?? [];
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
  expect(ids.every((id) => id.startsWith('logbird-maint:proj_1:'))).toBe(true);
  expect(new Set(ids).size).toBe(4);
  // An explicit id wins; other members pass through untouched.
  await tagged.command({ query: 'SELECT 1', query_id: 'mine' });
  expect(ch.calls.at(-1)?.params.query_id).toBe('mine');
  await expect(tagged.close()).resolves.toBeUndefined();
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

it('never matches another project whose id merely starts the same', () => {
  expect(maintenanceQueryPrefix('p1')).toBe('logbird-maint:p1:');
  expect('logbird-maint:p10:abc'.startsWith(maintenanceQueryPrefix('p1'))).toBe(false);
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
  const id = `${maintenanceQueryPrefix("o'brien\\x")}a`;
  const ch = fakeClient([[id], []]);
  await stopProjectMaintenance(ch, "o'brien\\x");
  expect(String(ch.calls.find((c) => c.method === 'command')?.params.query)).toContain("'logbird-maint:o\\'brien\\\\x:a'");
});
