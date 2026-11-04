import { serve } from '@hono/node-server';
import { prisma } from '@trailmark/database';
import { closeRetentionQueue } from '@trailmark/worker/queue';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { env } from './env';

const server = serve({ fetch: app.fetch, port: env.PORT }, () =>
  console.log(JSON.stringify({ level: 'info', event: 'server.ready', port: env.PORT })),
);
function shutdown() {
  server.close(async () => {
    await closeRetentionQueue();
    await clickhouse.close();
    await prisma.$disconnect();
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
