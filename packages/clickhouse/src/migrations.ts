import { readdir, readFile } from 'node:fs/promises';
import type { ClickHouseClient } from './client';
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
    for (const query of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await ch.command({ query });
    await ch.insert({ table: 'migrations', values: [{ name }], format: 'JSONEachRow' });
  }
}
