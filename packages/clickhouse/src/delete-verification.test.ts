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
  expect(command).toHaveBeenCalledTimes(2);
  expect(command.mock.calls.every(([args]) => args.query.startsWith('DELETE FROM'))).toBe(true);
});
