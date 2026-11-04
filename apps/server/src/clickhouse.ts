import { createClickHouseClient, purgeProject } from '@trailmark/clickhouse';
export const clickhouse = createClickHouseClient();
export const purgeProjectEvents = (projectId: string) => purgeProject(clickhouse, projectId);
