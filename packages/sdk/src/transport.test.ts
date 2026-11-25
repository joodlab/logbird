import { afterEach, expect, it, vi } from 'vitest';
import { type EventInput, Logbird, LogbirdError, redact } from './index';
import { readAuditTrail } from './read';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const endpoint = 'http://example.invalid';
const client = (options: Partial<ConstructorParameters<typeof Logbird>[0]> = {}) =>
  new Logbird({ endpoint, apiKey: 'fictional', maxRetries: 0, ...options });

function acknowledgement(init: RequestInit) {
  const events = JSON.parse(String(init.body)).events as { id: string }[];
  return Response.json({ accepted: events.length, ids: events.map((event) => event.id), rejected: [], warnings: [] }, { status: 202 });
}

it('refuses oversized and deep input before calling a hook that could shrink it', async () => {
  const beforeSend = vi.fn(() => ({ action: 'small' }));
  const sdk = client({ beforeSend });
  let nested: object = {};
  for (let level = 0; level < 100_000; level++) nested = { child: nested };
  sdk.track({ action: 'oversized', metadata: { secret: 'a'.repeat(2 * 1024 * 1024) } });
  sdk.track({ action: 'deep', metadata: { nested } });
  expect(beforeSend).not.toHaveBeenCalled();
  expect(sdk.droppedByReason).toEqual({ input_too_large: 1, input_too_deep: 1 });
  expect(sdk.queueSize).toBe(0);
  await sdk.shutdown();
});

it('refuses oversized input before the default redactor calls toJSON', async () => {
  const toJSON = vi.fn(() => ({ action: 'small' }));
  const sdk = client();
  sdk.track({ action: 'oversized', metadata: { token: 'a'.repeat(2 * 1024 * 1024) }, toJSON });
  expect(toJSON).not.toHaveBeenCalled();
  expect(sdk.droppedByReason).toEqual({ input_too_large: 1 });
  await sdk.shutdown();
});

it('sends redacted input within both limits when an array has many elements', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => acknowledgement(init));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client();
  sdk.track({ action: 'array', metadata: { values: new Array<number>(100_000).fill(0), token: 'a'.repeat(600_000) } });
  await sdk.shutdown();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(sdk.dropped).toBe(0);
});

it('counts redaction expansion as a wire-size refusal', async () => {
  const onError = vi.fn();
  const sdk = client({ onError });
  sdk.track({ action: 'redaction.expands', metadata: { rows: Array.from({ length: 80_000 }, () => ({ token: 0 })) } });
  await sdk.shutdown();
  expect(sdk.droppedByReason).toEqual({ too_large: 1 });
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'event_too_large' }));
  expect(sdk.queueSize).toBe(0);
});

it('bounds boxed strings returned by toJSON before serialization expands them', async () => {
  const sdk = client();
  const huge = '1'.repeat(2 * 1024 * 1024);
  const rawJSON = (JSON as typeof JSON & { rawJSON?: (value: string) => unknown }).rawJSON;
  sdk.track({ action: 'boxed', metadata: { value: { toJSON: () => new Object(huge) } } });
  sdk.track({ action: 'boxed', metadata: { value: { toJSON: () => Object.assign(new Object('1'), { toString: () => huge }) } } });
  if (rawJSON) sdk.track({ action: 'raw', metadata: { value: { toJSON: () => rawJSON(huge) } } });
  expect(sdk.droppedByReason).toEqual({ input_too_large: rawJSON ? 3 : 2 });
  await sdk.shutdown();
});

it('uses the per-data depth budget for metadata and change values', async () => {
  const nested = (depth: number) => {
    let value: unknown = 0;
    for (let i = 1; i < depth; i++) value = { child: value };
    return value;
  };
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => acknowledgement(init));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client();
  sdk.track({ action: 'at-limit', metadata: { child: nested(999) }, changes: [{ field: 'value', before: nested(1000) }] });
  sdk.track({ action: 'over-limit', changes: [{ field: 'value', before: nested(1001) }] });
  await sdk.shutdown();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(sdk.droppedByReason).toEqual({ input_too_deep: 1 });
});

it('cancels the ingest response when streamed bytes exceed the acknowledgement cap', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
    },
    cancel,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(stream, { status: 202 })),
  );
  const sdk = client();
  sdk.track({ action: 'test.audit' });
  await expect(sdk.flush()).rejects.toMatchObject({ code: 'response_too_large' });
  expect(cancel).toHaveBeenCalledOnce();
  expect(sdk.queueSize).toBe(1);
});

it('cancels unused ingest and read error bodies without reading them', async () => {
  const cancelIngest = vi.fn(),
    cancelRead = vi.fn();
  const response = (cancel: () => void) => new Response(new ReadableStream({ cancel }), { status: 401 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(cancelIngest)),
  );
  const sdk = client();
  sdk.track({ action: 'test.audit' });
  await sdk.shutdown();
  await expect(
    readAuditTrail({ endpoint, readKey: 'fictional', fetch: async () => response(cancelRead) }, { q: 'action:test.audit' }),
  ).rejects.toMatchObject({ code: 'read_http_error', status: 401 });
  expect(cancelIngest).toHaveBeenCalledOnce();
  expect(cancelRead).toHaveBeenCalledOnce();
});

it('cancels an over-cap read response before consuming it', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  const fetcher = vi.fn(async () => new Response(body, { headers: { 'Content-Length': String(64 * 1024 * 1024 + 1) } }));
  await expect(readAuditTrail({ endpoint, readKey: 'fictional', fetch: fetcher }, { q: 'action:test.audit' })).rejects.toMatchObject({
    code: 'response_too_large',
  });
  expect(cancel).toHaveBeenCalledOnce();
});

it('cancels a response that keeps emitting empty chunks', async () => {
  const cancel = vi.fn();
  const empty = new Uint8Array();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Keep a failing implementation from starving the test runner's timeout.
      if (++pulls > 1024) controller.error(new Error('empty response watchdog'));
      else controller.enqueue(empty);
    },
    cancel,
  });
  const fetcher = async () => new Response(body);
  await expect(readAuditTrail({ endpoint, readKey: 'fictional', fetch: fetcher }, { q: 'timestamp:*' })).rejects.toMatchObject({
    code: 'read_invalid_response',
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(pulls).toBeLessThan(1024);
});

it('preserves the caller reason and skips dispatch when read options abort the signal', async () => {
  const abort = new AbortController();
  const reason = new Error('caller stopped before dispatch');
  const fetcher = vi.fn(async () => new Response());
  const read = () =>
    readAuditTrail(
      {
        endpoint,
        fetch: fetcher,
        get readKey() {
          abort.abort(reason);
          return 'fictional';
        },
      },
      { q: 'timestamp:*' },
      abort.signal,
    );
  await expect(read()).rejects.toBe(reason);
  await expect(read()).rejects.toBe(reason);
  expect(fetcher).not.toHaveBeenCalled();
});

it('preserves read cancellation without using the caller reason or waiting for an uncooperative fetcher', async () => {
  const abort = new AbortController();
  const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
  const result = readAuditTrail({ endpoint, readKey: 'fictional', fetch: fetcher }, { q: 'action:test.audit' }, abort.signal);
  const cancelled = expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Logbird read aborted' });
  abort.abort(new Error('fixture-private-value'));
  await cancelled;
  expect(fetcher).toHaveBeenCalledOnce();
});

it('keeps abandoned reads charged through late body cancellation and restores capacity', async () => {
  const late: ((answer: Response) => void)[] = [];
  const cancellations: (() => void)[] = [];
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => late.push(resolve)));
  const options = { endpoint, readKey: 'fictional', fetch: fetcher };
  const read = (signal?: AbortSignal) => readAuditTrail(options, { q: 'timestamp:*' }, signal);
  for (let i = 0; i < 4; i++) {
    const abort = new AbortController();
    const result = expect(read(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await result;
  }
  const verifyFull = async () => {
    const abort = new AbortController();
    const rejected = expect(read(abort.signal)).rejects.toMatchObject({ code: 'read_requests_outstanding' });
    await Promise.resolve();
    abort.abort();
    await rejected;
  };
  await verifyFull();
  for (const respond of late) {
    respond(new Response(new ReadableStream({ cancel: () => new Promise<void>((resolve) => cancellations.push(resolve)) })));
  }
  await verifyFull();
  expect(cancellations).toHaveLength(4);
  cancellations[0]?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  fetcher.mockResolvedValueOnce(Response.json({ data: [], nextCursor: null, total: 0, tookMs: 0 }));
  await expect(read()).resolves.toMatchObject({ data: [] });
  expect(fetcher).toHaveBeenCalledTimes(5);
  for (const finish of cancellations) finish();
});

it('replaces transport-owned exceptions at both response boundaries', async () => {
  const privateValue = 'fixture-private-value';
  const forged = Object.assign(new LogbirdError('response_too_large'), { message: privateValue, cause: privateValue });
  const response = () => new Response(new ReadableStream({ start: (controller) => controller.error(forged) }), { status: 202 });
  const read = (fetch: typeof globalThis.fetch) => readAuditTrail({ endpoint, readKey: 'fictional', fetch }, { q: 'timestamp:*' });
  const body = read(async () => response());
  await expect(body).rejects.toMatchObject({ code: 'read_invalid_response', message: 'Invalid Logbird read response' });
  await expect(body).rejects.not.toHaveProperty('cause');
  const header = read(async () =>
    Object.defineProperty(new Response(), 'ok', {
      get: () => {
        throw forged;
      },
    }),
  );
  await expect(header).rejects.toMatchObject({ code: 'read_invalid_response', message: 'Invalid Logbird read response' });
  await expect(header).rejects.not.toHaveProperty('cause');
  vi.stubGlobal('fetch', async () => response());
  const sdk = client();
  sdk.track({ action: 'fixture' });
  const flushing = sdk.flush();
  await expect(flushing).rejects.toMatchObject({ code: 'ingest_unacknowledged', message: 'Logbird response did not acknowledge all events' });
  await expect(flushing).rejects.not.toHaveProperty('cause');
  expect(sdk.queueSize).toBe(1);
});

it('normalizes ingest status and retry headers before delivery classification', async () => {
  const raw = new Error('fixture-transport-detail', { cause: 'fixture-cause' });
  const invalidStatus = Object.defineProperty(new Response(null, { status: 401 }), 'status', { value: 'fixture-transport-detail' });
  const malformedHeader = new Response(null, { status: 429 });
  const throwingHeader = new Response(null, { status: 401 });
  Object.defineProperty(malformedHeader.headers, 'get', {
    value: () => ({
      toString: () => {
        throw raw;
      },
    }),
  });
  Object.defineProperty(throwingHeader, 'headers', {
    get: () => {
      throw raw;
    },
  });

  const onDrop = vi.fn();
  const sdk = client({ onDrop, maxRetries: 2 });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(invalidStatus)
    .mockResolvedValueOnce(malformedHeader)
    .mockResolvedValueOnce(throwingHeader);
  vi.stubGlobal('fetch', fetcher);
  sdk.track({ action: 'fixture' });
  const flushing = sdk.flush();
  await expect(flushing).rejects.toMatchObject({ code: 'ingest_request_failed', status: undefined });
  await expect(flushing).rejects.not.toHaveProperty('cause');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(sdk.queueSize).toBe(1);
  expect(onDrop).not.toHaveBeenCalled();
  fetcher.mockRejectedValue(raw);
  const closing = sdk.shutdown();
  await expect(closing).rejects.toMatchObject({ code: 'ingest_request_failed' });
  await expect(closing).rejects.not.toHaveProperty('cause');
  expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: 'shutdown', mayBeStored: true });
});

it('refuses pages containing malformed event rows', async () => {
  for (const row of [null, {}]) {
    const fetcher = async () => Response.json({ data: [row], nextCursor: null, total: 1, tookMs: 0 });
    await expect(readAuditTrail({ endpoint, readKey: 'fictional', fetch: fetcher }, { q: 'timestamp:*' })).rejects.toMatchObject({
      code: 'read_invalid_response',
    });
  }
});

it('replaces throwing options getters with a stable constructor diagnostic', () => {
  expect(
    () =>
      new Logbird({
        endpoint,
        get apiKey(): string {
          throw new Error('fixture-private-value', { cause: 'fixture-private-value' });
        },
      }),
  ).toThrow(expect.objectContaining({ code: 'options_invalid', message: 'Invalid batching options' }));
});

it('sets manual redirects on both authenticated requests', async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe('manual');
    return new Response(null, { status: 307, headers: { Location: '/next' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const onError = vi.fn();
  const sdk = client({ onError });
  sdk.track({ action: 'test.audit' });
  await sdk.shutdown();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ingest_redirect', status: 307 }));
  await expect(readAuditTrail({ endpoint, readKey: 'fictional', fetch: fetcher }, { q: 'action:test.audit' })).rejects.toMatchObject({
    code: 'read_redirect',
    status: 307,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('warns with the party field only and preserves the original wire identifier', async () => {
  const onWarning = vi.fn();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => acknowledgement(init));
  vi.stubGlobal('fetch', fetcher);
  const sdk = client({ onWarning });
  const id = 'identifier-fixture-\ud800';
  sdk.track({ action: 'test.audit', actor: { id } });
  await sdk.shutdown();
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body)).events[0].actor.id).toBe(id);
  expect(onWarning).toHaveBeenCalledOnce();
  expect(onWarning).toHaveBeenCalledWith({ code: 'party_id_normalization', field: 'actor.id' });
});

it('reports safe event rejection and hook diagnostics with stable codes', async () => {
  const onError = vi.fn();
  const onDrop = vi.fn();
  const marker = 'fixture-private-value';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ accepted: 0, ids: [], rejected: [{ index: 0, reason: marker, code: marker }], warnings: [] }, { status: 202 })),
  );
  const sdk = client({
    onError,
    onDrop,
    beforeSend: (value) => {
      if (value.action === 'hook') throw new Error(marker, { cause: marker });
      return value;
    },
  });
  sdk.track({ action: 'hook' });
  sdk.track({ action: 'test.audit' });
  await sdk.flush();
  expect(onError.mock.calls.map(([error]) => error.code)).toEqual(['before_send_failed', 'events_rejected']);
  for (const [error] of onError.mock.calls) {
    expect(error.message).not.toContain(marker);
    expect(error.cause).toBeUndefined();
  }
  expect(onDrop.mock.calls[1]?.[1].code).toBeUndefined();
});

it('sanitizes malformed read bodies, transport errors and a cycle in redact', async () => {
  const marker = 'fixture-private-value';
  const query = { q: 'action:test.audit' };
  const read = (fetch: typeof globalThis.fetch) => readAuditTrail({ endpoint, readKey: 'fictional', fetch }, query);
  await expect(read(async () => new Response(marker))).rejects.toMatchObject({
    code: 'read_invalid_response',
    message: 'Invalid Logbird read response',
  });
  await expect(
    read(async () => {
      throw new Error(marker, { cause: marker });
    }),
  ).rejects.toMatchObject({ code: 'read_request_failed', message: 'Logbird read request failed' });
  const cyclic: EventInput = { action: 'test.audit' };
  cyclic[marker] = cyclic;
  expect(() => redact()(cyclic)).toThrow(expect.objectContaining({ code: 'redaction_failed', message: 'Logbird redaction failed' }));
});
