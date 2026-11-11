import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { Logbird } from './index';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const settledResponse = (code = 'ingest_pending') =>
  new Response(
    JSON.stringify({
      error: {
        code,
        details: {
          accepted: 1,
          ids: ['qa91-accepted'],
          rejected: [{ index: 1, reason: 'invalid_event: bad Unicode' }],
          indices: [0],
          eventIds: ['qa91-unresolved'],
          warnings: [],
        },
      },
    }),
    { status: 503, headers: { 'Retry-After': '0' } },
  );

it.each([null, {}, 'invalid', [null, false, 'invalid', {}, { index: 0.5 }, { index: '0' }, { index: 99 }]])(
  'retries a 503 with malformed rejection details %j instead of throwing',
  async (rejected) => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'ingest_pending', details: { rejected } } }), {
          status: 503,
          headers: { 'Retry-After': '1' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const onDrop = vi.fn();
    const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxRetries: 1, onDrop });
    sdk.track({ id: 'healthy', action: 'qa91.sdk' });
    const flushing = sdk.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flushing;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1].body).toBe(fetcher.mock.calls[1]?.[1].body);
    expect(onDrop).not.toHaveBeenCalled();
    expect(sdk.queueSize).toBe(0);
    await sdk.shutdown();
  },
);
it('skips malformed rejection entries while settling valid indices once', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'ingest_unavailable', details: { rejected: [null, {}, { index: 1, reason: 'invalid_event' }] } } }),
          { status: 503, headers: { 'Retry-After': '0' } },
        ),
    );
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn();
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxRetries: 1, onDrop });
  sdk.track({ id: 'healthy', action: 'qa91.sdk' });
  sdk.track({ id: 'bad', action: 'qa91.sdk' });
  const failed = expect(sdk.flush()).rejects.toThrow('Logbird HTTP 503');
  await vi.advanceTimersByTimeAsync(0);
  await failed;
  expect(onDrop.mock.calls.map(([event]) => event.id)).toEqual(['bad']);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1].body).toBe(fetcher.mock.calls[1]?.[1].body);
  expect(sdk.queueSize).toBe(1);
  fetcher.mockImplementation(async () => new Response('{}', { status: 202 }));
  await sdk.shutdown();
});
it('settles accepted ids using the same trimming as the server', async () => {
  const fetcher = vi.fn().mockImplementation(async () => settledResponse());
  vi.stubGlobal('fetch', fetcher);
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxRetries: 0 });
  for (const id of ['qa91-unresolved', 'qa91-bad', ' \tqa91-accepted\n']) sdk.track({ id, action: 'qa91.sdk' });
  await expect(sdk.flush()).rejects.toThrow('Logbird HTTP 503');
  expect(sdk.queueSize).toBe(1);
  expect(sdk.dropped).toBe(1);
  fetcher.mockImplementation(async () => new Response('{}', { status: 202 }));
  await sdk.shutdown();
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).events.map((event: { id: string }) => event.id)).toEqual(['qa91-unresolved']);
});

it('converges inside one send with 80 leading bad rows, default maxRetries and cached byte-identical events', async () => {
  vi.useFakeTimers();
  const bodies: string[] = [];
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const headers = new Headers(init.headers);
    expect(headers.get('Logbird-Retry')).toBe('subset');
    expect(headers.get('X-Logbird-SDK')).toBe(`typescript/${version}`);
    const events = JSON.parse(String(init.body)).events as { id: string }[];
    const rejected = events.flatMap((event, index) => (event.id.startsWith('bad-') && index < 2 ? [{ index, reason: event.id }] : []));
    if (!rejected.length) return new Response('{}', { status: 202 });
    const indices = events.map((_, index) => index).filter((index) => !rejected.some((r) => r.index === index));
    return new Response(
      JSON.stringify({
        error: {
          code: 'ingest_pending',
          details: { accepted: 0, ids: [], rejected, warnings: [], indices, eventIds: indices.map((index) => events[index]!.id) },
        },
      }),
      { status: 503, headers: { 'Retry-After': '0' } },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn(),
    onError = vi.fn();
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', onDrop, onError });
  const events = Array.from({ length: 82 }, (_, index) => ({
    id: index < 80 ? `bad-${index}` : `healthy-${index}`,
    action: 'qa91.sdk',
    occurredAt: '2026-11-11T00:00:00.000Z',
    metadata: { text: 'quoted "Unicode €"\n', index },
    context: {},
  }));
  const serialized = events.map((event) => JSON.stringify(event));
  for (const event of events) sdk.track(event);
  const stringify = vi.spyOn(JSON, 'stringify');
  const flushing = sdk.flush();
  await vi.advanceTimersByTimeAsync(100);
  await flushing;
  // One size check in flush, then one cached serialization in send; retries never serialize an event again.
  for (const event of events)
    expect(stringify.mock.calls.filter(([value]) => value && typeof value === 'object' && 'id' in value && value.id === event.id)).toHaveLength(2);
  stringify.mockRestore();
  expect(bodies).toEqual(Array.from({ length: 41 }, (_, attempt) => `{"events":[${serialized.slice(attempt * 2).join(',')}]}`));
  expect(onDrop.mock.calls.map(([event]) => event.id)).toEqual(events.slice(0, 80).map((event) => event.id));
  expect(onError.mock.calls.map(([error]) => error.message)).toEqual(
    Array.from({ length: 40 }, (_, attempt) => `2 events rejected by Logbird: bad-${attempt * 2}; bad-${attempt * 2 + 1}`),
  );
  expect(sdk.dropped).toBe(80);
  expect(sdk.queueSize).toBe(0);
  await sdk.shutdown();
});

it('limits non-progress failures to the default retry budget', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => new Response('', { status: 503, headers: { 'Retry-After': '0' } }));
  vi.stubGlobal('fetch', fetcher);
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid' });
  sdk.track({ id: 'unsettled', action: 'qa91.sdk' });
  const failed = expect(sdk.flush()).rejects.toThrow('Logbird HTTP 503');
  await vi.advanceTimersByTimeAsync(100);
  await failed;
  expect(fetcher).toHaveBeenCalledTimes(6); // Initial request plus the default five retries.
  expect(sdk.queueSize).toBe(1);
  expect(sdk.dropped).toBe(0);
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 202 }));
  await sdk.shutdown();
});

it('remaps mixed accepted/rejected indices across three subsets and requeues only the original unsettled event', async () => {
  vi.useFakeTimers();
  const expectedBodies = [
    ['bad-a', 'good-a', 'bad-b', 'good-b', 'bad-c', 'good-c', 'later'],
    ['bad-a', 'good-b', 'bad-c', 'good-c', 'later'],
    ['bad-a', 'good-c', 'later'],
    ['later'],
  ];
  const bodies: string[][] = [];
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const ids = (JSON.parse(String(init.body)).events as { id: string }[]).map((event) => event.id);
    const attempt = bodies.length;
    bodies.push(ids);
    if (attempt >= 4) return new Response('{}', { status: 202 });
    const rejected = attempt < 3 ? [{ index: attempt === 2 ? 0 : 2, reason: ['bad-b', 'bad-c', 'bad-a'][attempt] }] : [];
    const accepted = attempt < 3 ? [ids[1]] : [];
    const indices = ids.map((_, index) => index).filter((index) => !rejected.some((r) => r.index === index) && !accepted.includes(ids[index]));
    return new Response(
      JSON.stringify({
        error: {
          code: attempt % 2 ? 'ingest_unavailable' : 'ingest_pending',
          details: { accepted: accepted.length, ids: accepted, rejected, warnings: [], indices, eventIds: indices.map((index) => ids[index]) },
        },
      }),
      { status: 503, headers: { 'Retry-After': '0' } },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn(),
    onError = vi.fn();
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxRetries: 0, onDrop, onError });
  for (const id of expectedBodies[0]!) sdk.track({ id, action: 'qa91.sdk' });
  const failed = expect(sdk.flush()).rejects.toThrow('Logbird HTTP 503');
  await vi.advanceTimersByTimeAsync(100);
  await failed;
  expect(bodies).toEqual(expectedBodies);
  expect(onDrop.mock.calls.map(([event]) => event.id)).toEqual(['bad-b', 'bad-c', 'bad-a']);
  expect(onError.mock.calls.map(([error]) => error.message)).toEqual([
    '1 events rejected by Logbird: bad-b',
    '1 events rejected by Logbird: bad-c',
    '1 events rejected by Logbird: bad-a',
  ]);
  expect(sdk.dropped).toBe(3);
  expect(sdk.queueSize).toBe(1);
  await sdk.shutdown();
  expect(bodies[4]).toEqual(['later']);
  expect(onDrop).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenCalledTimes(3);
});

it.each(['missing warnings', 'invalid accepted', 'invalid index', 'invalid rejection', 'unaccounted position'])(
  '%s keeps the previous subset body unchanged',
  async (malformation) => {
    vi.useFakeTimers();
    const details = {
      accepted: malformation === 'invalid accepted' ? 2 : 1,
      ids: malformation === 'unaccounted position' ? ['unknown'] : ['qa91-unresolved'],
      rejected: malformation === 'invalid rejection' ? [null] : [],
      indices: malformation === 'invalid index' ? [99] : [],
      eventIds: malformation === 'invalid index' ? ['unknown'] : [],
      ...(malformation === 'missing warnings' ? {} : { warnings: [] }),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(settledResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'ingest_pending', details } }), { status: 503, headers: { 'Retry-After': '0' } }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxRetries: 2 });
    for (const id of ['qa91-unresolved', 'qa91-bad', 'qa91-accepted']) sdk.track({ id, action: 'qa91.sdk' });
    const flushing = sdk.flush();
    await vi.advanceTimersByTimeAsync(100);
    await flushing;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[1].body).not.toBe(fetcher.mock.calls[1]?.[1].body);
    expect(fetcher.mock.calls[1]?.[1].body).toBe(fetcher.mock.calls[2]?.[1].body);
    expect(sdk.dropped).toBe(1);
    expect(sdk.queueSize).toBe(0);
    await sdk.shutdown();
  },
);

it('remaps a final 202 rejection after a mixed 503 subset', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(settledResponse())
    .mockResolvedValueOnce(new Response(JSON.stringify({ rejected: [{ index: 0, reason: 'final rejection' }] }), { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn(),
    onError = vi.fn();
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxRetries: 1, onDrop, onError });
  for (const id of ['qa91-unresolved', 'qa91-bad', 'qa91-accepted']) sdk.track({ id, action: 'qa91.sdk' });
  const flushing = sdk.flush();
  await vi.advanceTimersByTimeAsync(0);
  await flushing;
  expect(onDrop.mock.calls.map(([event]) => event.id)).toEqual(['qa91-bad', 'qa91-unresolved']);
  expect(onError.mock.calls.map(([error]) => error.message)).toEqual([
    '1 events rejected by Logbird: invalid_event: bad Unicode',
    '1 events rejected by Logbird: final rejection',
  ]);
  expect(sdk.dropped).toBe(2);
  expect(sdk.queueSize).toBe(0);
  await sdk.shutdown();
});

it.each(['ingest_pending', 'ingest_unavailable'])('requeues only unsettled events under concurrent capacity pressure after %s', async (code) => {
  let respond!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    )
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockImplementation(async () => new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn();
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxQueueSize: 3, maxRetries: 0, onDrop });
  for (const id of ['qa91-unresolved', 'qa91-bad', 'qa91-accepted']) sdk.track({ id, action: 'qa91.sdk' });
  const flushing = sdk.flush();
  sdk.track({ id: 'qa91-new1', action: 'qa91.sdk' });
  sdk.track({ id: 'qa91-new2', action: 'qa91.sdk' });
  respond(settledResponse(code));
  await expect(flushing).rejects.toThrow('Logbird HTTP 503');
  expect(sdk.queueSize).toBe(3);
  expect(sdk.dropped).toBe(1);
  expect(onDrop.mock.calls.map(([event]) => event.id)).toEqual(['qa91-bad']);
  await sdk.shutdown();
  expect(JSON.parse(fetcher.mock.calls[2]?.[1].body).events.map((event: { id: string }) => event.id)).toEqual([
    'qa91-unresolved',
    'qa91-new1',
    'qa91-new2',
  ]);
});

it('does not drop settled indices twice when a partial 503 is followed by 401', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(settledResponse())
    .mockResolvedValueOnce(new Response('', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn();
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxRetries: 1, onDrop });
  for (const id of ['qa91-unresolved', 'qa91-bad', 'qa91-accepted']) sdk.track({ id, action: 'qa91.sdk' });
  const flushing = sdk.flush();
  await vi.advanceTimersByTimeAsync(0);
  await flushing;
  expect(onDrop.mock.calls.map(([event]) => event.id)).toEqual(['qa91-bad', 'qa91-unresolved']);
  expect(sdk.dropped).toBe(2);
  expect(sdk.queueSize).toBe(0);
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).events.map((event: { id: string }) => event.id)).toEqual(['qa91-unresolved']);
  await sdk.shutdown();
});

it('reports each rejection once across subset 503 retries and requeues only unresolved events', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(async () => settledResponse());
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn(),
    onError = vi.fn();
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxRetries: 1, onDrop, onError });
  for (const id of ['qa91-unresolved', 'qa91-bad', 'qa91-accepted']) sdk.track({ id, action: 'qa91.sdk' });
  const failed = expect(sdk.flush()).rejects.toThrow('Logbird HTTP 503');
  await vi.advanceTimersByTimeAsync(100);
  await failed;
  expect(sdk.queueSize).toBe(1);
  expect(sdk.dropped).toBe(1);
  expect(onDrop).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).events.map((event: { id: string }) => event.id)).toEqual(['qa91-unresolved']);
  fetcher.mockImplementation(async () => new Response('{}', { status: 202 }));
  await sdk.shutdown();
  expect(JSON.parse(fetcher.mock.calls[3]?.[1].body).events.map((event: { id: string }) => event.id)).toEqual(['qa91-unresolved']);
});

it('prunes settled events on an exceptional exit after a 503 and malformed 202', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(settledResponse())
    .mockResolvedValueOnce(new Response('{', { status: 202 }))
    .mockImplementation(async () => new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  const onDrop = vi.fn();
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://qa91.invalid', maxRetries: 1, onDrop });
  for (const id of ['qa91-unresolved', 'qa91-bad', 'qa91-accepted']) sdk.track({ id, action: 'qa91.sdk' });
  const failed = expect(sdk.flush()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  await failed;
  expect(sdk.queueSize).toBe(1);
  expect(sdk.dropped).toBe(1);
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).events.map((event: { id: string }) => event.id)).toEqual(['qa91-unresolved']);
  await sdk.shutdown();
  expect(JSON.parse(fetcher.mock.calls[2]?.[1].body).events.map((event: { id: string }) => event.id)).toEqual(['qa91-unresolved']);
  expect(onDrop).toHaveBeenCalledTimes(1);
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
