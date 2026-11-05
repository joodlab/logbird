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

it('sees per-route guard identity and host request ids in explicit and automatic events', async () => {
  const client = new Trailmark({ enabled: false });
  const track = vi.spyOn(client, 'track');
  const app = new Hono<{ Variables: AuditVariables & { user: string; requestId: string } }>();
  const capture = trailmark({
    client,
    actor: (c) => (c.get('user') ? { id: c.get('user') } : undefined),
    requestId: (c) => c.get('requestId'),
    autoTrack: {},
  });
  app.use(capture);
  app.post(
    '/',
    async (c, next) => {
      c.set('user', 'guard-user');
      c.set('requestId', 'host-request');
      await next();
    },
    (c) => {
      c.var.audit('guard.event');
      return c.text('ok');
    },
  );
  await app.request('/', { method: 'POST' });
  await capture.shutdown();
  expect(track).toHaveBeenCalledTimes(2);
  for (const [event] of track.mock.calls) expect(event).toMatchObject({ actor: { id: 'guard-user' }, context: { requestId: 'host-request' } });
});

it('edge waitUntil waits for async identity before flushing', async () => {
  const client = new Trailmark({ enabled: false });
  const track = vi.spyOn(client, 'track');
  const flush = vi.spyOn(client, 'flush');
  let resolve!: (actor: { id: string }) => void;
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(
    trailmark({
      client,
      actor: () =>
        new Promise<{ id: string }>((done) => {
          resolve = done;
        }),
    }),
  );
  app.post('/', (c) => {
    c.var.audit('edge');
    return c.text('ok');
  });
  const waitUntil = vi.fn();
  const response = await app.fetch(
    new Request('http://host/', { method: 'POST' }),
    {},
    {
      waitUntil,
      passThroughOnException() {
        /* unused by this fixture */
      },
      props: {},
    },
  );
  expect(response.status).toBe(200);
  expect(flush).not.toHaveBeenCalled();
  resolve({ id: 'edge-user' });
  await waitUntil.mock.calls[0]?.[0];
  expect(track.mock.calls[0]?.[0].actor?.id).toBe('edge-user');
  expect(flush).toHaveBeenCalledOnce();
});
