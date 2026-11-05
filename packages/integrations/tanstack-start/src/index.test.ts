import { Trailmark } from '@trailmark/sdk';
import { expect, it, vi } from 'vitest';
import { trailmark } from './index';

it('runs the framework request middleware and passes typed audit through next', async () => {
  const client = new Trailmark({ endpoint: 'http://unused', apiKey: 'fake' });
  const track = vi.spyOn(client, 'track').mockImplementation(() => undefined);
  const integration = trailmark({ client, actor: () => ({ id: 'actor' }), tenant: () => ({ id: 'tenant' }) });
  const handler = integration.requestMiddleware.options.server;
  if (!handler) throw new Error('missing middleware');
  const next = vi.fn(async ({ context }) => {
    context.audit('record.updated');
    return { context };
  });
  await handler({ request: new Request('http://local'), pathname: '/', context: {}, handlerType: 'router', next } as unknown as Parameters<
    typeof handler
  >[0]);
  expect(track.mock.calls[0]?.[0].actor?.id).toBe('actor');
  await integration.shutdown();
});
