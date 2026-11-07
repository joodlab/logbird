import { createClickHouseClient, createQueryClickHouseClient, purgeProject } from '@logbird/clickhouse';
import { purgeIngestReceipts } from '@logbird/database';
export const clickhouse = createClickHouseClient();
export async function purgeProjectEvents(projectId: string) {
  await purgeProject(clickhouse, projectId);
  await purgeIngestReceipts(projectId);
}
export const queryClickhouse = createQueryClickHouseClient();
