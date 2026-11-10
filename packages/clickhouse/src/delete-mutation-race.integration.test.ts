import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createMaintenanceClickHouseClient } from './client';
import { deleteAndVerify, read } from './queries';

/**
 * Opt-in stress proof for #95 / ClickHouse#124167: concurrent lightweight DELETEs on one non-replicated MergeTree can
 * register their mutations out of order, and the skipped one still reports done. Never runs by default or in CI
 * (needs LOGBIRD_MUTATION_RACE_STRESS=1). It applies real mutation-pool pressure: run it only with the owner's
 * approval, the `heavy` lock and no other pending mutations. It uses one throwaway table and drops it afterwards.
 */
const TABLE = 'qa95_mutation_race';
const CONCURRENCY = 16;
const ROUNDS = Number(process.env.LOGBIRD_MUTATION_RACE_ROUNDS ?? 20);
const ROWS_PER_PROJECT = 200;
const MAX_PENDING_MUTATIONS = 100;

it.runIf(process.env.LOGBIRD_MUTATION_RACE_STRESS === '1' && process.env.CLICKHOUSE_URL)(
  'concurrent DELETEs can be skipped on a single node, and deleteAndVerify always ends at zero rows',
  async () => {
    const ch = createMaintenanceClickHouseClient();
    const run = randomUUID().slice(0, 8);
    const projects = Array.from({ length: CONCURRENCY }, (_, i) => `qa95-race-${run}-${i}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = async (scope: 'server' | 'table') =>
      Number(
        (
          await read<{ n: number }>(
            ch,
            scope === 'server'
              ? 'SELECT count() n FROM system.mutations WHERE NOT is_done'
              : 'SELECT count() n FROM system.mutations WHERE NOT is_done AND database=currentDatabase() AND table={t:String}',
            { t: TABLE },
          )
        )[0]?.n ?? 0,
      );
    const stale = await read<{ n: number }>(
      ch,
      'SELECT count() n FROM system.mutations WHERE NOT is_done AND create_time < now() - INTERVAL 60 SECOND AND NOT (database=currentDatabase() AND table={t:String})',
      { t: TABLE },
    );
    if (Number(stale[0]?.n ?? 0) > 0) throw new Error('Another database has mutations pending for over 60 s; not starting.');
    await ch.command({
      query: `CREATE TABLE IF NOT EXISTS ${TABLE} (project_id String, n UInt32, payload String) ENGINE = MergeTree ORDER BY (project_id, n)`,
    });
    const rounds: { round: number; skipped: number; retries: number }[] = [];
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const serverPending = await pending('server');
        if (serverPending > MAX_PENDING_MUTATIONS) throw new Error(`Aborting: ${serverPending} pending mutations on the server.`);
        // One insert puts every fictional project into the same part, so all DELETEs mutate that part concurrently.
        await ch.insert({
          table: TABLE,
          format: 'JSONEachRow',
          values: projects.flatMap((project_id) =>
            Array.from({ length: ROWS_PER_PROJECT }, (_, n) => ({ project_id, n, payload: `qa95 fixture ${round}` })),
          ),
        });
        const before = warn.mock.calls.length;
        const results = await Promise.allSettled(
          projects.map((project) => deleteAndVerify(ch, project, TABLE, 'project_id={p:String}', { p: project })),
        );
        const retryEvents = warn.mock.calls
          .slice(before)
          .map(([message]) => (typeof message === 'string' && message.startsWith('{') ? JSON.parse(message) : null))
          .filter((entry) => entry?.event === 'clickhouse.delete_retry' && projects.includes(entry.projectId));
        // A retry with attempt 2 means the project's first DELETE completed but its rows stayed visible: a skip.
        rounds.push({
          round,
          skipped: retryEvents.filter((entry) => entry.attempt === 2).length,
          retries: retryEvents.length,
        });
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        const left = await read<{ n: number }>(ch, `SELECT count() n FROM ${TABLE} WHERE project_id IN {projects:Array(String)}`, {
          projects,
        });
        expect(Number(left[0]?.n)).toBe(0);
      }
    } finally {
      warn.mockRestore();
      const skippedRounds = rounds.filter((r) => r.skipped > 0).length;
      console.info(
        JSON.stringify({
          event: 'qa95.mutation_race_result',
          concurrency: CONCURRENCY,
          rounds: rounds.length,
          skippedRounds,
          skippedDeletes: rounds.reduce((sum, r) => sum + r.skipped, 0),
          retries: rounds.reduce((sum, r) => sum + r.retries, 0),
          perRound: rounds,
        }),
      );
      try {
        for (let i = 0; i < 60 && (await pending('table')) > 0; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
        console.info(JSON.stringify({ event: 'qa95.mutation_race_cleanup', pendingTableMutations: await pending('table') }));
        await ch.command({ query: `DROP TABLE IF EXISTS ${TABLE} SYNC` });
      } catch (error) {
        console.error(JSON.stringify({ event: 'qa95.mutation_race_cleanup_failed', error: String(error) }));
      } finally {
        await ch.close();
      }
    }
  },
  300_000,
);
