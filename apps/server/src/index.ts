import { serve } from '@hono/node-server';
import { closeProjectLocks, prisma } from '@trailmark/database';
import { closeRetentionQueue } from '@trailmark/worker/queue';
import { app } from './app';
import { clickhouse, queryClickhouse } from './clickhouse';
import { env } from './env';
import { rateLimitStore } from './rate-limit';

const server = serve({ fetch: app.fetch, port: env.PORT }, () =>
  console.log(JSON.stringify({ level: 'info', event: 'server.ready', port: env.PORT })),
);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    process.exit(1);
  }, 30_000);
  deadline.unref();
  server.close(async () => {
    const results = await Promise.allSettled([
      closeRetentionQueue(),
      closeProjectLocks(),
      rateLimitStore.quit(),
      clickhouse.close(),
      queryClickhouse?.close(),
      prisma.$disconnect(),
    ]);
    if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
    clearTimeout(deadline);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
