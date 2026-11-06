import { createClickHouseClient, createQueryClickHouseClient, purgeProject } from '@logbird/clickhouse';
export const clickhouse = createClickHouseClient();
export const purgeProjectEvents = (projectId: string) => purgeProject(clickhouse, projectId);
export const queryClickhouse = createQueryClickHouseClient();
