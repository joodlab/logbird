import { expect, it } from 'vitest';
import { ApiError } from './errors';
import { projectHasNoStoredRows, projectPurger, settleInFlightInserts } from './project-emptiness';

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

const LEASE = 60_000;
const BOUND = 10_000;
const settle = (claimedAt: Date | null, now: number, flush: () => Promise<unknown> = async () => undefined) =>
  settleInFlightInserts({ newestUnresolvedClaim: async () => claimedAt, flush, leaseMs: LEASE, flushBoundMs: BOUND, now: () => now });

it('settle: no unresolved claim means nothing can be in flight — no flush', async () => {
  let flushed = 0;
  expect(await settle(null, 1_000_000, async () => flushed++)).toBe('none');
  expect(flushed).toBe(0);
});

it('settle: a claim still inside lease + flush bound aborts the deletion with 503 ingest_pending and Retry-After', async () => {
  const claimedAt = new Date(1_000_000);
  let flushed = 0;
  const error = await settle(claimedAt, 1_000_000 + 30_000, async () => flushed++).catch((e) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 503, code: 'ingest_pending', retryAfter: 40 });
  expect(flushed).toBe(0);
});

it('settle: once the window has passed, the async queue is flushed before anything is purged', async () => {
  let flushed = 0;
  expect(await settle(new Date(1_000_000), 1_000_000 + LEASE + BOUND, async () => flushed++)).toBe('flushed');
  expect(flushed).toBe(1);
  // A failed flush is no proof: the deletion aborts.
  await expect(
    settle(new Date(1_000_000), 1_000_000 + LEASE + BOUND + 1, async () => {
      throw new Error('flush not granted');
    }),
  ).rejects.toThrow('flush not granted');
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

it('passes "settled" through, so only a delete that settled in-flight inserts may skip a claimed project', async () => {
  const seen: boolean[] = [];
  const purge = projectPurger({
    hasNoStoredRows: async (_p, settled) => {
      seen.push(settled);
      return settled;
    },
    purgeClickhouse: async () => undefined,
  });
  expect(await purge('p1')).toEqual({ clickhouse: 'purged' });
  expect(await purge('p1', { settled: true })).toEqual({ clickhouse: 'skipped_empty' });
  expect(seen).toEqual([false, true]);
});
