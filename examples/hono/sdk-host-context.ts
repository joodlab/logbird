import { serve } from '@hono/node-server';
import { type AuditVariables, logbird } from '@logbird/hono';
import { Logbird, redact } from '@logbird/sdk';
import { jobAudit } from '@logbird/sdk/integration';
import { Hono } from 'hono';

const client = new Logbird({
  endpoint: process.env.LOGBIRD_ENDPOINT,
  apiKey: process.env.LOGBIRD_INGEST_KEY,
  defaults: { environment: 'staging' },
  beforeSend: redact(),
});
const app = new Hono<{ Variables: AuditVariables & { user: string; requestId: string } }>();
const capture = logbird({
  client,
  actor: (c) => (c.get('user') ? { type: 'user', id: c.get('user') } : undefined),
  requestId: (c) => c.get('requestId'),
});
app.use(capture);
app.post(
  '/demo',
  async (c, next) => {
    c.set('user', 'fictional-guard-user');
    c.set('requestId', 'fictional-host-request');
    await next();
  },
  async (c) => {
    const id = c.var.audit('host.api.updated', { metadata: { secret: 'fictional-secret' } });
    const carrier = await c.var.audit.carrier({ parentEventId: id });
    const job = jobAudit({ client, carrier, job: { id: 'fictional-job', queueName: 'fictional-queue', attemptsMade: 2 } });
    const jobId = job('host.job.updated');
    await Promise.all([c.var.audit.pending(), job.pending()]);
    await client.flush();
    return c.json({ id, jobId, operationId: carrier.operationId });
  },
);
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT), hostname: '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close();
    void capture.shutdown();
  });
