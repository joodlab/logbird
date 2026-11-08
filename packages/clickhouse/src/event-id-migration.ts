import type { ClickHouseClient } from './client';
import { backfillEventIdPointers } from './index-repair';

type IndexTable = { name: string; engine: string; create_table_query: string };
/** Durable engine/settings identify the swapped side, so an interrupted EXCHANGE never runs backwards. */
export async function migrateEventIdIndex(
  ch: ClickHouseClient,
  statements: string[],
  {
    table = 'event_ids',
    temporary = 'event_ids_v2',
    source = 'events',
    granularity,
  }: { table?: string; temporary?: string; source?: string; granularity?: number } = {},
) {
  const [createTable, createView, backfill, exchange, dropView, dropTable, coverLateWriters] = statements;
  if (!createTable || !createView || !backfill || !exchange || !dropView || !dropTable || !coverLateWriters || statements.length !== 7)
    throw new Error('Unexpected event_ids migration statements');
  const database = await (await ch.query({ query: 'SELECT engine FROM system.databases WHERE name=currentDatabase()', format: 'JSONEachRow' })).json<{
    engine: string;
  }>();
  if (database[0]?.engine !== 'Atomic') throw new Error('event_ids online migration requires an Atomic database');
  const upgraded = (row?: IndexTable) =>
    row?.engine === 'MergeTree' &&
    (granularity === undefined || new RegExp(`\\bindex_granularity\\s*=\\s*${granularity}\\b`).test(row.create_table_query));
  const old = (row?: IndexTable) =>
    granularity === undefined ? row?.engine === 'ReplacingMergeTree' : row?.engine === 'MergeTree' && !upgraded(row);
  const tables = async () =>
    new Map(
      (
        await (
          await ch.query({
            query: 'SELECT name,engine,create_table_query FROM system.tables WHERE database=currentDatabase() AND name IN {names:Array(String)}',
            query_params: { names: [table, temporary, `${temporary}_mv`, `${table}_mv`] },
            format: 'JSONEachRow',
          })
        ).json<IndexTable>()
      ).map((row) => [row.name, row]),
    );
  let state = await tables();
  if (old(state.get(table))) {
    if (state.has(temporary) && !upgraded(state.get(temporary))) throw new Error('Unexpected temporary event_ids migration state');
    if (state.get(`${table}_mv`)?.engine !== 'MaterializedView') throw new Error('The stable event_ids writer must exist before exchange');
    const temporaryView = state.get(`${temporary}_mv`);
    if (temporaryView && temporaryView.engine !== 'MaterializedView') throw new Error('Unexpected temporary event_ids writer');
    // A timed-out INSERT SELECT can still own the old temporary table UUID.
    // Retire it synchronously and allocate a fresh target before repeating the copy.
    if (state.has(temporary) || temporaryView) {
      await ch.command({ query: dropView });
      await ch.command({ query: dropTable });
    }
    const bounded = {
      max_threads: 2,
      max_insert_threads: '1',
      max_memory_usage: '384000000',
      max_bytes_before_external_sort: '64000000',
      min_insert_block_size_rows: '1000000',
      min_insert_block_size_bytes: '0',
      max_insert_block_size: '1000000',
      max_execution_time: 600,
    };
    for (const query of [createTable, createView, backfill]) await ch.command({ query, clickhouse_settings: bounded });
    await ch.command({ query: exchange });
    state = await tables();
  }
  if (!upgraded(state.get(table)) || state.get(`${table}_mv`)?.engine !== 'MaterializedView')
    throw new Error('Upgraded event_ids and its live materialized view must exist before retiring the old index');
  // TO uses the stable table name. Retire the temporary MV before its old target.
  await ch.command({ query: dropView });
  if (state.has(temporary)) {
    if (!old(state.get(temporary))) throw new Error('Refusing to drop an unexpected temporary event_ids table');
    await ch.command({ query: dropTable });
  }
  await backfillEventIdPointers(ch, coverLateWriters, {}, { source, index: table });
}
