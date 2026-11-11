import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { freemem } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { compactIngestReceiptIndex, RECEIPT_INDEX_COMPACTION } from './receipt-index-maintenance';

vi.setConfig({ testTimeout: 300_000 });

/**
 * OPT-IN ONLY: LOGBIRD_RECEIPT_COMPACTION_IT=1 and DATABASE_URL must be set.
 * LOGBIRD_RECEIPT_COMPACTION_ROWS defaults to 200000 (integer, 100000..400000).
 * Real regular tables exercise REINDEX CONCURRENTLY in a test-owned schema only.
 * Prechecks require 5 GiB free RAM and 10 GiB free disk on the repository drive.
 * The production 64 MiB gate is unit-tested; this fixture lowers only that gate
 * to avoid growing the local WSL disk. An open writer holds the observed REINDEX
 * barrier, so cancellation needs neither a huge fixture nor a fixed sleep.
 * Names carry creation milliseconds, like the #144 auth-record sweep. Only exact
 * qa_compaction_<13-digit timestamp>_<32 hex uuid> names older than 1h are swept.
 * Manual cleanup (psql, inspect generated commands before using \gexec):
 * SELECT format('DROP SCHEMA %I CASCADE;', nspname) FROM pg_namespace
 * WHERE nspname ~ '^qa_compaction_[0-9]{13}_[0-9a-f]{32}$'
 * AND substring(nspname from '^qa_compaction_([0-9]{13})_')::bigint
 *     < extract(epoch FROM clock_timestamp() - interval '1 hour') * 1000;
 * Legacy qa_compaction_<uuid> names have no age proof: inspect them manually.
 */
const SCHEMA_PATTERN = /^qa_compaction_(\d{13})_[0-9a-f]{32}$/;
const enabled = process.env.LOGBIRD_RECEIPT_COMPACTION_IT === '1';

async function listSchemas(db: pg.Client) {
  return (
    await db.query<{ name: string }>("SELECT nspname AS name FROM pg_namespace WHERE starts_with(nspname, 'qa_compaction_') ORDER BY nspname")
  ).rows.map(({ name }) => name);
}

async function withFixture(
  work: (fixture: {
    db: pg.Client;
    writer: pg.Client;
    observer: pg.Client;
    table: string;
    target: { schema: string; table: string; index: string; keyColumns: string[] };
    pid: number;
  }) => Promise<void>,
) {
  if (!process.env.DATABASE_URL) throw new Error('Compaction integration test requires DATABASE_URL');
  const rows = Number(process.env.LOGBIRD_RECEIPT_COMPACTION_ROWS ?? 200_000);
  if (!Number.isInteger(rows) || rows < 100_000 || rows > 400_000)
    throw new Error('LOGBIRD_RECEIPT_COMPACTION_ROWS must be an integer between 100000 and 400000');
  if (freemem() < 5 * 1024 ** 3) throw new Error('Compaction integration test requires at least 5 GiB free RAM; nothing was created');
  const disk = await statfs(fileURLToPath(new URL('../../../', import.meta.url)), { bigint: true });
  if (disk.bavail * disk.bsize < 10n * 1024n ** 3n)
    throw new Error('Compaction integration test requires at least 10 GiB free disk on the repository drive; nothing was created');
  const schema = `qa_compaction_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
  const table = `"${schema}"."IngestReceipt"`;
  const clients = ['reindex', 'writer', 'observer'].map(
    (role) =>
      new pg.Client({
        connectionString: process.env.DATABASE_URL,
        application_name: `qa-compaction-${role}`,
        connectionTimeoutMillis: 5000,
        options: '-c statement_timeout=120000 -c lock_timeout=10000',
      }),
  );
  const [db, writer, observer] = clients as [pg.Client, pg.Client, pg.Client];
  const connected: pg.Client[] = [];
  let created = false;
  const minPages = RECEIPT_INDEX_COMPACTION.minPages;
  const setupStarted = Date.now();
  let failure: unknown;
  let cleanupFailure: unknown;
  try {
    for (const client of clients) {
      await client.connect();
      connected.push(client);
      // Session SETs take precedence over options embedded in DATABASE_URL.
      await client.query('SET statement_timeout = 120000');
      await client.query('SET lock_timeout = 10000');
    }
    const before = await listSchemas(observer);
    console.info(JSON.stringify({ event: 'qa.compaction_schemas_before', schemas: before, rows }));
    for (const name of before) {
      const createdAt = Number(SCHEMA_PATTERN.exec(name)?.[1]);
      if (!createdAt || Date.now() - createdAt <= 60 * 60_000) continue;
      // One stuck stale schema must not abort this run: log it and let a later sweep retry.
      try {
        await observer.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      } catch (error) {
        console.error(JSON.stringify({ event: 'qa.compaction_stale_drop_failed', schema: name, error: String(error) }));
      }
    }
    await db.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.query(`CREATE TABLE ${table} (
      "projectId" text NOT NULL, "eventId" text NOT NULL,
      CONSTRAINT "IngestReceipt_pkey" PRIMARY KEY ("projectId", "eventId"))`);
    await db.query(`INSERT INTO ${table} SELECT 'qa-compaction-project', gen_random_uuid()::text FROM generate_series(1, $1::int)`, [rows]);
    await db.query(`DELETE FROM ${table} WHERE ctid NOT IN (SELECT ctid FROM ${table} LIMIT 10000)`);
    await db.query(`VACUUM ANALYZE ${table}`);
    await writer.query("SET statement_timeout = '2s'");
    await observer.query("SET statement_timeout = '2s'");
    const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]?.pid as number;
    const target = { schema, table: 'IngestReceipt', index: 'IngestReceipt_pkey', keyColumns: ['projectId', 'eventId'] };
    Object.assign(RECEIPT_INDEX_COMPACTION, { minPages: 1 });
    console.info(JSON.stringify({ event: 'qa.compaction_setup', schema, rows, setupDurationMs: Date.now() - setupStarted }));
    await work({ db, writer, observer, table, target, pid });
  } catch (error) {
    failure = error;
  } finally {
    Object.assign(RECEIPT_INDEX_COMPACTION, { minPages });
    try {
      // Release fixture-owned transactions/locks even if a rollback query would fail.
      await Promise.allSettled([db.end(), writer.end()]);
      if (created) {
        // The polling timeout (2 s) must not cut the drop short while a cancelled rebuild finishes server-side.
        await observer.query('SET statement_timeout = 120000');
        await observer.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } catch (error) {
      // Logged and rethrown below only if the test itself passed, so it never masks the original failure.
      cleanupFailure = error;
      console.error(JSON.stringify({ event: 'qa.compaction_cleanup_failed', schema, error: String(error) }));
    } finally {
      try {
        if (connected.includes(observer))
          console.info(JSON.stringify({ event: 'qa.compaction_schemas_after', schemas: await listSchemas(observer), rows }));
      } finally {
        await observer.end();
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

async function waitForWriterPhase(observer: pg.Client, pid: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ phase: string }>('SELECT phase FROM pg_stat_progress_create_index WHERE pid=$1', [pid]);
    if (result.rows[0]?.phase === 'waiting for writers before build') return;
    await pause(20);
  }
  throw new Error('Private reindex backend did not reach the writer barrier');
}

async function invalidCopies(observer: pg.Client, table: string) {
  return (
    await observer.query<{ name: string }>(
      `SELECT c.relname name FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
     WHERE i.indrelid=to_regclass($1) AND NOT i.indisvalid AND c.relname LIKE 'IngestReceipt_pkey_ccnew%'`,
      [table],
    )
  ).rows;
}

async function finishRebuild(writer: pg.Client, observer: pg.Client, pid: number, rebuilding: Promise<unknown>) {
  const logCleanup = (error: unknown) =>
    console.error(JSON.stringify({ event: 'qa.compaction_session_cleanup_failed', pid, code: (error as { code?: string }).code }));
  await writer.query('ROLLBACK').catch(logCleanup);
  // Only this fixture's own backend may be cancelled, and only while our rebuild is active.
  await observer.query('SELECT pg_cancel_backend($1) FROM pg_stat_progress_create_index WHERE pid=$1', [pid]).catch(logCleanup);
  await rebuilding.catch(() => undefined);
}

it.runIf(enabled)('rebuilds a private index with concurrent writer progress, then skips it', async () => {
  await withFixture(async ({ db, writer, observer, table, target, pid }) => {
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO ${table} VALUES ('qa-writer', 'qa-before')`);
    const rebuilding = compactIngestReceiptIndex({ db, target });
    // Attach a handler immediately, including when a barrier assertion fails.
    void rebuilding.catch(() => undefined);
    try {
      await waitForWriterPhase(observer, pid);
      // A fresh writer can acquire its lock while the concurrent rebuild waits on the older transaction.
      await observer.query(`INSERT INTO ${table} VALUES ('qa-writer', 'qa-during')`);
      await writer.query('COMMIT');
      const rebuilt = await rebuilding;
      console.info(
        JSON.stringify({
          event: 'qa.compaction_rebuild',
          rebuildDurationMs: rebuilt.durationMs,
          indexPages: rebuilt.indexPages,
          pagesAfter: rebuilt.pagesAfter,
        }),
      );
      expect(rebuilt).toMatchObject({ action: 'reindexed', droppedInvalid: 0 });
      expect(rebuilt.indexPages).toBeGreaterThanOrEqual(RECEIPT_INDEX_COMPACTION.minPages);
      expect(rebuilt.pagesAfter).toBeLessThan((rebuilt.neededPages as number) * 2);
      const { rows } = await observer.query<{ valid: boolean; primary: boolean }>(
        `SELECT i.indisvalid valid, i.indisprimary "primary" FROM pg_index i WHERE i.indexrelid=to_regclass($1)`,
        [`"${target.schema}"."${target.index}"`],
      );
      expect(rows).toEqual([{ valid: true, primary: true }]);
      expect((await observer.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.n).toBe(10_002);
      expect((await compactIngestReceiptIndex({ db, target })).action).toBe('skipped_compact');
    } finally {
      await finishRebuild(writer, observer, pid, rebuilding);
    }
  });
});

it.runIf(enabled)('cleans the invalid ccnew copy left by cancelling its own concurrent rebuild', async () => {
  await withFixture(async ({ db, writer, observer, table, target, pid }) => {
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO ${table} VALUES ('qa-writer', 'qa-cancel')`);
    const started = Date.now();
    const rebuilding = compactIngestReceiptIndex({ db, target });
    const outcome = rebuilding.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitForWriterPhase(observer, pid);
      expect(await invalidCopies(observer, table)).toHaveLength(1);
      expect((await observer.query('SELECT pg_cancel_backend($1) cancelled', [pid])).rows[0]?.cancelled).toBe(true);
      console.info(JSON.stringify({ event: 'qa.compaction_cancel', cancelTimingMs: Date.now() - started, pid }));
      // Concurrent DROP also waits on this writer; release it before awaiting cancellation cleanup.
      await writer.query('ROLLBACK');
      expect(await outcome).toMatchObject({ code: '57014' });
      console.info(JSON.stringify({ event: 'qa.compaction_cancelled_rebuild', rebuildDurationMs: Date.now() - started }));
      expect(await invalidCopies(observer, table)).toEqual([]);
      await writer.query(`INSERT INTO ${table} VALUES ('qa-writer', 'qa-after-cancel')`);
      const validity = await observer.query('SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)', [
        `"${target.schema}"."${target.index}"`,
      ]);
      expect(validity.rows[0]?.indisvalid).toBe(true);
    } finally {
      await finishRebuild(writer, observer, pid, outcome);
    }
  });
});
