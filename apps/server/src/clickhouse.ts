import { createClickHouseClient, createQueryClickHouseClient, purgeProject } from '@logbird/clickhouse';
export const clickhouse = createClickHouseClient();
export const purgeProjectEvents = (projectId: string) => purgeProject(clickhouse, projectId);
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
