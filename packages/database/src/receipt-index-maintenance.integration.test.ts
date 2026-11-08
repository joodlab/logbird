import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { compactIngestReceiptIndex, RECEIPT_INDEX_COMPACTION } from './receipt-index-maintenance';

vi.setConfig({ testTimeout: 300_000 });

/**
 * Real Postgres, one private session: a temp "IngestReceipt" with the shared table's columns and indexes stands in
 * for the real one. Nothing shared is created, vacuumed or reindexed; the temp table disappears with the session.
 */
it.runIf(process.env.DATABASE_URL)('rebuilds a bloated receipt primary key online once, then leaves the compact index alone', async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'qa-receipt-index-compaction' });
  const other = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'qa-receipt-index-compaction-peer' });
  await Promise.all([db.connect(), other.connect()]);
  try {
    await db.query("SET temp_buffers = '256MB'");
    await db.query('CREATE TEMP TABLE "IngestReceipt" (LIKE public."IngestReceipt" INCLUDING ALL)');
    const schema = (await db.query<{ name: string }>('SELECT nspname name FROM pg_namespace WHERE oid=pg_my_temp_schema()')).rows[0]?.name as string;
    const target = { schema, table: 'IngestReceipt', index: 'IngestReceipt_pkey', keyColumns: ['projectId', 'eventId'] };
    const fill = (rows: number) =>
      db.query(
        `INSERT INTO "IngestReceipt" ("projectId","organizationId","eventId","fingerprint","receivedAt","eventAt","confirmedAt","claimedAt")
         SELECT 'qa-compaction-project', 'qa-compaction-org', gen_random_uuid()::text, 'v1:fixture', now(), now(), now(), NULL
         FROM generate_series(1, $1)`,
        [rows],
      );
    // A drained backlog: 800k random-key receipts, all but 10k swept, statistics refreshed. No VACUUM FULL.
    await fill(800_000);
    await db.query('DELETE FROM "IngestReceipt" WHERE ctid NOT IN (SELECT ctid FROM "IngestReceipt" LIMIT 10000)');
    await db.query('VACUUM ANALYZE "IngestReceipt"');

    // Another worker holds the single-flight lock: this call must not rebuild.
    await other.query("SELECT pg_advisory_lock(hashtext('logbird:ingest-receipt-index-compaction'))");
    expect((await compactIngestReceiptIndex({ db, target })).action).toBe('skipped_busy');
    await other.query("SELECT pg_advisory_unlock(hashtext('logbird:ingest-receipt-index-compaction'))");

    const rebuilt = await compactIngestReceiptIndex({ db, target });
    expect(rebuilt).toMatchObject({ action: 'reindexed', droppedInvalid: 0 });
    expect(rebuilt.indexPages).toBeGreaterThanOrEqual(RECEIPT_INDEX_COMPACTION.minPages);
    expect(rebuilt.pagesAfter).toBeLessThan((rebuilt.neededPages as number) * 2);
    // The rebuilt index is valid, still the primary key, and still serves the ordered seek.
    const { rows } = await db.query<{ valid: boolean; primary: boolean }>(
      `SELECT i.indisvalid valid, i.indisprimary "primary" FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
       WHERE i.indrelid='"IngestReceipt"'::regclass AND c.relname='IngestReceipt_pkey'`,
    );
    expect(rows).toEqual([{ valid: true, primary: true }]);
    expect((await db.query('SELECT count(*)::int n FROM "IngestReceipt"')).rows[0]?.n).toBe(10_000);
    expect((await compactIngestReceiptIndex({ db, target })).action).toBe('skipped_compact');
    // The single-flight lock was released.
    expect((await other.query("SELECT pg_try_advisory_lock(hashtext('logbird:ingest-receipt-index-compaction')) ok")).rows[0]?.ok).toBe(true);
    console.log(JSON.stringify({ event: 'qa.receipt_index_compaction', rebuilt }));
  } finally {
    await Promise.allSettled([db.end(), other.end()]);
  }
});
