import { Trailmark } from '@trailmark/sdk';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { type AuditVariables, trailmark } from './index';

it('isolates concurrent requests, merges causation and auto-tracks mutations', async () => {
  const client = new Trailmark({ endpoint: 'http://unused', apiKey: 'fake' });
  const track = vi.spyOn(client, 'track').mockImplementation(() => undefined);
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(trailmark({ client, actor: (c) => ({ id: c.req.header('user') }), tenant: () => ({ id: 'tenant' }), autoTrack: {} }));
  app.post('/', async (c) => {
    await Promise.resolve();
    c.var.audit('record.updated', { context: { parentEventId: 'parent' } });
    return c.text('ok');
  });
  await Promise.all(['alice', 'bob'].map((user) => app.request('/', { method: 'POST', headers: { user, 'x-trailmark-operation': user } })));
  expect(track).toHaveBeenCalledTimes(4);
  for (const [event] of track.mock.calls) expect(event.context?.operationId).toBe(event.actor?.id);
  expect(track.mock.calls[0]?.[0].context?.parentEventId).toBe('parent');
});
it('preserves host success when resolver and diagnostic hook throw', async () => {
  const client = new Trailmark({ endpoint: 'http://unused', apiKey: 'fake' });
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(
    trailmark({
      client,
      actor: () => {
        throw new Error('identity');
      },
      tenant: () => undefined,
      onError: () => {
        throw new Error('hook');
      },
    }),
  );
  app.get('/', (c) => {
    c.var.audit('x');
    return c.text('ok');
  });
  expect((await app.request('/')).status).toBe(200);
});
it('registers edge flush without blocking the response', async () => {
  const client = new Trailmark({ endpoint: 'http://unused', apiKey: 'fake' });
  const flush = vi.spyOn(client, 'flush').mockResolvedValue();
  const waitUntil = vi.fn();
  const app = new Hono();
  app.use(trailmark({ client, actor: () => undefined, tenant: () => undefined }));
  app.get('/', (c) => c.text('ok'));
  await app.fetch(
    new Request('http://local/'),
    {},
    {
      waitUntil,
      passThroughOnException() {
        /* unused in this test */
      },
      props: {},
    },
  );
  expect(waitUntil).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalledOnce();
});
