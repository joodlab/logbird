import pg from 'pg';
import { keys } from './keys';

/**
 * Worker-only maintenance; never call it from the API or the ingest path. A drained receipt backlog leaves the
 * primary key at its high-water size: VACUUM recycles empty pages but never shrinks the index, and half-empty
 * random-UUID leaf pages stay. Lookups then miss shared buffers far more often than the live data warrants.
 * This rebuilds the index online, at most once per call, only when it is materially larger than its live entries
 * need.
 */
export const RECEIPT_INDEX_COMPACTION = {
  /**
   * Rebuild only above this multiple of the pages the live entries need (at the default 90% leaf fill). Measured
   * steady churn sits at 1.6-1.9x (tuned vs default autovacuum); a drained backlog twice the live window left 3.9x.
   */
  bloatFactor: 3,
  /** Never rebuild a small index: 8192 pages is 64 MiB. */
  minPages: 8192,
  /** REINDEX CONCURRENTLY waits for older transactions and builds a full copy; bound both. */
  statementTimeoutMs: 15 * 60_000,
  lockTimeoutMs: 60_000,
} as const;

const LOCK_KEY = 'logbird:ingest-receipt-index-compaction';
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export type ReceiptIndexTarget = { schema?: string; table: string; index: string; keyColumns: string[] };
export const INGEST_RECEIPT_PKEY: ReceiptIndexTarget = {
  table: 'IngestReceipt',
  index: 'IngestReceipt_pkey',
  keyColumns: ['projectId', 'eventId'],
};

export type ReceiptIndexCompaction = {
  action: 'skipped_busy' | 'skipped_missing' | 'skipped_no_statistics' | 'skipped_compact' | 'reindexed';
  indexPages: number;
  neededPages?: number;
  ratio?: number;
  pagesAfter?: number;
  durationMs?: number;
  droppedInvalid: number;
};

/** Pages a freshly built B-tree needs: per-entry key bytes from ANALYZE, plus tuple header and line pointer. */
export function neededIndexPages(liveTuples: number, keyBytes: number, fill = 0.9) {
  const entryBytes = Math.ceil((keyBytes + 8) / 8) * 8 + 4;
  return Math.max(1, Math.ceil((liveTuples * entryBytes) / (8192 * fill)));
}

type Queryable = Pick<pg.Client, 'query'>;
async function connect() {
  const client = new pg.Client({
    connectionString: keys().DATABASE_URL,
    application_name: 'logbird-receipt-index-maintenance',
    connectionTimeoutMillis: 5000,
    options: `-c statement_timeout=${RECEIPT_INDEX_COMPACTION.statementTimeoutMs} -c lock_timeout=${RECEIPT_INDEX_COMPACTION.lockTimeoutMs}`,
  });
  client.on('error', (error) => {
    const code = 'code' in error ? String(error.code) : undefined;
    console.error(JSON.stringify({ level: 'error', event: 'ingest.receipt_index_connection_failed', code }));
  });
  try {
    await client.connect();
    // URL options override pg's constructor config. Apply bounds to the connected session.
    await client.query(`SET statement_timeout = ${RECEIPT_INDEX_COMPACTION.statementTimeoutMs}`);
    await client.query(`SET lock_timeout = ${RECEIPT_INDEX_COMPACTION.lockTimeoutMs}`);
    await client.query("SET application_name = 'logbird-receipt-index-maintenance'");
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

/** An interrupted REINDEX CONCURRENTLY leaves an invalid copy that every write still maintains. */
async function dropInvalidCopies(db: Queryable, target: ReceiptIndexTarget & { schema: string }) {
  const { rows } = await db.query<{ name: string }>(
    `SELECT c.relname name FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE i.indrelid=to_regclass($1) AND NOT i.indisvalid AND c.relname ~ ('^' || $2 || '_cc(new|old)[0-9]*$')`,
    [`${quote(target.schema)}.${quote(target.table)}`, target.index],
  );
  for (const { name } of rows) await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quote(target.schema)}.${quote(name)}`);
  return rows.length;
}

async function indexPages(db: Queryable, target: ReceiptIndexTarget & { schema: string }) {
  const { rows } = await db.query<{ pages: string | null }>('SELECT pg_relation_size(to_regclass($1))/8192 pages', [
    `${quote(target.schema)}.${quote(target.index)}`,
  ]);
  return rows[0]?.pages == null ? null : Number(rows[0].pages);
}

/**
 * Rebuilds the receipt primary key online when it is bloated. Single-flight across workers through a session
 * advisory lock on its own connection; REINDEX CONCURRENTLY cannot run inside a transaction or a pooled Prisma call.
 */
export async function compactIngestReceiptIndex({
  target: requestedTarget = INGEST_RECEIPT_PKEY,
  db,
}: {
  target?: ReceiptIndexTarget;
  db?: Queryable;
} = {}): Promise<ReceiptIndexCompaction> {
  const client = db ?? (await connect());
  let locked = false;
  let lockKey: string = LOCK_KEY;
  try {
    const schema =
      requestedTarget.schema ??
      (
        await client.query<{ schema: string }>(
          'SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)',
          [quote(requestedTarget.table)],
        )
      ).rows[0]?.schema;
    if (!schema) return { action: 'skipped_missing', indexPages: 0, droppedInvalid: 0 };
    const target = { ...requestedTarget, schema };
    // Isolate private integration targets while keeping workers on the same real index single-flight.
    lockKey = `${LOCK_KEY}:${quote(schema)}.${quote(target.index)}`;
    locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) locked', [lockKey])).rows[0]?.locked === true;
    const pages = await indexPages(client, target);
    if (pages === null) return { action: 'skipped_missing', indexPages: 0, droppedInvalid: 0 };
    if (!locked) return { action: 'skipped_busy', indexPages: pages, droppedInvalid: 0 };
    const droppedInvalid = await dropInvalidCopies(client, target);
    if (pages < RECEIPT_INDEX_COMPACTION.minPages) return { action: 'skipped_compact', indexPages: pages, droppedInvalid };
    const { rows } = await client.query<{ live: number; key_bytes: number | null }>(
      `SELECT greatest(c.reltuples, 0)::float8 live,
        (SELECT sum(s.avg_width)::float8 FROM pg_stats s WHERE s.schemaname=$1 AND s.tablename=$2 AND s.attname=ANY($3::text[])) key_bytes
       FROM pg_class c WHERE c.oid=to_regclass($4)`,
      [target.schema, target.table, target.keyColumns, `${quote(target.schema)}.${quote(target.table)}`],
    );
    const live = Number(rows[0]?.live ?? 0);
    const keyBytes = rows[0]?.key_bytes;
    if (!keyBytes) return { action: 'skipped_no_statistics', indexPages: pages, droppedInvalid };
    const neededPages = neededIndexPages(live, keyBytes);
    const ratio = Math.round((pages / neededPages) * 10) / 10;
    if (pages < RECEIPT_INDEX_COMPACTION.bloatFactor * neededPages)
      return { action: 'skipped_compact', indexPages: pages, neededPages, ratio, droppedInvalid };
    const started = Date.now();
    try {
      await client.query(`REINDEX INDEX CONCURRENTLY ${quote(target.schema)}.${quote(target.index)}`);
    } catch (error) {
      // Timeout or cancellation: never leave a maintained invalid copy behind.
      await dropInvalidCopies(client, target).catch(() => undefined);
      throw error;
    }
    return {
      action: 'reindexed',
      indexPages: pages,
      neededPages,
      ratio,
      pagesAfter: (await indexPages(client, target)) ?? undefined,
      durationMs: Date.now() - started,
      droppedInvalid,
    };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    if (!db) await (client as pg.Client).end().catch(() => undefined);
  }
}
