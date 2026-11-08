import { createClickHouseClient, createMaintenanceClickHouseClient, createQueryClickHouseClient, purgeProject } from '@logbird/clickhouse';
import { purgeIngestReceipts } from '@logbird/database';
export const clickhouse = createClickHouseClient();
export const maintenanceClickhouse = createMaintenanceClickHouseClient();
export async function purgeProjectEvents(projectId: string) {
  await purgeProject(maintenanceClickhouse, projectId);
  await purgeIngestReceipts(projectId);
}
export const queryClickhouse = createQueryClickHouseClient();
