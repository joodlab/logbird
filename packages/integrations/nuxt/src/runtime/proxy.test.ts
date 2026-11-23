import { Logbird } from '@logbird/sdk';
import { trailQuery } from '@logbird/sdk/read';
import { createApp, eventHandler, toWebHandler } from 'h3';
import { expect, it } from 'vitest';
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
