import { afterEach, expect, it, vi } from 'vitest';
import { Logbird } from './index';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('retries ingest_pending 503 after Retry-After with identical ids and body', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'ingest_pending' } }), { status: 503, headers: { 'Retry-After': '1' } }))
    .mockResolvedValueOnce(new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const sdk = new Logbird({ apiKey: 'fake', endpoint: 'http://test' });
  sdk.track({ action: 'retry.pending', id: 'immutable' });
  const flushed = sdk.flush();
  await vi.advanceTimersByTimeAsync(999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await flushed;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1].body).toBe(fetch.mock.calls[1]?.[1].body);
  expect(sdk.dropped).toBe(0);
  await sdk.shutdown();
});
it('batches and retries the identical body with UUIDv7 ids', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 429 }))
    .mockResolvedValueOnce(new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const sdk = new Logbird({ apiKey: 'fake', endpoint: 'http://test', batchSize: 2 });
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
  const sdk = new Logbird({
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
  const sdk = new Logbird({ apiKey: 'fake', endpoint: 'http://test', maxRetries: 0 });
  sdk.track({ action: 'x', id: 'supplied' });
  await expect(sdk.flush()).rejects.toThrow('offline');
  await sdk.shutdown();
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body).events[0].id).toBe('supplied');
});
it('does not retry permanent errors', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  const sdk = new Logbird({ apiKey: 'fake', endpoint: 'http://test' });
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
  const sdk = new Logbird({
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
  const sdk = new Logbird({ apiKey: 'fake', endpoint: 'http://test', onDrop, onError });
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

it.each([
  ['2', 2000],
  ['999', 60_000],
])('honours bounded Retry-After %s on 429', async (header, delay) => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': header } }))
    .mockResolvedValue(new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const sdk = new Logbird({ apiKey: 'fake', endpoint: 'http://test' });
  sdk.track({ action: 'retry.fixture' });
  const flushed = sdk.flush();
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await flushed;
  expect(fetch).toHaveBeenCalledTimes(2);
  await sdk.shutdown();
});
it('disables capture without credentials and validates enabled credentials', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const sdk = new Logbird({ enabled: false });
  sdk.track({ action: 'ignored' });
  await sdk.flush();
  await sdk.shutdown();
  expect(sdk.queueSize).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
  expect(() => new Logbird({})).toThrow('required');
});
it('merges defaults one level deep before stamping and applying hooks', async () => {
  const hook = vi.fn((event) => event);
  const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  const sdk = new Logbird({
    apiKey: 'fake',
    endpoint: 'http://test',
    defaults: { environment: 'staging', metadata: { keep: true, nested: { old: true } }, context: { requestId: 'default', operationId: 'op' } },
    beforeSend: hook,
  });
  sdk.track({ action: 'x', environment: 'preview', metadata: { nested: { fresh: true } }, context: { requestId: 'host' } });
  await sdk.shutdown();
  expect(hook.mock.calls[0]?.[0]).toMatchObject({
    id: expect.any(String),
    occurredAt: expect.any(String),
    environment: 'preview',
    metadata: { keep: true, nested: { fresh: true } },
    context: { requestId: 'host', operationId: 'op' },
  });
  expect(hook.mock.calls[0]?.[0].metadata.nested).toEqual({ fresh: true });
});
it.each(['null', 'undefined', 'throw'])('filters %s without overflow diagnostics', async (mode) => {
  const onError = vi.fn(),
    onDrop = vi.fn();
  const sdk = new Logbird({
    apiKey: 'fake',
    endpoint: 'http://test',
    onError,
    onDrop,
    beforeSend: () => {
      if (mode === 'throw') throw new Error('closed');
      return mode === 'null' ? null : undefined;
    },
  });
  sdk.track({ action: 'secret' });
  await sdk.shutdown();
  expect(sdk.queueSize).toBe(0);
  expect(sdk.dropped).toBe(0);
  expect(onDrop).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(mode === 'throw' ? 1 : 0);
});

it('surfaces duplicate_id_conflict guidance and drops only the conflicting index', async () => {
  const onError = vi.fn(),
    onDrop = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: 1,
          ids: ['healthy'],
          rejected: [{ index: 0, code: 'duplicate_id_conflict', reason: 'duplicate_id_conflict: original is kept; send a correction with a new id' }],
        }),
        { status: 202 },
      ),
    ),
  );
  const sdk = new Logbird({ apiKey: 'fake', endpoint: 'http://test', onError, onDrop });
  sdk.track({ id: 'conflict', action: 'different' });
  sdk.track({ id: 'healthy', action: 'original' });
  await sdk.shutdown();
  expect(onDrop.mock.calls.map(([event]) => event.id)).toEqual(['conflict']);
  expect(onError.mock.calls[0]?.[0].message).toContain('duplicate_id_conflict: original is kept');
  expect(sdk.queueSize).toBe(0);
});
