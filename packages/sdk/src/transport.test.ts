import { afterEach, expect, it, vi } from 'vitest';
import { type EventInput, Logbird, redact } from './index';
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

it('preserves read cancellation without using the caller reason or waiting for an uncooperative fetcher', async () => {
  const abort = new AbortController();
  const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
  const result = readAuditTrail({ endpoint, readKey: 'fictional', fetch: fetcher }, { q: 'action:test.audit' }, abort.signal);
  const cancelled = expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'Logbird read aborted' });
  abort.abort(new Error('fixture-private-value'));
  await cancelled;
  expect(fetcher).toHaveBeenCalledOnce();
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
