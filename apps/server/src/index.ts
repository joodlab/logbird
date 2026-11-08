import { serve } from '@hono/node-server';
import { closeProjectLocks, prisma } from '@logbird/database';
import { closeRetentionQueue } from '@logbird/worker/queue';
import { app } from './app';
import { backfillAuthEmailHashes, flushFailedSignIns } from './auth-failures';
import { clickhouse, maintenanceClickhouse, queryClickhouse } from './clickhouse';
import { env } from './env';
import { ingest } from './ingest';
import { startAuditDrainer } from './outbox-delivery';
import { rateLimitStore } from './rate-limit';

const server = serve({ fetch: app.fetch, port: env.PORT }, () =>
  console.log(JSON.stringify({ level: 'info', event: 'server.ready', port: env.PORT })),
);
// Keep idle keep-alive sockets open longer than any proxy in front of us (the console's Nitro proxy, Caddy, load balancers
// typically 60 s). With Node's 5 s default, a proxy can reuse a socket at the moment Node closes it and the user gets an
// ECONNRESET → 500/502. headersTimeout must stay above keepAliveTimeout.
if ('keepAliveTimeout' in server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
const auditDrainer = startAuditDrainer(ingest, async () => {
  await backfillAuthEmailHashes(env.BETTER_AUTH_SECRET);
  await flushFailedSignIns();
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const drained = auditDrainer.stop();
  const deadline = setTimeout(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    process.exit(1);
  }, 30_000);
  deadline.unref();
  server.close(async () => {
    await drained;
    const results = await Promise.allSettled([
      closeRetentionQueue(),
      closeProjectLocks(),
      rateLimitStore.quit(),
      clickhouse.close(),
      maintenanceClickhouse.close(),
      queryClickhouse?.close(),
      prisma.$disconnect(),
    ]);
    if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
    clearTimeout(deadline);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
