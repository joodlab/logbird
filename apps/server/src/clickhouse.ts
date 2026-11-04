import { createClient } from '@clickhouse/client';
import { env } from './env';
export const clickhouse = createClient({
  url: env.CLICKHOUSE_URL,
  database: env.CLICKHOUSE_DATABASE,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
});
export async function purgeProjectEvents(projectId: string) {
  try {
    await clickhouse.command({
      query: 'DELETE FROM events WHERE project_id = {id:String}',
      query_params: { id: projectId },
      clickhouse_settings: { lightweight_deletes_sync: '1' },
    });
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && String(error.code) === '60')) throw error;
  }
  // TODO(data-plane): purge derived rollups/entities as those tables become available.
}
