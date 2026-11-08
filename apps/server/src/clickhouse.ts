import { createClickHouseClient, createMaintenanceClickHouseClient, createQueryClickHouseClient, purgeProject } from '@logbird/clickhouse';
import { purgeIngestReceipts } from '@logbird/database';
export const clickhouse = createClickHouseClient();
export const maintenanceClickhouse = createMaintenanceClickHouseClient();
export async function purgeProjectEvents(projectId: string) {
  await purgeProject(maintenanceClickhouse, projectId);
  await purgeIngestReceipts(projectId);
}
export const queryClickhouse = createQueryClickHouseClient();
/** Server-generated query id only; never a user-supplied KILL predicate. */
export async function cancelExportQuery(queryId: string) {
  try {
    const result = await clickhouse.query({
      query: 'KILL QUERY WHERE query_id={queryId:String} SYNC',
      query_params: { queryId },
      format: 'JSONEachRow',
    });
    await result.json();
  } catch (error) {
    if (!(error && typeof error === 'object' && 'type' in error && error.type === 'NOTHING_TO_KILL')) throw error;
  }
}
