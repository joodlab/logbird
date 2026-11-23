import { Logbird } from '@logbird/sdk';
import { expect, it, vi } from 'vitest';
import { logbird, readAuditTrail, trailQuery } from './index';

it('runs the framework request middleware and passes typed audit through next', async () => {
  const client = new Logbird({ endpoint: 'http://unused', apiKey: 'fake' });
  const track = vi.spyOn(client, 'track').mockImplementation(() => undefined);
  const integration = logbird({ client, actor: () => ({ id: 'actor' }), tenant: () => ({ id: 'tenant' }) });
  const handler = integration.requestMiddleware.options.server;
  if (!handler) throw new Error('missing middleware');
  const next = vi.fn(async ({ context }) => {
    context.audit('record.updated');
    return { context };
  });
  await handler({ request: new Request('http://local'), pathname: '/', context: {}, handlerType: 'router', next } as unknown as Parameters<
    typeof handler
  >[0]);
  await integration.shutdown();
  expect(track.mock.calls[0]?.[0].actor?.id).toBe('actor');
});

it('answers an incomplete trail with an error and sends no request (#263)', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ data: [{ id: 'everyone' }], nextCursor: null, total: 1, tookMs: 0 }),
  );
  const options = { endpoint: 'http://logbird.test', readKey: 'lb_read_fake', fetch };
  const session: { tenantId?: string } = {};
  // The README's helper call, with the tenant id missing: it throws before reading.
  await expect(async () => readAuditTrail(options, trailQuery({ target: { type: 'record', id: 'r1' }, tenant: session.tenantId }))).rejects.toThrow(
    TypeError,
  );
  await expect(async () => readAuditTrail(options, trailQuery({}))).rejects.toThrow(/an empty trail would be the whole project/);
  expect(fetch).not.toHaveBeenCalled();
  // A complete trail reads normally.
  await readAuditTrail(options, trailQuery({ target: { type: 'record', id: 'r1' }, tenant: 't1' }));
  expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('q')).toBe('record:"record:r1" AND tenant:"t1"');
});
