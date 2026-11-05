import { serve } from '@hono/node-server';
import { type AuditVariables, trailmark } from '@trailmark/hono';
import { readAuditTrail, trailQuery } from '@trailmark/sdk/read';
import { Hono } from 'hono';
import { endpoint, options } from './audit.server';

const app = new Hono<{ Variables: AuditVariables }>();
const capture = trailmark(options);
app.use(capture);
app.post('/demo', (c) => {
  c.var.audit('hono.record.updated', { targets: [{ type: 'record', id: 'demo-record' }] });
  return c.json({ ok: true });
});
app.onError(async (_error, c) => {
  await options.client.flush().catch(() => console.error('Audit flush failed'));
  return c.json({ error: 'Audit history unavailable. Please retry.' }, 502);
});
app.get('/history', async (c) =>
  c.json(await readAuditTrail({ endpoint, readKey: process.env.TRAILMARK_READ_KEY ?? '' }, trailQuery({ target: { id: 'demo-record' } }))),
);
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4730), hostname: '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close();
    void capture.shutdown().catch(() => console.error('Audit shutdown failed'));
  });
