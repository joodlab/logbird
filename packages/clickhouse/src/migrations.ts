import { readdir, readFile } from 'node:fs/promises';
import type { ClickHouseClient } from './client';
import { migrateEventIdIndex } from './event-id-migration';
export async function migrate(ch: ClickHouseClient) {
  await ch.command({
    query: 'CREATE TABLE IF NOT EXISTS migrations (name String, applied_at DateTime DEFAULT now()) ENGINE=MergeTree ORDER BY name',
  });
  const applied = new Set(
    (await (await ch.query({ query: 'SELECT name FROM migrations', format: 'JSONEachRow' })).json<{ name: string }>()).map((r) => r.name),
  );
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter((n) => n.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    if (name === '007_event_ids_merge_tree.sql') await migrateEventIdIndex(ch, statements);
    else if (name === '008_event_ids_granularity.sql') await migrateEventIdIndex(ch, statements, { temporary: 'event_ids_v3', granularity: 256 });
    else for (const query of statements) await ch.command({ query });
    await ch.insert({ table: 'migrations', values: [{ name }], format: 'JSONEachRow' });
    applied.add(name);
  }
  if (applied.has(LATENESS_MIGRATION)) await ensureLatenessView(ch);
}

const LATENESS_MIGRATION = '011_events_lateness.sql';
/**
 * The restore normalization (scripts/clickhouse-restore-normalize.sql) detaches the webhook lateness view during its
 * replay. A run that stops half way leaves it detached until the server restarts; re-attach it here, or recreate it if it
 * was dropped. Arrivals while it was missing are not counted, which keeps the count low, never high.
 */
export async function ensureLatenessView(ch: ClickHouseClient) {
  const present = async () =>
    (
      await (
        await ch.query({
          query: "SELECT 1 AS present FROM system.tables WHERE database = currentDatabase() AND name = 'events_lateness_mv'",
          format: 'JSONEachRow',
        })
      ).json()
    ).length > 0;
  if (await present()) return;
  try {
    await ch.command({ query: 'ATTACH TABLE IF NOT EXISTS events_lateness_mv' });
  } catch {
    // Not detached either: recreate it from the migration's own definition.
  }
  if (await present()) return;
  const sql = await readFile(new URL(`../migrations/${LATENESS_MIGRATION}`, import.meta.url), 'utf8');
  await ch.command({ query: sql.slice(sql.indexOf('CREATE MATERIALIZED VIEW')).trim() });
}
