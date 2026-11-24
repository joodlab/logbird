import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
  // As clickhouse-client --multiquery reads it: comment lines dropped, then split on semicolons outside string literals
  // (the script's error messages contain semicolons).
  const text = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of text) {
    if (char === "'") quoted = !quoted;
    if (char === ';' && !quoted) {
      statements.push(current.trim());
      current = '';
    } else current += char;
  }
  statements.push(current.trim());
  return statements.filter(Boolean);
}
// The script refuses to start while mutations are pending (as it should for an operator); wait for earlier tests' ones.
async function mutationsSettled() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const [row] = await read<{ n: number }>(ch, 'SELECT count() n FROM system.mutations WHERE database = currentDatabase() AND NOT is_done');
    if (Number(row?.n) === 0) return;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error('Mutations in the scratch database did not finish');
}
const viewPresent = async () =>
  Number(
    (await read<{ n: number }>(ch, "SELECT count() n FROM system.tables WHERE database = currentDatabase() AND name = 'events_lateness_mv'"))[0]?.n,
  ) === 1;
const lateTotals = () =>
  read<{ received_hour: string; late_hours: number; events: string }>(
    ch,
    'SELECT received_hour, late_hours, sum(events) events FROM events_lateness_by_hour WHERE project_id = {p:String} GROUP BY received_hour, late_hours ORDER BY received_hour, late_hours',
    { p: projectId },
  );

// The normalization is an offline step: it compares the whole rollup before and after, so nothing else may write while it
// runs. Run this file alone (no file parallelism), and clear leftovers of an earlier failed run first.
beforeAll(async () => {
  if (!scratch) return;
  await ch.command({ query: 'DROP TABLE IF EXISTS events_restore_staging' });
  await ch.command({ query: 'DROP TABLE IF EXISTS lateness_restore_check' });
  await ensureLatenessView(ch);
});

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
  await mutationsSettled();
  for (const query of await normalizationStatements()) await ch.command({ query });
  expect(await lateTotals()).toEqual(before);
  expect(await viewPresent()).toBe(true);
  expect(
    Number(
      (await read<{ n: number }>(ch, "SELECT count() n FROM system.tables WHERE database = currentDatabase() AND name = 'lateness_restore_check'"))[0]
        ?.n,
    ),
  ).toBe(0);
  await ch.command({ query: 'DROP TABLE IF EXISTS events_restore_staging' });
});

it.runIf(scratch)('a normalization that stops after detaching the view is repaired by the migrations, and a dropped view is recreated', async () => {
  const statements = await normalizationStatements();
  const detach = statements.findIndex((statement) => statement.startsWith('DETACH TABLE'));
  expect(detach).toBeGreaterThan(0);
  await mutationsSettled();
  const rawCount = async () => Number((await read<{ n: number }>(ch, 'SELECT count() n FROM events'))[0]?.n);
  const rawBefore = await rawCount();
  for (const query of statements.slice(0, detach + 1)) await ch.command({ query });
  expect(await viewPresent()).toBe(false);
  await migrate(ch);
  expect(await viewPresent()).toBe(true);
  // The script checks and detaches before its first TRUNCATE, so this stop cleared nothing: drop the leftovers. (Resuming a
  // half-run replay through the re-attached view would count its late rows again: a documented limit of the approximate
  // count.)
  expect(await rawCount()).toBe(rawBefore);
  await ch.command({ query: 'DROP TABLE events_restore_staging' });
  await ch.command({ query: 'DROP TABLE lateness_restore_check' });
  await ch.command({ query: 'DROP VIEW events_lateness_mv' });
  expect(await viewPresent()).toBe(false);
  await ensureLatenessView(ch);
  expect(await viewPresent()).toBe(true);
});
