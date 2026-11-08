import { expect, it } from 'vitest';
import { projectHasNoStoredRows, projectPurger } from './project-emptiness';

function reader(tables: string[], withRows: string[], fail = false) {
  const queries: string[] = [];
  return {
    queries,
    query: (async ({ query }: { query: string }) => {
      queries.push(query);
      if (fail) throw new Error('system tables unavailable');
      const rows = query.includes('system.tables')
        ? tables.map((name) => ({ name }))
        : withRows.some((t) => query.includes(`\`${t}\``))
          ? [{ present: 1 }]
          : [];
      return { json: async () => rows };
    }) as never,
  };
}

it('treats a project as empty only when no project-scoped table has a row for it', async () => {
  const empty = reader(['events', 'events_by_minute', 'entities'], []);
  expect(await projectHasNoStoredRows(empty, 'p1')).toBe(true);
  expect(empty.queries.filter((q) => q.includes('LIMIT 1'))).toHaveLength(3);
  expect(await projectHasNoStoredRows(reader(['events', 'entities'], ['entities']), 'p1')).toBe(false);
  // Unknown state always keeps the full purge.
  expect(await projectHasNoStoredRows(reader([], []), 'p1')).toBe(false);
  expect(await projectHasNoStoredRows(reader(['events'], [], true), 'p1')).toBe(false);
});

it('fast path: an empty project skips only the ClickHouse purge — non-ClickHouse cleanup still runs', async () => {
  const calls: string[] = [];
  const purge = projectPurger({
    hasNoStoredRows: async () => true,
    purgeClickhouse: async (p) => calls.push(`clickhouse:${p}`),
    // Stand-in for PostgreSQL-side cleanup such as ingest receipts (#62).
    alwaysRun: [async (p) => calls.push(`receipts:${p}`)],
  });
  expect(await purge('p1')).toEqual({ clickhouse: 'skipped_empty' });
  expect(calls).toEqual(['receipts:p1']);
});

it('full path: a project with rows is purged in ClickHouse first, then the other cleanup runs', async () => {
  const calls: string[] = [];
  const purge = projectPurger({
    hasNoStoredRows: async () => false,
    purgeClickhouse: async (p) => calls.push(`clickhouse:${p}`),
    alwaysRun: [async (p) => calls.push(`receipts:${p}`)],
  });
  expect(await purge('p1')).toEqual({ clickhouse: 'purged' });
  expect(calls).toEqual(['clickhouse:p1', 'receipts:p1']);
});

it('a failing cleanup step fails the purge (so the project is not deleted with state left behind)', async () => {
  const purge = projectPurger({
    hasNoStoredRows: async () => true,
    purgeClickhouse: async () => undefined,
    alwaysRun: [
      async () => {
        throw new Error('receipt cleanup failed');
      },
    ],
  });
  await expect(purge('p1')).rejects.toThrow('receipt cleanup failed');
});
