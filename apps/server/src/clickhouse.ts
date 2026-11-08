import { createClickHouseClient, createMaintenanceClickHouseClient, createQueryClickHouseClient, purgeProject } from '@logbird/clickhouse';
import { purgeIngestReceipts } from '@logbird/database';
import { projectHasNoStoredRows, projectPurger } from './project-emptiness';
export const clickhouse = createClickHouseClient();
export const maintenanceClickhouse = createMaintenanceClickHouseClient();
/**
 * Purges everything a project stored. Callers hold the exclusive project lock. The ClickHouse mutations are skipped
 * for projects without stored rows in any project-scoped ClickHouse table (including event ids); cleanup outside
 * ClickHouse belongs in `alwaysRun`, so it also runs on that fast path: ingest receipts live in PostgreSQL and must
 * never outlive their project.
 */
export const purgeProjectEvents = projectPurger({
  hasNoStoredRows: (projectId) => projectHasNoStoredRows(maintenanceClickhouse, projectId),
  purgeClickhouse: (projectId) => purgeProject(maintenanceClickhouse, projectId),
  alwaysRun: [purgeIngestReceipts],
});
export const queryClickhouse = createQueryClickHouseClient();
