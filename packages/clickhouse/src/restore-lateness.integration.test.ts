import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, expect, it } from 'vitest';
import { createMaintenanceClickHouseClient, insertEvents } from './client';
import { ensureLatenessView, migrate } from './migrations';
import { normalizeEvent } from './normalize';
import { purgeProject, read } from './queries';

// The restore normalization truncates whole tables, so this runs ONLY in a scratch database.
const database = process.env.CLICKHOUSE_DATABASE ?? '';
const scratch = Boolean(process.env.CLICKHOUSE_URL) && /^logbird_t2_scratch_[a-z0-9_]+$/.test(database);
const ch = createMaintenanceClickHouseClient();
const projectId = `qa-restore-lateness-${randomUUID()}`;
const hour = 3_600_000;

afterAll(async () => {
  try {
    if (scratch) {
      await ch.command({ query: 'DROP TABLE IF EXISTS events_restore_staging' });
      await ch.command({ query: 'DROP TABLE IF EXISTS lateness_restore_check' });
      await ensureLatenessView(ch);
      await purgeProject(ch, projectId);
    }
  } finally {
    await ch.close();
  }
});

async function normalizationStatements() {
  const sql = (await readFile(new URL('../../../scripts/clickhouse-restore-normalize.sql', import.meta.url), 'utf8'))
    .replaceAll('logbird.', `${database}.`)
    .replaceAll("database='logbird'", `database='${database}'`);
  return sql
    .split(';')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}
const viewPresent = async () =>
  (await read<{ n: string }>(ch, "SELECT count() n FROM system.tables WHERE database = currentDatabase() AND name = 'events_lateness_mv'"))[0]?.n ===
  '1';
const lateTotals = () =>
  read<{ received_hour: string; late_hours: number; events: string }>(
    ch,
    'SELECT received_hour, late_hours, sum(events) events FROM events_lateness_by_hour WHERE project_id = {p:String} GROUP BY received_hour, late_hours ORDER BY received_hour, late_hours',
    { p: projectId },
  );

it.runIf(scratch)('restore normalization keeps the lateness rollup as restored and leaves its view attached', async () => {
  const receivedAt = new Date();
  const normalized = normalizeEvent(
    { id: 'restored-late', action: 'qa.restore', occurredAt: new Date(+receivedAt - 3 * hour).toISOString() },
    { projectId, receivedAt },
  );
  if (!normalized.ok) throw new Error(normalized.reason);
  await insertEvents(ch, [normalized.row]);
  // An arrival whose raw event has since expired: counted in the rollup, absent from events.
  await ch.insert({
    table: 'events_lateness_by_hour',
    values: [{ project_id: projectId, received_hour: '2026-11-01 10:00:00', late_hours: 5, events: 1 }],
    format: 'JSONEachRow',
  });
  const before = await lateTotals();
  expect(before).toHaveLength(2);
  for (const query of await normalizationStatements()) await ch.command({ query });
  expect(await lateTotals()).toEqual(before);
  expect(await viewPresent()).toBe(true);
  expect(
    (await read<{ n: string }>(ch, "SELECT count() n FROM system.tables WHERE database = currentDatabase() AND name = 'lateness_restore_check'"))[0]
      ?.n,
  ).toBe('0');
  await ch.command({ query: 'DROP TABLE IF EXISTS events_restore_staging' });
});

it.runIf(scratch)('a normalization that stops after detaching the view is repaired by the migrations, and a dropped view is recreated', async () => {
  const statements = await normalizationStatements();
  const detach = statements.findIndex((statement) => statement.startsWith('DETACH TABLE'));
  expect(detach).toBeGreaterThan(0);
  for (const query of statements.slice(0, detach + 1)) await ch.command({ query });
  expect(await viewPresent()).toBe(false);
  await migrate(ch);
  expect(await viewPresent()).toBe(true);
  // Undo the half-run's other effects: put the raw rows back from staging and drop the leftovers.
  await ch.command({ query: 'INSERT INTO events SELECT * FROM events_restore_staging' });
  await ch.command({ query: 'DROP TABLE events_restore_staging' });
  await ch.command({ query: 'DROP TABLE lateness_restore_check' });
  await ch.command({ query: 'DROP VIEW events_lateness_mv' });
  expect(await viewPresent()).toBe(false);
  await ensureLatenessView(ch);
  expect(await viewPresent()).toBe(true);
});
