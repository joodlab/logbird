import type { ClickHouseClient } from './client';

/** 007 has a non-repeatable swap; durable engines identify the correct side after interruption. */
export async function migrateEventIdIndex(ch: ClickHouseClient, statements: string[]) {
  const [createTable, createView, backfill, exchange, dropView, dropTable, coverLateWriters] = statements;
  if (!createTable || !createView || !backfill || !exchange || !dropView || !dropTable || !coverLateWriters || statements.length !== 7)
    throw new Error('Unexpected event_ids migration statements');
  const database = await (await ch.query({ query: 'SELECT engine FROM system.databases WHERE name=currentDatabase()', format: 'JSONEachRow' })).json<{
    engine: string;
  }>();
  if (database[0]?.engine !== 'Atomic') throw new Error('event_ids online migration requires an Atomic database');
  const tables = async () =>
    new Map(
      (
        await (
          await ch.query({
            query:
              "SELECT name,engine FROM system.tables WHERE database=currentDatabase() AND name IN ('event_ids','event_ids_v2','event_ids_v2_mv','event_ids_mv')",
            format: 'JSONEachRow',
          })
        ).json<{ name: string; engine: string }>()
      ).map((row) => [row.name, row.engine]),
    );
  let state = await tables();
  if (state.get('event_ids') === 'ReplacingMergeTree') {
    if (state.has('event_ids_v2') && state.get('event_ids_v2') !== 'MergeTree') throw new Error('Unexpected event_ids_v2 migration state');
    for (const query of [createTable, createView, backfill]) await ch.command({ query });
    await ch.command({ query: exchange });
    state = await tables();
  }
  if (state.get('event_ids') !== 'MergeTree' || state.get('event_ids_mv') !== 'MaterializedView')
    throw new Error('Plain event_ids and its live materialized view must exist before retiring the old index');
  // TO uses the stable table name: the original MV now writes to the plain index after EXCHANGE.
  // Retire the temporary MV before its target, never the stable writer.
  await ch.command({ query: dropView });
  if (state.has('event_ids_v2')) {
    if (state.get('event_ids_v2') !== 'ReplacingMergeTree') throw new Error('Refusing to drop an unexpected event_ids_v2 table');
    await ch.command({ query: dropTable });
  }
  await ch.command({ query: coverLateWriters });
}
