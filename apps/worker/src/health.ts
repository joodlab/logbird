import { prisma } from '@logbird/database';
import { closeRetentionQueue, connection } from './queue';
import { clickhouse } from './retention';

try {
  await Promise.all([
    connection.ping(),
    prisma.$queryRaw`SELECT 1`,
    clickhouse.ping().then((r) => {
      if (!r.success) throw new Error('Storage unavailable');
    }),
  ]);
} catch {
  process.exitCode = 1;
} finally {
  await Promise.allSettled([closeRetentionQueue(), clickhouse.close(), prisma.$disconnect()]);
}
