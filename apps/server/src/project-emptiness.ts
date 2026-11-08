import type { ClickHouseClient } from '@clickhouse/client';
import { ApiError } from './errors';

type Reader = Pick<ClickHouseClient, 'query'>;

const quoteIdentifier = (name: string) => `\`${name.replace(/[`\\]/g, '\\$&')}\``;

/**
 * True only when no ClickHouse table in the database holds a row for `projectId` — events, rollups and any
 * project-scoped table added later (the table list is discovered from `system.columns`, so new tables are covered
 * without changing this check). Project deletion uses it to skip the synchronous purge mutations for brand-new or
 * never-used projects; a purge of nothing still costs several seconds of `mutations_sync` round trips.
 *
 * Visible rows are not the whole story: a write can still be executing or queued in ClickHouse. That is handled by
 * the caller, not here. Under the exclusive project lock (no new claims or maintenance), the delete path first stops
 * tagged maintenance statements left running by failed calls (rollup rebuilds, index repair: `stopProjectMaintenance`),
 * then runs `settleInFlightInserts` for ingest writes (ingest, test events, sample data hold #62's claimed receipts),
 * and only then allows this shortcut (`{ settled: true }`; callers that do not settle need "no unresolved claim").
 * Operator tools writing ClickHouse directly (seed `--sink direct`, benchmarks, migrations) are outside this guarantee. `system.asynchronous_inserts` is deliberately not consulted: it cannot be
 * filtered by project, so on a busy server it would almost never be empty and the shortcut would never apply.
 * Any failure answers `false`, which keeps the full purge path.
 */
export async function projectHasNoStoredRows(ch: Reader, projectId: string): Promise<boolean> {
  try {
    const tables = await (
      await ch.query({
        query: `SELECT t.name AS name FROM system.tables t
          WHERE t.database = currentDatabase()
            AND t.engine NOT IN ('MaterializedView', 'View', 'LiveView', 'WindowView', 'Dictionary')
            AND t.name IN (SELECT c.table FROM system.columns c WHERE c.database = currentDatabase() AND c.name = 'project_id')`,
        format: 'JSONEachRow',
      })
    ).json<{ name: string }>();
    if (!tables.length) return false;
    const present = await Promise.all(
      tables.map(async ({ name }) => {
        const rows = await (
          await ch.query({
            query: `SELECT 1 AS present FROM ${quoteIdentifier(name)} WHERE project_id = {p:String} LIMIT 1`,
            query_params: { p: projectId },
            format: 'JSONEachRow',
          })
        ).json<{ present: number }>();
        return rows.length > 0;
      }),
    );
    return present.every((hasRows) => !hasRows);
  } catch {
    return false;
  }
}

type PurgeStep = (projectId: string) => Promise<unknown>;

/**
 * The project purge used by project deletion. Only the ClickHouse mutations are conditional: they are skipped when
 * `hasNoStoredRows` says no ClickHouse table holds a row for the project (an empty project deletes in milliseconds
 * instead of seconds). Every `alwaysRun` step — cleanup that lives outside ClickHouse, such as PostgreSQL ingest
 * receipts — runs on both paths, so the shortcut can never orphan state elsewhere.
 */
export function projectPurger({
  hasNoStoredRows,
  purgeClickhouse,
  alwaysRun = [],
}: {
  /** `settled`: the caller already ran `settleInFlightInserts` under the same exclusive lock. */
  hasNoStoredRows: (projectId: string, settled: boolean) => Promise<boolean>;
  purgeClickhouse: PurgeStep;
  alwaysRun?: readonly PurgeStep[];
}) {
  return async (projectId: string, { settled = false }: { settled?: boolean } = {}): Promise<{ clickhouse: 'purged' | 'skipped_empty' }> => {
    const empty = await hasNoStoredRows(projectId, settled);
    if (!empty) await purgeClickhouse(projectId);
    for (const step of alwaysRun) await step(projectId);
    return { clickhouse: empty ? 'skipped_empty' : 'purged' };
  };
}

/**
 * Proves, under the exclusive project lock, that no INSERT for the project can still land in ClickHouse before the
 * project's data is purged (or skipped as empty).
 *
 * Covers ingest writes (maintenance statements are stopped separately, before this runs). #62 inserts events only
 * while holding a claimed ingest receipt; an insert is aborted once its claim lease expires, and
 * acknowledged inserts are already visible. A receipt that is still unresolved but claimed may belong to an insert
 * that ended ambiguously (or a crashed process) and is still queued in ClickHouse. Such an insert is settled once a
 * `SYSTEM FLUSH ASYNC INSERT QUEUE` starts after `claimedAt + lease + flush bound` — the same proof #62's recovery uses.
 *
 * - No unresolved claim: nothing can be in flight (new claims wait for the exclusive lock) → `'none'`.
 * - Newest claim still inside its window: deletion aborts with 503 `ingest_pending` and a Retry-After; nothing is
 *   deleted.
 * - Window passed: flush the queue, then purge. A flush failure aborts the deletion.
 */
export async function settleInFlightInserts({
  newestUnresolvedClaim,
  flush,
  leaseMs,
  flushBoundMs,
  now = Date.now,
}: {
  newestUnresolvedClaim: () => Promise<Date | null>;
  flush: () => Promise<unknown>;
  leaseMs: number;
  flushBoundMs: number;
  now?: () => number;
}): Promise<'none' | 'flushed'> {
  const claimedAt = await newestUnresolvedClaim();
  if (!claimedAt) return 'none';
  const settledAt = claimedAt.getTime() + leaseMs + flushBoundMs;
  const wait = settledAt - now();
  if (wait > 0)
    throw new ApiError(
      503,
      'ingest_pending',
      'Recent writes to this project are still settling. Try deleting it again in a minute.',
      { settledAt: new Date(settledAt).toISOString() },
      Math.ceil(wait / 1000),
    );
  await flush();
  return 'flushed';
}
