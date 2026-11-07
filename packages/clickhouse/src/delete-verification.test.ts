import { expect, it, vi } from 'vitest';
import type { ClickHouseClient } from './client';
import { purgeProject, rebuildProjectRollups } from './queries';

it.each(['events_by_minute', 'entities', 'attribute_keys'])('refuses to rebuild when completed deletes leave rows in %s', async (table) => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockImplementation(async ({ query: sql }: { query: string }) => ({
    json: async () => [{ n: sql.includes(`FROM ${table} `) ? 1 : 0 }],
  }));
  const ch = { command, query } as unknown as ClickHouseClient;
  await expect(rebuildProjectRollups(ch, 'qa-restored')).rejects.toMatchObject({ code: 'LOGBIRD_DELETE_INCOMPLETE' });
  expect(command.mock.calls.every(([args]) => args.query.startsWith('DELETE FROM'))).toBe(true);
});

it('refuses further rollup writes when a raw-event delete leaves visible rows', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockResolvedValue({ json: async () => [{ n: 1 }] });
  const ch = { command, query } as unknown as ClickHouseClient;
  await expect(purgeProject(ch, 'qa-restored')).rejects.toMatchObject({ code: 'LOGBIRD_DELETE_INCOMPLETE' });
  expect(command).toHaveBeenCalledTimes(1);
});

it('refuses selective rollup inserts when a scoped delete leaves visible rows', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockImplementation(async ({ query: sql }: { query: string }) => ({
    json: async () => (sql.startsWith('SELECT DISTINCT') ? [] : [{ n: sql.includes('FROM events_by_minute ') ? 1 : 0 }]),
  }));
  const ch = { command, query } as unknown as ClickHouseClient;
  await expect(purgeProject(ch, 'qa-restored', new Date())).rejects.toMatchObject({ code: 'LOGBIRD_DELETE_INCOMPLETE' });
  expect(command).toHaveBeenCalledTimes(4);
  expect(command.mock.calls.some(([args]) => /^INSERT INTO (events_by_minute|entities|attribute_keys)\b/.test(args.query))).toBe(false);
});

it('refuses further writes when the identity-index delete leaves visible rows', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi
    .fn()
    .mockImplementation(async ({ query: sql }: { query: string }) => ({ json: async () => [{ n: sql.includes('FROM event_ids ') ? 1 : 0 }] }));
  await expect(purgeProject({ command, query } as unknown as ClickHouseClient, 'qa-restored')).rejects.toMatchObject({
    code: 'LOGBIRD_DELETE_INCOMPLETE',
  });
  expect(command).toHaveBeenCalledTimes(2);
  expect(command.mock.calls.every(([args]) => args.query.startsWith('DELETE FROM'))).toBe(true);
});

it('cutoff repair reads identity pointers and affected aggregate keys instead of wide event payloads', async () => {
  const command = vi.fn().mockResolvedValue({});
  const query = vi
    .fn()
    .mockImplementation(async ({ query: sql }: { query: string }) => ({ json: async () => (sql.startsWith('SELECT DISTINCT') ? [] : [{ n: 0 }]) }));
  await purgeProject({ query, command } as unknown as ClickHouseClient, 'qa-narrow-retention', new Date('2026-11-07T00:00:00.000Z'));
  const indexRepair = command.mock.calls.find(([p]) => p.query.startsWith('INSERT INTO event_ids'))?.[0].query as string;
  expect(indexRepair).toMatch(/^INSERT INTO event_ids SELECT DISTINCT project_id,event_id,received_at,timestamp FROM events WHERE project_id=/);
  expect(indexRepair).not.toMatch(/payload|search_text|SELECT \*/);
  const affected = query.mock.calls.find(([p]) => p.query.startsWith('SELECT DISTINCT'))?.[0].query as string;
  expect(affected).toContain('SELECT DISTINCT kind,id');
  expect(affected).not.toMatch(/payload|search_text|SELECT \*/);
});
