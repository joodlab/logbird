import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createMaintenanceClickHouseClient, insertEvents } from './client';
import { existingEventIdentities } from './identity';
import { normalizeEvent } from './normalize';

it('adds and rematerializes the pointer skip index online without changing identities or multiplying rows', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const source = `qa_bloom_events_${suffix}`,
    table = `qa_bloom_ids_${suffix}`;
  const ch = createMaintenanceClickHouseClient();
  const query = ch.query.bind(ch),
    exec = ch.exec.bind(ch);
  ch.query = (p) => query({ ...p, query: p.query.replace(/\bFROM event_ids\b/g, `FROM ${table}`).replace(/\bFROM events\b/g, `FROM ${source}`) });
  ch.exec = (p) => exec({ ...p, query: p.query.replace(/\bINTO events\b/g, `INTO ${source}`) });
  const migration = (await readFile(new URL('../migrations/009_event_ids_bloom.sql', import.meta.url), 'utf8'))
    .replace(/\bevent_ids\b/g, table)
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
  let writer: Promise<unknown> | undefined;
  const now = new Date();
  try {
    await ch.command({ query: `CREATE TABLE ${source} AS events ENGINE=MergeTree ORDER BY(project_id,timestamp,event_id)` });
    await ch.command({
      query: `CREATE TABLE ${table} AS event_ids ENGINE=MergeTree ORDER BY(project_id,event_id,received_at,timestamp) SETTINGS index_granularity=256`,
    });
    await ch.command({ query: `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_event_ids_bloom` });
    await ch.command({
      query: `CREATE MATERIALIZED VIEW ${table}_mv TO ${table} AS SELECT project_id,event_id,received_at,timestamp FROM ${source}`,
    });
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const normalized = normalizeEvent(
        { id: randomUUID(), action: `qa.bloom.${i}`, occurredAt: now.toISOString() },
        { projectId: 'fictional', receivedAt: now },
      );
      if (!normalized.ok) throw new Error(normalized.reason);
      return normalized.row;
    });
    await insertEvents(ch, rows.slice(0, 500));
    const before = await existingEventIdentities(
      ch,
      'fictional',
      rows.map((r) => r.event_id),
    );
    expect(before.size).toBe(500);
    writer = insertEvents(ch, rows.slice(500));
    for (const sql of migration) await ch.command({ query: sql });
    await writer;
    for (const sql of migration) await ch.command({ query: sql });
    const after = await existingEventIdentities(
      ch,
      'fictional',
      rows.map((r) => r.event_id),
    );
    expect(after.size).toBe(1000);
    for (const [id, identity] of before) expect(after.get(id)).toEqual(identity);
    expect(await existingEventIdentities(ch, 'fictional', [randomUUID()])).toEqual(new Map());
    expect((await (await query({ query: `SELECT count() n,uniqExact(event_id) ids FROM ${table}`, format: 'JSONEachRow' })).json())[0]).toEqual({
      n: 1000,
      ids: 1000,
    });
  } finally {
    if (writer) await writer;
    await ch.command({ query: `DROP VIEW IF EXISTS ${table}_mv SYNC` });
    for (const name of [table, source]) await ch.command({ query: `DROP TABLE IF EXISTS ${name} SYNC` });
    expect(
      await (
        await query({
          query: 'SELECT name FROM system.tables WHERE database=currentDatabase() AND name IN {names:Array(String)}',
          query_params: { names: [source, table, `${table}_mv`] },
          format: 'JSONEachRow',
        })
      ).json(),
    ).toEqual([]);
    await ch.close();
  }
}, 60_000);
