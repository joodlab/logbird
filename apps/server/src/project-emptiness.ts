import type { ClickHouseClient } from '@clickhouse/client';

type Reader = Pick<ClickHouseClient, 'query'>;

const quoteIdentifier = (name: string) => `\`${name.replace(/[`\\]/g, '\\$&')}\``;

/**
 * True only when no ClickHouse table in the database holds a row for `projectId` — events, rollups and any
 * project-scoped table added later (the table list is discovered from `system.columns`, so new tables are covered
 * without changing this check). Project deletion uses it to skip the synchronous purge mutations for brand-new or
 * never-used projects; a purge of nothing still costs several seconds of `mutations_sync` round trips.
 *
 * Callers must hold the project lock (ingestion is serialized), so no row can appear between this check and the
 * Postgres delete. Any failure answers `false`, which keeps the full purge path.
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
  hasNoStoredRows: (projectId: string) => Promise<boolean>;
  purgeClickhouse: PurgeStep;
  alwaysRun?: readonly PurgeStep[];
}) {
  return async (projectId: string): Promise<{ clickhouse: 'purged' | 'skipped_empty' }> => {
    const empty = await hasNoStoredRows(projectId);
    if (!empty) await purgeClickhouse(projectId);
    for (const step of alwaysRun) await step(projectId);
    return { clickhouse: empty ? 'skipped_empty' : 'purged' };
  };
}
