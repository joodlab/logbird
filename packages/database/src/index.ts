import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';
import { keys } from './keys';

export * from './generated/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: keys().DATABASE_URL }) });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/** Shared by HTTP ingestion and retention workers, including separate replicas. */
export function withProjectLock<T>(projectId: string, work: (tx: import('./generated/client').Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))::text`;
      return work(tx);
    },
    { timeout: 300_000, maxWait: 300_000 },
  );
}
