import { afterEach, expect, it, vi } from 'vitest';
import { Trailmark } from './index';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('batches and retries the identical body with UUIDv7 ids', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 429 }))
    .mockResolvedValueOnce(new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const sdk = new Trailmark({ apiKey: 'fake', endpoint: 'http://test', batchSize: 2 });
  sdk.track({ action: 'x' });
  sdk.track({ action: 'y' });
  await vi.runAllTimersAsync();
  await sdk.shutdown();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1].body).toBe(fetch.mock.calls[1]?.[1].body);
  const body = JSON.parse(fetch.mock.calls[0]?.[1].body);
  expect(body.events[0].id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7/);
});
it('never throws from track even if onError throws', async () => {
  const sdk = new Trailmark({
    apiKey: 'fake',
    endpoint: 'http://test',
    onError: () => {
      throw new Error('hook');
    },
  });
  await sdk.shutdown();
  expect(() => sdk.track({ action: 'x' })).not.toThrow();
});
it('retains a failed batch for an explicit retry', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const sdk = new Trailmark({ apiKey: 'fake', endpoint: 'http://test', maxRetries: 0 });
  sdk.track({ action: 'x', id: 'supplied' });
  await expect(sdk.flush()).rejects.toThrow('offline');
  await sdk.shutdown();
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body).events[0].id).toBe('supplied');
});
it('does not retry permanent errors', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  const sdk = new Trailmark({ apiKey: 'fake', endpoint: 'http://test' });
  sdk.track({ action: 'x' });
  await sdk.shutdown();
  expect(sdk.dropped).toBe(1);
  expect(sdk.queueSize).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['oldest', 'newest'] as const)('bounds queued and retried events with %s policy and throwing drop hooks', async (dropPolicy) => {
  let reject!: (error: Error) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockImplementation(async () => new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  const drops: string[] = [];
  const sdk = new Trailmark({
    apiKey: 'fake',
    endpoint: 'http://test',
    batchSize: 2,
    maxQueueSize: 3,
    maxRetries: 0,
    dropPolicy,
    onDrop: (event) => {
      drops.push(event.action);
      throw new Error('hook');
    },
  });
  for (let i = 0; i < 10; i++) expect(() => sdk.track({ action: String(i) })).not.toThrow();
  expect(sdk.queueSize).toBe(3);
  expect(sdk.dropped).toBe(5);
  const pending = sdk.flush();
  reject(new Error('offline'));
  await expect(pending).rejects.toThrow('offline');
  expect(sdk.queueSize).toBe(3);
  expect(sdk.dropped).toBe(7);
  expect(drops).toHaveLength(7);
  await sdk.shutdown();
  const delivered = fetcher.mock.calls.slice(1).flatMap((call) => JSON.parse(call[1].body).events.map((e: { action: string }) => e.action));
  expect(delivered).toEqual(dropPolicy === 'oldest' ? ['7', '8', '9'] : ['0', '1', '2']);
});

it('drops partial rejections and permanent poison batches without wedging later events', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ rejected: [{ index: 0, reason: 'bad timestamp' }] }), { status: 202 }))
    .mockResolvedValueOnce(new Response('{}', { status: 422 }))
    .mockResolvedValueOnce(new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn(),
    onError = vi.fn();
  const sdk = new Trailmark({ apiKey: 'fake', endpoint: 'http://test', onDrop, onError });
  sdk.track({ action: 'poison' });
  sdk.track({ action: 'good' });
  await sdk.flush();
  expect(onDrop.mock.calls.map(([e]) => e.action)).toEqual(['poison']);
  sdk.track({ action: 'permanent' });
  await sdk.flush();
  sdk.track({ action: 'later' });
  await sdk.shutdown();
  expect(sdk.queueSize).toBe(0);
  expect(sdk.dropped).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenCalledTimes(2);
});
