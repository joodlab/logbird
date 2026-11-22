import { type Prisma, prisma } from '@logbird/database';

export async function webhookDatabaseTime(db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma) {
  const [{ now }] = await db.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
  return now;
}
