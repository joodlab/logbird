import { expect, it, vi } from 'vitest';
import type { ClickHouseClient } from './client';
import { migrateEventIdIndex } from './event-id-migration';

it.each([-1, 0, 1, 2, 3, 4, 5, 6])('resumes dense-index exchange after phase %i without swapping backwards', async (fault) => {
  const statements = ['create', 'attach', 'backfill', 'exchange', 'detach', 'retire', 'cover'];
  const state = new Map<string, { name: string; engine: string; create_table_query: string }>([
    ['event_ids', { name: 'event_ids', engine: 'MergeTree', create_table_query: 'ENGINE=MergeTree ORDER BY (project_id,event_id)' }],
    ['event_ids_mv', { name: 'event_ids_mv', engine: 'MaterializedView', create_table_query: '' }],
  ]);
  let armed = fault >= 0;
  const query = vi.fn(async ({ query: sql }: { query: string }) => ({
    json: async () =>
      sql.includes('system.databases')
        ? [{ engine: 'Atomic' }]
        : sql.includes(' key_bytes ')
          ? [{ rows: 10_000_000, key_bytes: 1_000_000_000 }]
          : [...state.values()],
  }));
  const command = vi.fn(async ({ query: sql }: { query: string }) => {
    if (sql === 'create')
      state.set('event_ids_v3', {
        name: 'event_ids_v3',
        engine: 'MergeTree',
        create_table_query: 'ENGINE = MergeTree SETTINGS index_granularity = 256',
      });
    if (sql === 'attach') state.set('event_ids_v3_mv', { name: 'event_ids_v3_mv', engine: 'MaterializedView', create_table_query: '' });
    if (sql === 'exchange') {
      const before = state.get('event_ids'),
        after = state.get('event_ids_v3');
      if (!before || !after) throw new Error('Both exchange sides must exist');
      state.set('event_ids', { ...after, name: 'event_ids' });
      state.set('event_ids_v3', { ...before, name: 'event_ids_v3' });
    }
    if (sql === 'detach') state.delete('event_ids_v3_mv');
    if (sql === 'retire') state.delete('event_ids_v3');
    if (armed && statements.indexOf(sql) === fault) {
      armed = false;
      throw new Error('interrupted');
    }
    return {};
  });
  const ch = { query, command } as unknown as ClickHouseClient;
  const migrate = () => migrateEventIdIndex(ch, statements, { temporary: 'event_ids_v3', granularity: 256 });
  if (fault >= 0) await expect(migrate()).rejects.toThrow('interrupted');
  await migrate();
  await migrate();
  expect(command.mock.calls.filter(([p]) => p.query === 'exchange')).toHaveLength(1);
  expect(command.mock.calls.at(-1)?.[0].query).toBe('cover');
  expect([...state.keys()].sort()).toEqual(['event_ids', 'event_ids_mv']);
  expect(state.get('event_ids')?.create_table_query).toContain('index_granularity = 256');
});
