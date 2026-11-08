import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolClient } from 'pg';
import { PrismaClient } from './generated/client';
import { keys } from './keys';

export * from './generated/client';
export * from './ingest-receipts';

const databaseUrl = keys().DATABASE_URL;
const poolLimit = Number(new URL(databaseUrl).searchParams.get('connection_limit') ?? 10);
if (!Number.isInteger(poolLimit) || poolLimit < 1 || poolLimit > 100) throw new Error('connection_limit must be an integer from 1 to 100');
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: poolLimit }) });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/** Separate, bounded session-lock pool: never occupy Prisma's application pool or a transaction during ClickHouse I/O. */
const lockUrl = new URL(databaseUrl);
lockUrl.searchParams.set('application_name', 'logbird-project-locks');
const LOCK_POOL_MAX = 16;
const projectLocks = new Pool({
  connectionString: lockUrl.toString(),
  max: LOCK_POOL_MAX,
  idleTimeoutMillis: 1000,
  connectionTimeoutMillis: 2000,
  options: '-c lock_timeout=1000 -c statement_timeout=2000',
});
projectLocks.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'project_lock.connection_failed' })));
let admitted = 0;
export class ProjectBusyError extends Error {
  constructor() {
    super('Project maintenance is busy. Retry shortly.');
    this.name = 'ProjectBusyError';
  }
}
export interface ProjectLockOptions {
  /**
   * shared    – ingestion: many writers of new events may hold it at once.
   * exclusive – maintenance (retention purge, sample data, deletion, policy changes): excludes everyone.
   */
  mode?: 'shared' | 'exclusive';
  /** How long to keep trying before ProjectBusyError. Never blocks a Prisma connection or a transaction. */
  waitMs?: number;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Two session-level advisory locks per project, held on a dedicated bounded pool:
 *  - data lock (key 0): shared by ingest, exclusive for maintenance;
 *  - gate (key 1): writer preference — maintenance holds it while waiting for in-flight ingests to drain, and
 *    ingest must pass it (momentary shared try-lock) before taking the data lock, so a steady ingest stream
 *    cannot starve maintenance.
 * Every acquisition is a non-blocking try with a bounded retry loop: a long purge makes callers fail fast with
 * ProjectBusyError (503 + Retry-After) instead of queueing pooled connections.
 */
export async function withProjectLock<T>(
  projectId: string,
  work: (db: import('./generated/client').Prisma.TransactionClient) => Promise<T>,
  { mode = 'exclusive', waitMs = 3000 }: ProjectLockOptions = {},
): Promise<T> {
  const deadline = Date.now() + waitMs;
  while (admitted >= LOCK_POOL_MAX) {
    if (Date.now() >= deadline) throw new ProjectBusyError();
    await sleep(25);
  }
  admitted++;
  let client: PoolClient | undefined;
  let data = false,
    gate = false;
  const shared = mode === 'shared';
  const tryLock = async (sql: string) => (await (client as PoolClient).query(sql, [projectId])).rows[0]?.locked === true;
  try {
    client = await projectLocks.connect();
    for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
      if (shared) {
        // Pass the gate (fails while maintenance is waiting or running), then take the shared data lock.
        if (await tryLock('SELECT pg_try_advisory_lock_shared(hashtextextended($1, 1)) locked')) {
          data = await tryLock('SELECT pg_try_advisory_lock_shared(hashtextextended($1, 0)) locked');
          await client.query('SELECT pg_advisory_unlock_shared(hashtextextended($1, 1))', [projectId]);
        }
      } else {
        gate ||= await tryLock('SELECT pg_try_advisory_lock(hashtextextended($1, 1)) locked');
        if (gate) data = await tryLock('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) locked');
      }
      if (data) break;
      if (Date.now() >= deadline) throw new ProjectBusyError();
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    }
    // Database calls use short, independent statements. The callback is NOT a transaction.
    return await work(prisma);
  } finally {
    try {
      if (client && data)
        await client.query(
          shared ? 'SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))' : 'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [projectId],
        );
      if (client && gate) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 1))', [projectId]);
      client?.release();
    } catch (error) {
      client?.release(error instanceof Error ? error : new Error('Project lock connection failed'));
      console.error(JSON.stringify({ level: 'error', event: 'project_lock.release_failed' }));
    } finally {
      admitted--;
    }
  }
}
export const closeProjectLocks = () => projectLocks.end();

/** Replaces the existing project lookup: acceptance follows every active fence, with no extra round trip.
 * The caller holds the shared project lock, so an export cannot register a new fence until INSERT settles.
 */
export async function findIngestProject(db: import('./generated/client').Prisma.TransactionClient, projectId: string) {
  const rows = await db.$queryRaw<{ id: string; organizationId: string; acceptedAt: Date }[]>`
    SELECT p.id,p."organizationId",greatest(clock_timestamp(),
      (SELECT (max("receivedBefore") AT TIME ZONE 'UTC') + interval '1 millisecond' FROM "ExportLease"
       WHERE "projectId"=p.id AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC'))) AS "acceptedAt"
    FROM "Project" p WHERE p.id=${projectId}`;
  return rows[0] ?? null;
}

/** Call only while holding the project lock. Old clients/runs fall back to startedAt. */
export const RETENTION_LEASE_MS = 10 * 60_000;
export async function recoverAbandonedRetention(tx: import('./generated/client').Prisma.TransactionClient, projectId: string) {
  const expired = new Date(Date.now() - RETENTION_LEASE_MS);
  return tx.retentionRun.updateMany({
    where: { projectId, status: 'running', OR: [{ heartbeatAt: { lt: expired } }, { heartbeatAt: null, startedAt: { lt: expired } }] },
    data: { status: 'failed', finishedAt: new Date(), error: 'abandoned' },
  });
}

export * from './audit-outbox';
export * from './auth-email-hash';
