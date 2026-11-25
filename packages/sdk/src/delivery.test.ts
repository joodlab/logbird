import { afterEach, expect, it, vi } from 'vitest';
import { type EventInput, Logbird } from './index';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const client = (options: Partial<ConstructorParameters<typeof Logbird>[0]> = {}) =>
  new Logbird({ apiKey: 'fictional', endpoint: 'http://example.invalid', maxRetries: 0, ...options });
const event = (id: string) => ({ action: 'test.audit', id });
const accepted = (...ids: string[]) => Response.json({ accepted: ids.length, ids, rejected: [], warnings: [] }, { status: 202 });

it('flushes an event queued between two flush calls after an empty drain', async () => {
  const fetcher = vi.fn(async () => accepted('queued'));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ batchSize: 1 });
  const empty = sdk.flush();
  sdk.track(event('queued'));
  await sdk.flush();
  await empty;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(sdk.queueSize).toBe(0);
});

it('retains an event when HTTP 200 lacks an acknowledgement envelope', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({})),
  );
  const sdk = client();
  sdk.track(event('lost'));
  await expect(sdk.flush()).rejects.toThrow();
  expect(sdk.queueSize).toBe(1);
  expect(sdk.dropped).toBe(0);
});

it('credits one occurrence of an accepted id in a 503 even when two entries share it', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'ingest_pending', details: { accepted: 1, ids: ['same'], rejected: [], indices: [], eventIds: [], warnings: [] } } },
        { status: 503, headers: { 'Retry-After': '0' } },
      ),
    )
    .mockImplementation(async () => new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client();
  sdk.track(event('same'));
  sdk.track(event('same'));
  const failed = expect(sdk.flush()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  await failed;
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).events).toHaveLength(1);
  expect(sdk.queueSize).toBe(1);
});

it('counts closed, hook, serialization and size refusals and filters individually', async () => {
  const onDrop = vi.fn();
  const sdk = client({
    beforeSend: (value) => {
      if (value.id === 'hook') throw new Error('fixture');
      return value.id === 'filter' ? null : value;
    },
    onDrop,
  });
  const cycle: EventInput = event('cycle');
  cycle.ref = cycle;
  sdk.track(event('hook'));
  sdk.track(event('filter'));
  sdk.track(cycle);
  sdk.track({ ...event('large'), description: 'a'.repeat(256 * 1024) });
  await sdk.shutdown();
  sdk.track(event('closed'));
  await Promise.resolve();
  expect(sdk.dropped).toBe(5);
  expect(sdk.droppedByReason).toEqual({ before_send_failed: 1, filtered: 1, invalid: 1, too_large: 1, shutdown: 1 });
  expect(onDrop.mock.calls.map(([value, details]) => [value.id, details.reason, details.mayBeStored])).toEqual([
    ['hook', 'before_send_failed', false],
    ['filter', 'filtered', false],
    ['cycle', 'invalid', false],
    ['large', 'too_large', false],
    ['closed', 'shutdown', false],
  ]);
});

it('distinguishes eviction after a lost response from eviction before dispatch', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('lost')));
  const onDrop = vi.fn();
  const sdk = client({ maxQueueSize: 1, onDrop });
  sdk.track(event('sent'));
  await expect(sdk.flush()).rejects.toThrow();
  sdk.track(event('waiting'));
  sdk.track(event('latest'));
  await Promise.resolve();
  expect(onDrop.mock.calls.map(([value, details]) => [value.id, details.mayBeStored])).toEqual([
    ['sent', true],
    ['waiting', false],
  ]);
});

it('runs drop hooks after queue mutation and observes rejected hook promises', async () => {
  const onDrop = vi.fn(async () => {
    if (onDrop.mock.calls.length === 1) sdk.track(event('reentrant'));
    throw new Error('fixture');
  });
  const sdk = client({ maxQueueSize: 1, onDrop });
  sdk.track(event('first'));
  sdk.track(event('second'));
  expect(onDrop).not.toHaveBeenCalled();
  for (let step = 0; step < 5; step++) await Promise.resolve();
  expect(sdk.queueSize).toBe(1);
  expect(sdk.dropped).toBe(2);
  expect(onDrop).toHaveBeenCalledTimes(2);
  expect(sdk.failedNotifications).toBe(2);
});

it('counts every refusal when the diagnostic backlog fills', async () => {
  const onDrop = vi.fn(() => new Promise<void>(() => undefined));
  const sdk = client({ beforeSend: () => null, onDrop });
  for (let index = 0; index < 1025; index++) sdk.track(event(String(index)));
  await sdk.shutdown();
  expect(sdk.droppedByReason.filtered).toBe(1025);
  expect(sdk.skippedNotifications).toBe(1);
  expect(onDrop).toHaveBeenCalledTimes(1024);
});

it('refuses a beforeSend promise and observes its rejection', async () => {
  const beforeSend = (async () => {
    throw new Error('fixture');
  }) as unknown as (input: EventInput) => EventInput;
  const sdk = client({ beforeSend });
  sdk.track(event('async'));
  await sdk.shutdown();
  expect(sdk.droppedByReason.before_send_failed).toBe(1);
});

it('uses one shutdown budget for an active request and the queued tail', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn();
  const sdk = client({ batchSize: 1, shutdownTimeoutMs: 25, onDrop });
  sdk.track(event('in-flight'));
  await Promise.resolve();
  sdk.track(event('waiting'));
  const failed = expect(sdk.shutdown()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(25);
  await failed;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(sdk.queueSize).toBe(0);
  expect(onDrop.mock.calls.map(([value, details]) => [value.id, details.reason, details.mayBeStored])).toEqual([
    ['in-flight', 'shutdown', true],
    ['waiting', 'shutdown', false],
  ]);
}, 500);

it('unrefs background backoff and refs it when an explicit flush joins', async () => {
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const fetcher = vi.fn(async () => new Response(null, { status: 503, headers: { 'Retry-After': '60' } }));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ batchSize: 1, maxRetries: 1, shutdownTimeoutMs: 0 });
  sdk.track(event('background'));
  try {
    for (let step = 0; step < 20; step++) await Promise.resolve();
    const index = timer.mock.calls.findIndex(([, milliseconds]) => milliseconds === 60_000);
    const retry = timer.mock.results[index]?.value;
    expect(retry?.hasRef()).toBe(false);
    const waiting = sdk.flush().catch(() => undefined);
    expect(retry.hasRef()).toBe(true);
    await expect(sdk.shutdown()).rejects.toThrow();
    await waiting;
  } finally {
    for (const result of timer.mock.results) clearTimeout(result.value);
  }
});
