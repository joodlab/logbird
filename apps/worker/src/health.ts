import { prisma } from '@logbird/database';
import { env } from './env';
import { closeRetentionQueue, connection } from './queue';
import { clickhouse } from './retention';
import { webhookSigningConfig } from './webhook-config';

try {
  const signing = webhookSigningConfig(env);
  if (!signing.key) {
    console.error(JSON.stringify({ level: 'error', event: signing.event, message: signing.message }));
    process.exitCode = 1;
  }
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
