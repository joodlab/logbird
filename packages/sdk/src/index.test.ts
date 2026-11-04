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
  await expect(sdk.shutdown()).rejects.toThrow('401');
  expect(fetch).toHaveBeenCalledTimes(1);
});
