import { type ClickHouseClient, createClient } from '@clickhouse/client';
import type { EventRow } from './normalize';

export type { ClickHouseClient } from '@clickhouse/client';
export function createClickHouseClient(env = process.env): ClickHouseClient {
  return createClient({
    url: env.CLICKHOUSE_URL,
    database: env.CLICKHOUSE_DATABASE,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    clickhouse_settings: { date_time_input_format: 'best_effort', output_format_json_quote_64bit_integers: 0 },
  });
}
export async function insertEvents(ch: ClickHouseClient, rows: EventRow[]) {
  if (!rows.length) return;
  await ch.insert({ table: 'events', values: rows, format: 'JSONEachRow', clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 } });
}
