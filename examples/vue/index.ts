import { serve } from '@hono/node-server';
import { type AuditVariables, trailmark } from '@trailmark/hono';
import { readAuditTrail, trailQuery } from '@trailmark/sdk/read';
import { useAuditTrail } from '@trailmark/vue';
import { renderToString } from '@vue/server-renderer';
import { Hono } from 'hono';
import { createSSRApp, h, onServerPrefetch } from 'vue';
import { options } from './audit.server';

const app = new Hono<{ Variables: AuditVariables }>();
const capture = trailmark(options);
app.use(capture);
const read = () =>
  readAuditTrail({ endpoint: 'http://127.0.0.1:4731', readKey: process.env.TRAILMARK_READ_KEY ?? '' }, trailQuery({ target: { id: 'demo-record' } }));
app.post('/demo', (c) => {
  c.var.audit('vue.record.updated', { targets: [{ type: 'record', id: 'demo-record' }] });
  return c.json({ ok: true });
});
app.get('/history', async (c) => {
  const view = createSSRApp({
    setup() {
      // The fetcher is server-owned; keys are never serialized to component props.
      const trail = useAuditTrail({ fetcher: read, target: { id: 'demo-record' } });
      onServerPrefetch(async () => {
        await trail.refresh();
        if (trail.error.value) throw trail.error.value;
      });
      return () => h('pre', JSON.stringify(trail.data.value.map((event) => ({ id: event.id, action: event.action }))));
    },
  });
  return c.html(await renderToString(view));
});
const server = serve({ fetch: app.fetch, port: 4730, hostname: '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close();
    void capture.shutdown();
  });
