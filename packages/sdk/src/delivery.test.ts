import { afterEach, expect, it, vi } from 'vitest';
import { type EventInput, Logbird } from './index';
import { createAudit } from './integration';

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

it('resolves the earlier flush when a later event exhausts its retries', async () => {
  let reply!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          reply = done;
        }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 500 }));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ batchSize: 1 });
  sdk.track(event('first'));
  const first = expect(sdk.flush()).resolves.toBeUndefined();
  sdk.track(event('later'));
  const later = expect(sdk.flush()).rejects.toThrow('Logbird HTTP 500');
  reply(accepted('first'));
  await Promise.all([first, later]);
  expect(sdk.queueSize).toBe(1);
});

it('resolves a flush at its target while additional captures keep arriving', async () => {
  let reply!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          reply = done;
        }),
    )
    .mockImplementation(() => {
      sdk.track(event('arrived-during-send'));
      return new Promise<Response>(() => undefined);
    });
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ batchSize: 1, shutdownTimeoutMs: 0 });
  sdk.track(event('first'));
  const first = sdk.flush();
  sdk.track(event('later'));
  reply(accepted('first'));
  try {
    await first;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(sdk.queueSize).toBe(1);
  } finally {
    await sdk.shutdown().catch(() => undefined);
  }
}, 600);

it('keeps a later event out of the batch for an outstanding flush target', async () => {
  let reply!: (response: Response) => void;
  const requests: string[][] = [];
  const fetcher = vi.fn((_url: string, init: RequestInit) => {
    const ids = (JSON.parse(String(init.body)).events as { id: string }[]).map((item) => item.id);
    requests.push(ids);
    if (ids[0] === 'active')
      return new Promise<Response>((done) => {
        reply = done;
      });
    if (ids.includes('later')) return Promise.resolve(new Response(null, { status: 500 }));
    return Promise.resolve(accepted(...ids));
  });
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ batchSize: 2 });
  sdk.track(event('active'));
  const active = sdk.flush();
  sdk.track(event('target'));
  const covered = sdk.flush();
  sdk.track(event('later'));
  const later = expect(sdk.flush()).rejects.toThrow('Logbird HTTP 500');
  reply(accepted('active'));
  await Promise.all([active, covered, later]);
  expect(requests).toEqual([['active'], ['target'], ['later']]);
});

it('waits at shutdown for events captured beyond an earlier flush target', async () => {
  let firstReply!: (response: Response) => void;
  let laterReply!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          firstReply = done;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          laterReply = done;
        }),
    );
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ batchSize: 1 });
  sdk.track(event('first'));
  const firstDone = vi.fn();
  const first = sdk.flush().then(firstDone);
  sdk.track(event('later'));
  const closed = vi.fn();
  const closing = sdk.shutdown().then(closed);
  firstReply(accepted('first'));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const flushedBeforeShutdown = firstDone.mock.calls.length === 1 && closed.mock.calls.length === 0;
  laterReply(accepted('later'));
  await Promise.all([first, closing]);
  expect(flushedBeforeShutdown).toBe(true);
  expect(closed).toHaveBeenCalledOnce();
});

it('settles a flush started during shutdown independently of pending capture preparation', async () => {
  vi.useFakeTimers();
  let reply!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((done) => {
        reply = done;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn();
  const sdk = client({ batchSize: 1, shutdownTimeoutMs: 25, onDrop });
  sdk.track(event('already-sending'));
  const audit = await createAudit({ client: sdk, actor: () => new Promise<undefined>(() => undefined) }, {}, new Request('http://example.invalid'));
  const preparingId = audit('preparing');
  const closing = sdk.shutdown();
  const settlements = Promise.allSettled([sdk.flush(), closing]);
  reply(accepted('already-sending'));
  await vi.advanceTimersByTimeAsync(25);
  const [flushing, stopped] = await settlements;
  expect(flushing).toEqual({ status: 'fulfilled', value: undefined });
  expect(stopped).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
  expect(onDrop).toHaveBeenCalledWith({ id: preparingId, action: 'preparing' }, { reason: 'shutdown', mayBeStored: false });
  expect(fetcher).toHaveBeenCalledOnce();
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

it('retains both different occurrences after an incomplete 503 credit for a shared id', async () => {
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
  const sdk = client({ maxRetries: 1 });
  sdk.track(event('same'));
  sdk.track({ ...event('same'), description: 'different' });
  const failed = expect(sdk.flush()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  await failed;
  expect(fetcher.mock.calls[0]?.[1].body).toBe(fetcher.mock.calls[1]?.[1].body);
  expect(sdk.queueSize).toBe(2);
});

it('uses explicit pending indices to resolve which of two shared-ID occurrences to retry', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 'ingest_pending',
            details: { accepted: 1, ids: ['same'], rejected: [], indices: [0], eventIds: ['same'], warnings: [] },
          },
        },
        { status: 503, headers: { 'Retry-After': '0' } },
      ),
    )
    .mockResolvedValueOnce(accepted('same'));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client();
  sdk.track({ ...event('same'), description: 'pending' });
  sdk.track({ ...event('same'), description: 'accepted' });
  const flushing = sdk.flush();
  await vi.advanceTimersByTimeAsync(0);
  await flushing;
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).events.map((item: EventInput) => item.description)).toEqual(['pending']);
});

it('clears lost-answer uncertainty when the server definitively rejects the content', async () => {
  const onDrop = vi.fn();
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValueOnce(
      Response.json({
        accepted: 0,
        ids: [],
        rejected: [{ index: 0, code: 'duplicate_id_conflict', reason: 'fixture' }],
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ onDrop });
  sdk.track(event('conflict'));
  await expect(sdk.flush()).rejects.toThrow();
  await sdk.flush();
  expect(onDrop).toHaveBeenCalledWith(expect.anything(), {
    reason: 'rejected',
    code: 'duplicate_id_conflict',
    mayBeStored: false,
  });
});

it('keeps prior delivery uncertainty when a retry returns an unknown rejection code', async () => {
  const onDrop = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost after storage'))
      .mockResolvedValueOnce(Response.json({ accepted: 0, ids: [], rejected: [{ index: 0, code: 'future_code', reason: 'fixture' }] })),
  );
  const sdk = client({ onDrop });
  sdk.track(event('uncertain'));
  await expect(sdk.flush()).rejects.toThrow();
  await sdk.flush();
  expect(onDrop).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'rejected', mayBeStored: true }));
  expect(sdk.possiblyStoredDropsByReason.rejected).toBe(1);
});

it('accounts for an indexed rejection even when the 202 accepted count is malformed', async () => {
  const onDrop = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        accepted: 2,
        ids: ['pending'],
        rejected: [{ index: 1, code: 'invalid_event', reason: 'fixture' }],
      }),
    ),
  );
  const sdk = client({ onDrop });
  sdk.track(event('pending'));
  sdk.track(event('rejected'));
  await expect(sdk.flush()).rejects.toThrow();
  expect(sdk.queueSize).toBe(1);
  expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: 'rejected' }), {
    reason: 'rejected',
    code: 'invalid_event',
    mayBeStored: false,
  });
});

it('matches retry acknowledgements against the IDs stored with the wire bytes', async () => {
  vi.useFakeTimers();
  const rejection = { index: 1, cost: 0, reason: 'fixture', code: 'invalid_event' };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'ingest_pending', details: { rejected: [rejection] } } }, { status: 503, headers: { 'Retry-After': '0' } }),
    )
    .mockResolvedValueOnce(Response.json({ accepted: 1, ids: ['accepted'], rejected: [rejection] }, { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({
    maxRetries: 1,
    onDrop: (dropped) => {
      Object.assign(dropped, { id: 12 });
    },
  });
  sdk.track(event('accepted'));
  sdk.track(event('rejected'));
  const done = sdk.flush();
  await vi.advanceTimersByTimeAsync(0);
  await done;
  expect(sdk.queueSize).toBe(0);
  expect(sdk.droppedByReason.rejected).toBe(1);
});

it('mints fresh direct-track ids when a hook removes a supplied id', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const ids = (JSON.parse(String(init.body)).events as EventInput[]).flatMap((item) => item.id ?? []);
    return accepted(...ids);
  });
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ beforeSend: ({ action }) => ({ action }) });
  sdk.track(event('upstream'));
  sdk.track(event('upstream'));
  await sdk.shutdown();
  const ids = (JSON.parse(String(fetcher.mock.calls[0]?.[1].body)).events as EventInput[]).map((item) => item.id);
  expect(new Set(ids).size).toBe(2);
  expect(ids).not.toContain('upstream');
});

it('validates the same hook id value it uses for post-redaction repair', async () => {
  const calls = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)).events[0];
      calls(sent);
      return accepted(sent.id);
    }),
  );
  let reads = 0;
  const sdk = client({
    beforeSend: (value) => ({
      ...value,
      get id() {
        reads++;
        return reads < 3 ? 'validated' : ({ payload: 'fictional' } as unknown as string);
      },
      toJSON: () => ({ action: 'test.audit' }),
    }),
  });
  sdk.track(event('original'));
  await sdk.shutdown();
  expect(calls).toHaveBeenCalledWith({ action: 'test.audit', id: 'validated' });
});

it('shuts down queued events even when the original options object is changed', async () => {
  const fetcher = vi.fn(async () => accepted('queued'));
  vi.stubGlobal('fetch', fetcher);
  const options = { apiKey: 'fictional', endpoint: 'http://example.invalid', enabled: true };
  const sdk = new Logbird(options);
  sdk.track(event('queued'));
  options.enabled = false;
  await sdk.shutdown();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(sdk.queueSize).toBe(0);
});

it('reads supported prototype options once and preserves inherited filters and enabled state', async () => {
  const onKeyRead = vi.fn();
  const beforeSend = vi.fn((value: EventInput) => (value.id === 'filtered' ? null : value));
  class Options {
    endpoint = 'http://example.invalid';
    get apiKey() {
      onKeyRead();
      return 'fictional';
    }
    get beforeSend() {
      return beforeSend;
    }
  }
  class DisabledOptions extends Options {
    get enabled() {
      return false;
    }
  }
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => accepted('kept'));
  vi.stubGlobal('fetch', fetcher);
  const sdk = new Logbird(new Options());
  sdk.track(event('filtered'));
  sdk.track(event('kept'));
  await sdk.shutdown();
  expect(onKeyRead).toHaveBeenCalledOnce();
  expect(beforeSend).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1].headers).toMatchObject({ Authorization: 'Bearer fictional' });
  const disabled = new Logbird(new DisabledOptions());
  disabled.track(event('never-sent'));
  await disabled.shutdown();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('counts closed, hook, serialization and size refusals and filters individually', async () => {
  const onDrop = vi.fn();
  const sdk = client({
    redaction: false,
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
  expect(onDrop).toHaveBeenCalledTimes(1);
  expect(sdk.failedNotifications).toBe(1);
  expect(sdk.droppedByReason.diagnostic_reentry).toBe(1);
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

it('counts storage uncertainty even when shutdown notifications are skipped', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
  const sdk = client({
    batchSize: 2,
    shutdownTimeoutMs: 25,
    beforeSend: (item) => (item.action === 'filter' ? null : item),
    onDrop: () => new Promise<void>(() => undefined),
  });
  for (let index = 0; index < 1024; index++) sdk.track({ action: 'filter' });
  sdk.track(event('sending-a'));
  sdk.track(event('sending-b'));
  sdk.track(event('waiting'));
  const failure = expect(sdk.shutdown()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(25);
  await failure;
  expect(sdk.droppedByReason.shutdown).toBe(3);
  expect(sdk.possiblyStoredDropsByReason.shutdown).toBe(2);
  expect(sdk.skippedNotifications).toBe(3);
});

it('caps abandoned requests when a transport ignores cancellation', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client();
  sdk.track(event('retained'));
  for (let attempt = 0; attempt < 5; attempt++) {
    const failure = expect(sdk.flush()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
  }
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(sdk.queueSize).toBe(1);
});

it.each([429, 502])('cancels open HTTP %i bodies and holds the request slots until cleanup settles', async (status) => {
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status }));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client();
  sdk.track(event('retained'));
  for (let attempt = 0; attempt < 5; attempt++) await expect(sdk.flush()).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(cancel).toHaveBeenCalledTimes(4);
  expect(sdk.queueSize).toBe(1);
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

it('checks the monotonic shutdown deadline before dispatching a queued tail', async () => {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  let reply!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((done) => {
        reply = done;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ batchSize: 1, shutdownTimeoutMs: 10 });
  sdk.track(event('active'));
  sdk.track(event('tail'));
  const closing = expect(sdk.shutdown()).rejects.toThrow();
  clock = 11;
  reply(accepted('active'));
  await closing;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(sdk.droppedByReason.shutdown).toBe(1);
  expect(sdk.possiblyStoredDropsByReason.shutdown).toBeUndefined();
});

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
