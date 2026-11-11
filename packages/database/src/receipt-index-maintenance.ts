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
  action:
    | 'skipped_busy'
    | 'skipped_invalid_copy'
    | 'skipped_missing'
    | 'skipped_no_statistics'
    | 'skipped_old_transactions'
    | 'skipped_compact'
    | 'reindexed';
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
/** Connection plus session setup. A stalled server can hang a setup query, so abort and a deadline close the socket. */
export const RECEIPT_INDEX_SETUP_TIMEOUT_MS = 15_000;
async function connect(signal?: AbortSignal) {
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
  // Setup runs no long server work, so closing the socket is enough: pg's end() destroys it mid-connect or mid-query.
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= client.end().catch(() => undefined);
    return closing;
  };
  const deadline = setTimeout(() => void close(), RECEIPT_INDEX_SETUP_TIMEOUT_MS);
  signal?.addEventListener('abort', close, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect();
    signal?.throwIfAborted();
    // URL options override pg's constructor config. Apply bounds to the connected session.
    await client.query(`SET statement_timeout = ${RECEIPT_INDEX_COMPACTION.statementTimeoutMs}`);
    await client.query(`SET lock_timeout = ${RECEIPT_INDEX_COMPACTION.lockTimeoutMs}`);
    await client.query("SET application_name = 'logbird-receipt-index-maintenance'");
    try {
      await client.query("SET client_connection_check_interval = '1s'");
    } catch (error) {
      // PostgreSQL < 14 does not have this setting. Permission and connection failures must still surface.
      if ((error as { code?: string }).code !== '42704') throw error;
    }
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() pid');
    signal?.throwIfAborted();
    return { client, pid: rows[0]?.pid as number };
  } catch (error) {
    await close();
    // An abort or the deadline surfaces as the socket error it caused; report the cause instead.
    signal?.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', close);
  }
}

/** Keep the original session alive until its cancellation request has finished, so the pid cannot be reused. */
async function cancelBackend(pid: number, settled?: Promise<unknown>) {
  const cancel = new pg.Client({
    connectionString: keys().DATABASE_URL,
    application_name: 'logbird-receipt-index-cancel',
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    options: '-c statement_timeout=5000',
  });
  cancel.on('error', () => undefined);
  // Covers connection, SET and cancel together, including URL timeout overrides.
  const deadline = setTimeout(() => void cancel.end().catch(() => undefined), 10_000);
  try {
    await cancel.connect();
    await cancel.query('SET statement_timeout = 5000');
    await cancel.query('SELECT pg_cancel_backend($1)', [pid]);
    await settled;
  } finally {
    clearTimeout(deadline);
    await cancel.end().catch(() => undefined);
  }
}

/** An interrupted REINDEX CONCURRENTLY leaves an invalid copy that every write still maintains. */
async function dropInvalidCopies(db: Queryable, target: ReceiptIndexTarget & { schema: string }) {
  const { rows } = await db.query<{ name: string }>(
    `SELECT c.relname name FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE i.indrelid=to_regclass($1) AND NOT i.indisvalid
       AND left(c.relname, length($2)) = $2 AND substr(c.relname, length($2) + 1) ~ '^_cc(new|old)[0-9]*$'`,
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
  signal,
}: {
  target?: ReceiptIndexTarget;
  db?: Queryable;
  signal?: AbortSignal;
} = {}): Promise<ReceiptIndexCompaction> {
  const { client, pid } = db ? { client: db, pid: undefined } : await connect(signal);
  let cancellation: Promise<void> | undefined;
  let activeReindex: Promise<unknown> | undefined;
  let abortDeadline: ReturnType<typeof setTimeout> | undefined;
  let reindexRunning = false;
  const abort = () => {
    if (db || pid === undefined) return;
    // Only the REINDEX is cancelled server-side. Catalog queries and DROP INDEX CONCURRENTLY cleanup are left to
    // finish (the next step checks the signal), so a late shutdown never cancels the drop of an invalid copy.
    if (reindexRunning && activeReindex)
      cancellation = cancelBackend(pid, activeReindex).catch((error: unknown) => {
        const code = (error as { code?: string }).code;
        console.error(JSON.stringify({ level: 'error', event: 'ingest.receipt_index_cancel_failed', code }));
      });
    // pg.end() alone is not a server cancellation. It is only the bounded fallback if cancellation/cleanup stalls.
    abortDeadline = setTimeout(() => {
      // Without client_connection_check_interval (PostgreSQL < 14) a REINDEX whose cancel never landed keeps running
      // server-side; name the backend so an operator can check it before a migration that alters the table.
      console.warn(JSON.stringify({ level: 'warn', event: 'ingest.receipt_index_shutdown_fallback', pid, reindexRunning }));
      void (client as pg.Client).end().catch(() => undefined);
    }, 10_000);
  };
  signal?.addEventListener('abort', abort, { once: true });
  let locked = false;
  let lockKey: string = LOCK_KEY;
  try {
    signal?.throwIfAborted();
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
    locked =
      (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) locked', [lockKey])).rows[0]?.locked === true;
    const pages = await indexPages(client, target);
    if (pages === null) return { action: 'skipped_missing', indexPages: 0, droppedInvalid: 0 };
    if (!locked) return { action: 'skipped_busy', indexPages: pages, droppedInvalid: 0 };
    let droppedInvalid: number;
    try {
      droppedInvalid = await dropInvalidCopies(client, target);
    } catch (error) {
      // A MAINTAIN-only role (PG17+) can rebuild but not drop: report it instead of failing every hour.
      if ((error as { code?: string }).code !== '42501') throw error;
      return { action: 'skipped_invalid_copy', indexPages: pages, droppedInvalid: 0 };
    }
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
    // REINDEX CONCURRENTLY waits for older snapshots and table lockers. If one is already older than lock_timeout,
    // the rebuild would fail after building a full copy, every hour; skip instead. Best effort: a role without
    // pg_read_all_stats sees xact_start only for its own sessions.
    const { rows: old } = await client.query<{ n: number }>(
      `SELECT count(*)::int n FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND backend_type NOT IN ('autovacuum worker', 'autovacuum launcher') AND datname = current_database()
         AND xact_start < clock_timestamp() - make_interval(secs => $1::float8 / 1000)
         AND (backend_xmin IS NOT NULL OR pid IN (SELECT pid FROM pg_locks WHERE relation = to_regclass($2)))`,
      [RECEIPT_INDEX_COMPACTION.lockTimeoutMs, `${quote(target.schema)}.${quote(target.table)}`],
    );
    if (Number(old[0]?.n ?? 0) > 0) return { action: 'skipped_old_transactions', indexPages: pages, neededPages, ratio, droppedInvalid };
    const started = Date.now();
    signal?.throwIfAborted();
    try {
      reindexRunning = true;
      const reindexing = client.query(`REINDEX INDEX CONCURRENTLY ${quote(target.schema)}.${quote(target.index)}`);
      // Registered before the await below, so the flag is cleared before the catch block's cleanup can start.
      const stopped = () => {
        reindexRunning = false;
      };
      activeReindex = reindexing.then(stopped, stopped);
      await reindexing;
    } catch (error) {
      // A cancel sent while REINDEX ran must land before cleanup starts; later aborts no longer cancel anything.
      await cancellation;
      // Timeout or cancellation: never leave a maintained invalid copy behind.
      await dropInvalidCopies(client, target).catch(() => undefined);
      throw error;
    }
    // A cancel sent just as REINDEX finished must land before the size query, not on it.
    await cancellation;
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
    // Keep the abort listener through finalization: a shutdown while the unlock stalls still arms the socket fallback.
    try {
      await cancellation;
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
      if (!db) await (client as pg.Client).end().catch(() => undefined);
    } finally {
      signal?.removeEventListener('abort', abort);
      clearTimeout(abortDeadline);
    }
  }
}
