import { Logbird } from '@logbird/sdk';
import { trailQuery } from '@logbird/sdk/read';
import { createApp, eventHandler, toWebHandler } from 'h3';
import { expect, it, vi } from 'vitest';
import { attachAudit } from './capture';
import { createReadHandler } from './proxy';

it('denies by default and attaches h3 audit context through the real h3 handler', async () => {
  const app = createApp();
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake' });
  app.use(eventHandler((event) => attachAudit(event, client, { authorize: () => false })));
  app.use('/events', createReadHandler({ endpoint: 'http://unused', readKey: 'fake' }, { authorize: () => false }));
  app.use(
    '/context',
    eventHandler((event) => ({ audit: typeof event.context.audit })),
  );
  const handle = toWebHandler(app);
  expect((await handle(new Request('http://local/events'))).status).toBe(403);
  expect(await (await handle(new Request('http://local/context'))).json()).toEqual({ audit: 'function' });
  await client.shutdown();
});

it('reads inbound correlation headers only when the hooks opt in (#321)', async () => {
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake' });
  const track = vi.spyOn(client, 'track').mockReturnValue(undefined as never);
  const headers = { 'x-request-id': 'req_from_client', 'x-logbird-operation': 'op_from_client' };
  for (const optIn of [false, true]) {
    const app = createApp();
    const hooks = { authorize: () => false as const, useOperationHeader: optIn, useRequestIdHeader: optIn };
    app.use(eventHandler((event) => attachAudit(event, client, hooks)));
    app.use(
      eventHandler(async (event) => {
        event.context.audit('headers');
        await event.context.audit.pending();
        return { ok: true };
      }),
    );
    await toWebHandler(app)(new Request('http://local/', { headers }));
    const context = track.mock.lastCall?.[0].context;
    expect(context?.requestId === 'req_from_client').toBe(optIn);
    expect(context?.operationId === 'op_from_client').toBe(optIn);
  }
  await client.shutdown();
});

it('forwards only the authorized query, keeps keys server-side and disables shared caching', async () => {
  const upstream: { url?: string; auth?: string } = {};
  const app = createApp();
  app.use(
    createReadHandler(
      {
        endpoint: 'http://logbird.test',
        readKey: 'lb_read_fake',
        fetch: async (input, options) => {
          upstream.url = String(input);
          upstream.auth = new Headers(options?.headers).get('Authorization') ?? undefined;
          return Response.json({ data: [], nextCursor: null, total: 0, tookMs: 0 });
        },
      },
      { authorize: () => ({ q: 'tenant:"authorized"' }) },
    ),
  );
  const response = await toWebHandler(app)(new Request('http://local/?q=tenant:other'));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(new URL(upstream.url ?? '').searchParams.get('q')).toBe('tenant:"authorized"');
  expect(upstream.auth).toBe('Bearer lb_read_fake');
  expect(await response.text()).not.toContain('tm_read');
});

it('answers an incomplete trail with an error and never reads upstream (#263)', async () => {
  let upstream = 0;
  const options = {
    endpoint: 'http://logbird.test',
    readKey: 'lb_read_fake',
    fetch: async () => {
      upstream++;
      return Response.json({ data: [{ id: 'everyone' }], nextCursor: null, total: 1, tookMs: 0 });
    },
  };
  const session: { tenantId?: string } = {};
  for (const authorize of [
    // The forgotten null check: trailQuery throws instead of widening.
    () => trailQuery({ tenant: session.tenantId }),
    // A hand-built query with no selector.
    () => ({ q: '' }),
    () => ({ q: '   ' }),
    () => ({ limit: 50 }),
  ]) {
    const app = createApp();
    app.use(createReadHandler(options, { authorize }));
    const response = await toWebHandler(app)(new Request('http://local/'));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('everyone');
  }
  expect(upstream).toBe(0);
});

it('sends exactly the validated query, even when authorize returns a getter or a non-enumerable q', async () => {
  const urls: string[] = [];
  const options = {
    endpoint: 'http://logbird.test',
    readKey: 'lb_read_fake',
    fetch: async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ data: [], nextCursor: null, total: 0, tookMs: 0 });
    },
  };
  class Trusted {
    limit = 20;
    get q() {
      return 'tenant:"acme"';
    }
  }
  const hidden = { limit: 20 };
  Object.defineProperty(hidden, 'q', { value: 'tenant:"acme"', enumerable: false });
  for (const authorize of [() => new Trusted(), () => hidden]) {
    const app = createApp();
    app.use(createReadHandler(options, { authorize }));
    expect((await toWebHandler(app)(new Request('http://local/'))).status).toBe(200);
  }
  expect(urls).toHaveLength(2);
  for (const url of urls) expect(new URL(url).searchParams.get('q')).toBe('tenant:"acme"');
});

it('refuses a trusted query with an unpaired surrogate before it is serialized', async () => {
  let upstream = 0;
  const app = createApp();
  app.use(
    createReadHandler(
      {
        endpoint: 'http://logbird.test',
        readKey: 'lb_read_fake',
        fetch: async () => {
          upstream++;
          return Response.json({ data: [], nextCursor: null, total: 0, tookMs: 0 });
        },
      },
      { authorize: () => ({ q: 'tenant:"acme\uD83D"' }) },
    ),
  );
  expect((await toWebHandler(app)(new Request('http://local/'))).status).toBe(400);
  expect(upstream).toBe(0);
});

it('refuses wrong-typed trusted fields with 400, forwards Dates and URL digits, and leaves the app own errors alone', async () => {
  const urls: string[] = [];
  const options = {
    endpoint: 'http://logbird.test',
    readKey: 'lb_read_fake',
    fetch: async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ data: [], nextCursor: null, total: 0, tookMs: 0 });
    },
  };
  const status = async (authorize: Parameters<typeof createReadHandler>[1]['authorize'], url = 'http://local/') => {
    const app = createApp();
    app.use(createReadHandler(options, { authorize }));
    return (await toWebHandler(app)(new Request(url))).status;
  };
  // A repeated browser parameter spread into the trusted query arrives as an array; objects are not strings either.
  expect(await status((_, query) => ({ ...query, q: query.q }) as never, 'http://local/?q=a&q=b')).toBe(400);
  expect(await status(() => ({ q: { toString: () => 'tenant:"acme"' } }) as never)).toBe(400);
  expect(await status(() => ({ q: 'tenant:"acme"', limit: { valueOf: () => 20 } }) as never)).toBe(400);
  expect(await status(() => ({ q: 'tenant:"acme"', order: 'sideways' }) as never)).toBe(400);
  expect(urls).toHaveLength(0);
  // A plain TypeError from the application's own code is not an incomplete trail: it stays a server error.
  expect(
    await status(() => {
      throw new TypeError('session.user is undefined');
    }),
  ).toBe(500);
  expect(urls).toHaveLength(0);
  const from = new Date('2026-11-01T00:00:00.000Z');
  expect(await status((_, query) => ({ q: 'tenant:"acme"', limit: query.limit, from }) as never, 'http://local/?limit=20')).toBe(200);
  const sent = new URL(urls[0] ?? '').searchParams;
  expect(Object.fromEntries(sent)).toEqual({ q: 'tenant:"acme"', from: '2026-11-01T00:00:00.000Z', limit: '20' });
});
