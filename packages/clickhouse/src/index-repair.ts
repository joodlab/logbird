import type { ClickHouseClient } from './client';

/**
 * NOT IN and DISTINCT share one 256 MiB query ceiling. Target 128 MiB for the larger
 * side; DISTINCT normally holds only the missing tuples. The hard cap also covers
 * both sets, scan buffers and allocation overhead, including unexpected overlap.
 */
export function eventIdRepairBuckets(rows: number, keyBytes = rows * 64) {
  if (!Number.isSafeInteger(rows) || rows < 0 || !Number.isFinite(keyBytes) || keyBytes < 0) throw new Error('Invalid identity repair size');
  const required = Math.max(1, Math.ceil(rows / 500_000), Math.ceil((keyBytes * 2 + rows * 128) / (128 * 1024 * 1024)));
  return 2 ** Math.ceil(Math.log2(required));
}

/** Cold reconciliation only. Size both destinations; overlapping backfills can inflate the index. */
export async function backfillEventIdPointers(
  ch: ClickHouseClient,
  query: string,
  params: Record<string, unknown> = {},
  { source = 'events', index = 'event_ids' }: { source?: string; index?: string } = {},
) {
  const predicate = params.p === undefined ? '' : ' WHERE project_id={p:String}';
  const sizes = await (
    await ch.query({
      query: `SELECT count() rows,sum(length(project_id)+length(event_id)+16) key_bytes FROM ${source}${predicate} UNION ALL SELECT count() rows,sum(length(project_id)+length(event_id)+16) key_bytes FROM ${index}${predicate}`,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: { max_threads: 2, max_memory_usage: '268435456', max_execution_time: 120 },
    })
  ).json<{ rows: number; key_bytes: number }>();
  const identityBuckets = Math.max(1, ...sizes.map((size) => eventIdRepairBuckets(Number(size.rows), Number(size.key_bytes))));
  for (let identityBucket = 0; identityBucket < identityBuckets; identityBucket++)
    await ch.command({
      query,
      query_params: { ...params, identityBuckets, identityBucket },
      clickhouse_settings: { max_threads: 2, max_memory_usage: '268435456', max_execution_time: 120 },
    });
}
