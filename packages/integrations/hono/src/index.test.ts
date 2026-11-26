import { Logbird } from '@logbird/sdk';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { type AuditVariables, logbird } from './index';

it('propagates delivery failure from adapter shutdown', async () => {
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake', maxRetries: 0 });
  const capture = logbird({ client });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 500 }));
  try {
    client.track({ action: 'failed' });
    await expect(capture.shutdown()).rejects.toThrow();
  } finally {
    fetch.mockRestore();
  }
});

it('bounds resolver waits within the client shutdown budget and counts reserved captures', async () => {
  vi.useFakeTimers();
  try {
    const onDrop = vi.fn();
    const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake', maxQueueSize: 1, shutdownTimeoutMs: 25, onDrop });
    const actor = vi.fn(() => new Promise<undefined>(() => undefined));
    const capture = logbird({ client, actor });
    const app = new Hono<{ Variables: AuditVariables }>();
    app.use(capture);
    app.get('/', (c) => {
      c.var.audit('waiting');
      c.var.audit('overflow');
      return c.text('ok');
    });
    await app.request('/');
    const closing = expect(capture.shutdown()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(25);
    await closing;
    expect(actor).toHaveBeenCalledOnce();
    expect(onDrop.mock.calls.map(([event, details]) => [event.action, details.reason, details.mayBeStored])).toEqual([
      ['overflow', 'queue_full', false],
      ['waiting', 'shutdown', false],
    ]);
  } finally {
    vi.useRealTimers();
  }
}, 500);

it('counts a capture preparation failure by the returned id', async () => {
  const onDrop = vi.fn();
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake', onDrop });
  const capture = logbird({ client });
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(capture);
  app.get('/', (c) =>
    c.text(
      c.var.audit('failed', {
        context: {
          get operationId(): string {
            throw new Error('fixture');
          },
        },
      }),
    ),
  );
  const id = await (await app.request('/')).text();
  await capture.shutdown();
  expect(onDrop).toHaveBeenCalledWith({ action: 'failed', id }, { reason: 'invalid', mayBeStored: false });
});

it('sends the id returned by audit for a blank input even if beforeSend changes it', async () => {
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake', beforeSend: (event) => ({ ...event, id: 'hook' }) });
  const capture = logbird({ client });
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(capture);
  app.get('/', (c) => c.text(c.var.audit('test.audit', { id: '   ' })));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const id = JSON.parse(String(init?.body)).events[0].id;
    return Response.json({ accepted: 1, ids: [id], rejected: [], warnings: [] }, { status: 202 });
  });
  try {
    const id = await (await app.request('/')).text();
    await capture.shutdown();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).events[0].id).toBe(id);
  } finally {
    fetch.mockRestore();
  }
});

it('isolates concurrent requests, merges causation and auto-tracks mutations', async () => {
  const client = new Logbird({ enabled: false });
  const track = vi.spyOn(client, 'track').mockImplementation(() => undefined);
  const app = new Hono<{ Variables: AuditVariables }>();
  const capture = logbird({
    client,
    actor: (c) => ({ id: c.req.header('user') }),
    tenant: () => ({ id: 'tenant' }),
    useOperationHeader: true,
    autoTrack: {},
  });
  app.use(capture);
  app.post('/', async (c) => {
    await Promise.resolve();
    c.var.audit('record.updated', { context: { parentEventId: 'parent' } });
    return c.text('ok');
  });
  await Promise.all(['alice', 'bob'].map((user) => app.request('/', { method: 'POST', headers: { user, 'x-logbird-operation': user } })));
  await capture.shutdown();
  expect(track).toHaveBeenCalledTimes(4);
  for (const [event] of track.mock.calls) expect(event.context?.operationId).toBe(event.actor?.id);
  expect(track.mock.calls[0]?.[0].context?.parentEventId).toBe('parent');
});
it('preserves host success when resolver and diagnostic hook throw', async () => {
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake' });
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(
    logbird({
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
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake' });
  const flush = vi.spyOn(client, 'flush').mockResolvedValue();
  const waitUntil = vi.fn();
  const app = new Hono();
  app.use(logbird({ client, actor: () => undefined, tenant: () => undefined }));
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
  const client = new Logbird({ enabled: false });
  const track = vi.spyOn(client, 'track');
  const app = new Hono<{ Variables: AuditVariables & { user: string; requestId: string } }>();
  const capture = logbird({
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
  const client = new Logbird({ enabled: false });
  const track = vi.spyOn(client, 'track');
  const flush = vi.spyOn(client, 'flush');
  let resolve!: (actor: { id: string }) => void;
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(
    logbird({
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

it('reports resolver exceptions by stable code without their message or cause', async () => {
  const client = new Logbird({ enabled: false });
  const onError = vi.fn();
  const marker = 'fixture-private-value';
  const capture = logbird({
    client,
    onError,
    actor: () => {
      throw new Error(marker, { cause: marker });
    },
  });
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(capture);
  app.get('/', (c) => c.text(c.var.audit('fixture.audit')));
  expect((await app.request('/')).status).toBe(200);
  await capture.shutdown();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'capture_resolver_failed' }));
  const error = onError.mock.calls[0]?.[0];
  expect(error.message).not.toContain(marker);
  expect(error.cause).toBeUndefined();
});

it('refuses oversized captures before running Hono resolvers', async () => {
  const actor = vi.fn();
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake' });
  const capture = logbird({ client, actor });
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(capture);
  app.get('/', (c) => c.text(c.var.audit('fixture.audit', { metadata: { token: 'a'.repeat(2 * 1024 * 1024) } })));
  expect((await app.request('/')).status).toBe(200);
  await capture.shutdown();
  expect(actor).not.toHaveBeenCalled();
  expect(client.droppedByReason).toEqual({ input_too_large: 1 });
});

it('refuses an oversized Hono action before invoking the resolvers', async () => {
  const actor = vi.fn();
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake' });
  const capture = logbird({ client, actor });
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(capture);
  app.get('/', (c) => c.text(c.var.audit('a'.repeat(2 * 1024 * 1024))));
  expect((await app.request('/')).status).toBe(200);
  await capture.shutdown();
  expect(actor).not.toHaveBeenCalled();
  expect(client.droppedByReason).toEqual({ input_too_large: 1 });
});

it('counts the automatic event when the Hono skip hook throws', async () => {
  const onDrop = vi.fn();
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake', onDrop });
  const capture = logbird({
    client,
    autoTrack: {
      skip: () => {
        throw new Error('fixture-private-value');
      },
    },
  });
  const app = new Hono<{ Variables: AuditVariables }>();
  app.use(capture);
  app.post('/', (c) => c.text('ok'));
  expect((await app.request('/', { method: 'POST' })).status).toBe(200);
  await capture.shutdown();
  expect(client.droppedByReason).toEqual({ invalid: 1 });
  expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ action: 'http.post' }), { reason: 'invalid', mayBeStored: false });
});
