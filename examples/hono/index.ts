import { serve } from '@hono/node-server';
import { type AuditVariables, trailmark } from '@trailmark/hono';
import { readAuditTrail, trailQuery } from '@trailmark/sdk/read';
import { Hono } from 'hono';
import { options } from './audit.server';

const app = new Hono<{ Variables: AuditVariables }>();
const capture = trailmark(options);
app.use(capture);
app.post('/demo', (c) => {
  c.var.audit('hono.record.updated', { targets: [{ type: 'record', id: 'demo-record' }] });
  return c.json({ ok: true });
});
app.get('/history', async (c) =>
  c.json(
    await readAuditTrail(
      { endpoint: 'http://127.0.0.1:4731', readKey: process.env.TRAILMARK_READ_KEY ?? '' },
      trailQuery({ target: { id: 'demo-record' } }),
    ),
  ),
);
const server = serve({ fetch: app.fetch, port: 4730, hostname: '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close();
    void capture.shutdown();
  });
