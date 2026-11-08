import { createClickHouseClient, createQueryClickHouseClient, purgeProject } from '@logbird/clickhouse';
import { projectHasNoStoredRows, projectPurger } from './project-emptiness';
export const clickhouse = createClickHouseClient();
/**
 * Purges everything a project stored. Callers hold the exclusive project lock. The ClickHouse mutations are skipped
 * for projects without stored rows; cleanup outside ClickHouse (e.g. ingest receipts) belongs in `alwaysRun` so it
 * also runs on that fast path.
 */
export const purgeProjectEvents = projectPurger({
  hasNoStoredRows: (projectId) => projectHasNoStoredRows(clickhouse, projectId),
  purgeClickhouse: (projectId) => purgeProject(clickhouse, projectId),
  alwaysRun: [],
});
export const queryClickhouse = createQueryClickHouseClient();
