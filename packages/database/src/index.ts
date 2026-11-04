import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';
import { keys } from './keys';

export * from './generated/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: keys().DATABASE_URL }) });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
