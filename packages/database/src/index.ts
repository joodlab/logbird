import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolClient } from 'pg';
import { PrismaClient } from './generated/client';
import { keys } from './keys';

export * from './generated/client';

const databaseUrl = keys().DATABASE_URL;
const poolLimit = Number(new URL(databaseUrl).searchParams.get('connection_limit') ?? 10);
if (!Number.isInteger(poolLimit) || poolLimit < 1 || poolLimit > 100) throw new Error('connection_limit must be an integer from 1 to 100');
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: poolLimit }) });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/** Separate, bounded session-lock pool: never occupy Prisma's application pool or a transaction during ClickHouse I/O. */
const lockUrl = new URL(databaseUrl);
lockUrl.searchParams.set('application_name', 'trailmark-project-locks');
const projectLocks = new Pool({
  connectionString: lockUrl.toString(),
  max: 8,
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
export async function withProjectLock<T>(
  projectId: string,
  work: (db: import('./generated/client').Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // No queue behind long maintenance, including connection acquisition in this pool.
  if (admitted >= 8) throw new ProjectBusyError();
  admitted++;
  let client: PoolClient | undefined;
  let locked = false;
  try {
    client = await projectLocks.connect();
    const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) locked', [projectId]);
    locked = result.rows[0]?.locked === true;
    if (!locked) throw new ProjectBusyError();
    // Database calls use short, independent statements. The callback is NOT a transaction.
    return await work(prisma);
  } finally {
    try {
      if (client && locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [projectId]);
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

/** Call only while holding the project lock. Old clients/runs fall back to startedAt. */
export const RETENTION_LEASE_MS = 10 * 60_000;
export async function recoverAbandonedRetention(tx: import('./generated/client').Prisma.TransactionClient, projectId: string) {
  const expired = new Date(Date.now() - RETENTION_LEASE_MS);
  return tx.retentionRun.updateMany({
    where: { projectId, status: 'running', OR: [{ heartbeatAt: { lt: expired } }, { heartbeatAt: null, startedAt: { lt: expired } }] },
    data: { status: 'failed', finishedAt: new Date(), error: 'abandoned' },
  });
}
