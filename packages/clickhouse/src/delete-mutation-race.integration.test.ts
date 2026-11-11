import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { expect, it, vi } from 'vitest';
import { deleteAndVerify, read } from './queries';

/**
 * Opt-in stress proof for #95 / ClickHouse#124167: concurrent lightweight DELETEs on one non-replicated MergeTree can
 * register their mutations out of order, and the skipped one still reports done. Never runs by default or in CI
 * (needs LOGBIRD_MUTATION_RACE_STRESS=1). It applies real mutation-pool pressure: run it only with the owner's
 * approval, the `heavy` lock and no other pending mutations. It uses one throwaway table and drops it afterwards.
 */
const TABLE = 'qa95_mutation_race';
const CONCURRENCY = 16;
const ROWS_PER_PROJECT = 200;
const MAX_PENDING_MUTATIONS = 100;
// Absolute time budget inside the 330 s test timeout, with every statement capped at 10 s (client and server side):
// - no round (and no DELETE burst) starts after 150 s; the worst round is 2 guard queries + insert + 3 x (DELETE +
//   probe) + verify, each at the cap: 2x10 + 10 + 3x(10+10) + backoff + 10 ~ 100 s, so the workload ends by ~250 s;
// - cleanup polls pending mutations only until 275 s, then DROP (<= 10 s) and close still finish before 330 s.
const STATEMENT_SECONDS = 10;
const ROUND_START_DEADLINE_MS = 150_000;
const CLEANUP_POLL_DEADLINE_MS = 275_000;

it.runIf(process.env.LOGBIRD_MUTATION_RACE_STRESS === '1' && process.env.CLICKHOUSE_URL)(
  'concurrent DELETEs can be skipped on a single node, and deleteAndVerify always ends at zero rows',
  async () => {
    const maxRounds = Number(process.env.LOGBIRD_MUTATION_RACE_ROUNDS ?? 20);
    // The owner-approved cap is 20 rounds; validated here so a stray value never breaks the gated-off file.
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20)
      throw new Error('LOGBIRD_MUTATION_RACE_ROUNDS must be an integer from 1 to 20');
    const started = Date.now();
    const ch = createClient({
      url: process.env.CLICKHOUSE_URL,
      database: process.env.CLICKHOUSE_DATABASE,
      username: process.env.CLICKHOUSE_USER,
      password: process.env.CLICKHOUSE_PASSWORD,
      request_timeout: STATEMENT_SECONDS * 1000,
      clickhouse_settings: { max_execution_time: STATEMENT_SECONDS },
    });
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
    let failure: unknown;
    try {
      // Precondition: the server's mutation pool is idle. Never add a burst on top of someone else's mutations.
      if ((await pending('others')) > 0) throw new Error('Other mutations are pending on the server; not starting.');
      // Plain CREATE (no IF NOT EXISTS): a leftover or concurrently running table is never adopted, and cleanup only
      // drops the table this run created.
      await ch.command({
        query: `CREATE TABLE ${TABLE} (project_id String, n UInt32, payload String) ENGINE = MergeTree ORDER BY (project_id, n)`,
      });
      created = true;
      for (let round = 0; round < maxRounds && Date.now() - started < ROUND_START_DEADLINE_MS; round++) {
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
        // Re-check right before the burst: the guard queries and insert may have used up the start window.
        if (Date.now() - started >= ROUND_START_DEADLINE_MS) break;
        const before = warn.mock.calls.length;
        const results = await Promise.allSettled(projects.map((project) => deleteAndVerify(ch, project, TABLE)));
        const retryEvents = warn.mock.calls
          .slice(before)
          .map(([message]) => {
            if (typeof message !== 'string' || !message.startsWith('{')) return null;
            try {
              return JSON.parse(message);
            } catch {
              return null;
            }
          })
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
    } catch (error) {
      failure = error;
    }
    warn.mockRestore();
    console.info(
      JSON.stringify({
        event: 'qa95.mutation_race_result',
        concurrency: CONCURRENCY,
        rounds: rounds.length,
        skippedRounds: rounds.filter((r) => r.skipped > 0).length,
        skippedDeletes: rounds.reduce((sum, r) => sum + r.skipped, 0),
        retries: rounds.reduce((sum, r) => sum + r.retries, 0),
        perRound: rounds,
      }),
    );
    let cleanupFailure: unknown;
    try {
      if (created) {
        while (Date.now() - started < CLEANUP_POLL_DEADLINE_MS && (await pending('table')) > 0)
          await new Promise((resolve) => setTimeout(resolve, 1000));
        console.info(JSON.stringify({ event: 'qa95.mutation_race_cleanup', pendingTableMutations: await pending('table') }));
        await ch.command({ query: `DROP TABLE ${TABLE} SYNC` });
      }
    } catch (error) {
      cleanupFailure = error;
      console.error(JSON.stringify({ event: 'qa95.mutation_race_cleanup_failed', error: String(error) }));
    } finally {
      await ch.close();
    }
    // The run's own failure wins; otherwise a table left on the shared database fails the test instead of passing.
    if (failure !== undefined) throw failure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  },
  330_000,
);
