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
    const pending = async (scope: 'others' | 'table') =>
      Number(
        (
          await read<{ n: number }>(
            ch,
            scope === 'others'
              ? 'SELECT count() n FROM system.mutations WHERE NOT is_done AND NOT (database=currentDatabase() AND table={t:String})'
              : 'SELECT count() n FROM system.mutations WHERE NOT is_done AND database=currentDatabase() AND table={t:String}',
            { t: TABLE },
          )
        )[0]?.n ?? 0,
      );
    const rounds: { round: number; skipped: number; retries: number }[] = [];
    let created = false;
    try {
      // Precondition: the server's mutation pool is idle. Never add a burst on top of someone else's mutations.
      if ((await pending('others')) > 0) throw new Error('Other mutations are pending on the server; not starting.');
      // Plain CREATE (no IF NOT EXISTS): a leftover or concurrently running table is never adopted, and cleanup only
      // drops the table this run created.
      await ch.command({
        query: `CREATE TABLE ${TABLE} (project_id String, n UInt32, payload String) ENGINE = MergeTree ORDER BY (project_id, n)`,
      });
      created = true;
      for (let round = 0; round < ROUNDS; round++) {
        const others = await pending('others');
        if (others > 0) throw new Error(`Aborting: ${others} other mutations appeared on the server.`);
        const own = await pending('table');
        if (own > MAX_PENDING_MUTATIONS) throw new Error(`Aborting: ${own} pending mutations on ${TABLE}.`);
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
        if (created) {
          for (let i = 0; i < 60 && (await pending('table')) > 0; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
          console.info(JSON.stringify({ event: 'qa95.mutation_race_cleanup', pendingTableMutations: await pending('table') }));
          await ch.command({ query: `DROP TABLE ${TABLE} SYNC` });
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'qa95.mutation_race_cleanup_failed', error: String(error) }));
      } finally {
        await ch.close();
      }
    }
  },
  300_000,
);
