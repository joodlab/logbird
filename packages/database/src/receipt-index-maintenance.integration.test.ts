import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { compactIngestReceiptIndex, RECEIPT_INDEX_COMPACTION } from './receipt-index-maintenance';

vi.setConfig({ testTimeout: 300_000 });

/** Regular tables exercise REINDEX CONCURRENTLY; the former temp fixture only proved rebuild sizing/validity. */
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
  const schema = `qa_compaction_${randomUUID().replaceAll('-', '')}`;
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
  let created = false;
  try {
    await Promise.all(clients.map((client) => client.connect()));
    await db.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.query(`CREATE TABLE ${table} (
      "projectId" text NOT NULL, "eventId" text NOT NULL,
      CONSTRAINT "IngestReceipt_pkey" PRIMARY KEY ("projectId", "eventId"))`);
    await db.query(`INSERT INTO ${table} SELECT 'qa-compaction-project', gen_random_uuid()::text FROM generate_series(1, 800000)`);
    await db.query(`DELETE FROM ${table} WHERE ctid NOT IN (SELECT ctid FROM ${table} LIMIT 10000)`);
    await db.query(`VACUUM ANALYZE ${table}`);
    await writer.query("SET statement_timeout = '2s'");
    await observer.query("SET statement_timeout = '2s'");
    const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]?.pid as number;
    const target = { schema, table: 'IngestReceipt', index: 'IngestReceipt_pkey', keyColumns: ['projectId', 'eventId'] };
    await work({ db, writer, observer, table, target, pid });
  } finally {
    await writer.query('ROLLBACK').catch(() => undefined);
    if (created) {
      await observer.query("SET lock_timeout = '5s'").catch(() => undefined);
      await observer.query(`DROP SCHEMA "${schema}" CASCADE`).catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'qa.compaction_cleanup_failed', schema, code: (error as { code?: string }).code }));
      });
    }
    await Promise.allSettled(clients.map((client) => client.end()));
  }
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

it.runIf(process.env.DATABASE_URL)('rebuilds a private index with concurrent writer progress, then skips it', async () => {
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

it.runIf(process.env.DATABASE_URL)('cleans the invalid ccnew copy left by cancelling its own concurrent rebuild', async () => {
  await withFixture(async ({ db, writer, observer, table, target, pid }) => {
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO ${table} VALUES ('qa-writer', 'qa-cancel')`);
    const rebuilding = compactIngestReceiptIndex({ db, target });
    const outcome = rebuilding.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitForWriterPhase(observer, pid);
      expect(await invalidCopies(observer, table)).toHaveLength(1);
      expect((await observer.query('SELECT pg_cancel_backend($1) cancelled', [pid])).rows[0]?.cancelled).toBe(true);
      // Concurrent DROP also waits on this writer; release it before awaiting cancellation cleanup.
      await writer.query('ROLLBACK');
      expect(await outcome).toMatchObject({ code: '57014' });
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
