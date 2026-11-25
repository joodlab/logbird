import type { EventDetail as ContractDetail } from '@logbird/contracts';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  type AuditEvent,
  type EventDetail,
  iterateAuditTrail,
  readAuditEvent,
  SERVER_DEFAULT_RANGE,
  type SearchResponse,
  TrailQueryError,
  trailQuery,
} from './read';

const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-02T00:00:00.000Z';

describe('a trail names its window', () => {
  it('refuses a trail without a range, or with no `from`, before anything is sent', () => {
    expect(() => trailQuery({ tenant: 'acme' })).toThrow(TrailQueryError);
    expect(() => trailQuery({ tenant: 'acme' })).toThrow(/a trail needs a `range`: without `from` the server reads only the 24 hours/);
    expect(() => trailQuery({ tenant: 'acme', range: { to: TO } })).toThrow(/`range` has no `from`/);
    // A selector error still comes first.
    expect(() => trailQuery({})).toThrow(/an empty trail would be the whole project/);
  });

  it('sends the bounds it is given, and none for the explicit server default', () => {
    expect(trailQuery({ tenant: 'acme', range: { from: FROM } })).toEqual({ from: FROM, q: 'tenant:"acme"' });
    expect(trailQuery({ tenant: 'acme', range: { from: new Date(FROM), to: Date.parse(TO) } })).toEqual({ from: FROM, to: TO, q: 'tenant:"acme"' });
    const fallback = trailQuery({ tenant: 'acme', range: SERVER_DEFAULT_RANGE });
    expect(fallback).toEqual({ q: 'tenant:"acme"' });
    expect('from' in fallback || 'to' in fallback).toBe(false);
    expect(() => trailQuery({ tenant: 'acme', range: 'server' as typeof SERVER_DEFAULT_RANGE })).toThrow(/`range` must be an object/);
  });

  it('reads oldest first on request', () => {
    expect(trailQuery({ tenant: 'acme', range: { from: FROM }, order: 'asc' }).order).toBe('asc');
    expect(trailQuery({ tenant: 'acme', range: { from: FROM }, order: 'desc' }).order).toBe('desc');
    expect(trailQuery({ tenant: 'acme', range: { from: FROM } }).order).toBeUndefined();
    expect(() => trailQuery({ tenant: 'acme', range: { from: FROM }, order: 'oldest' as 'asc' })).toThrow(/`order`/);
  });
});

const event = (id: string): AuditEvent => ({
  id,
  projectId: 'p',
  timestamp: FROM,
  receivedAt: FROM,
  environment: 'production',
  action: 'invoice.updated',
  category: 'invoice',
  outcome: 'success',
  severity: 'info',
  description: '',
  actor: null,
  impersonator: null,
  executor: null,
  tenant: { id: 'acme', name: '' },
  source: null,
  targets: [],
  changes: [],
  context: { operationId: '', parentEventId: '', requestId: '', traceId: '', ip: '', userAgent: '' },
  attributes: {},
  conformance: 50,
  schemaVersion: '',
  sdk: '',
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('readAuditEvent', () => {
  it('keeps the detail type aligned with the public contract', () => {
    expectTypeOf<EventDetail>().toEqualTypeOf<ContractDetail>();
  });

  it('reads one event with its parents, child count and payload; null when it is not there', async () => {
    const detail: EventDetail = {
      event: event('e 2'),
      payload: { action: 'invoice.updated' },
      parents: [event('e1')],
      childCount: 2,
      operationSize: 3,
    };
    const fetch = vi.fn(async (url: URL | RequestInfo) => (String(url).endsWith('/v1/events/e%202') ? json(detail) : json({ error: {} }, 404)));
    const options = { endpoint: 'https://logbird.test/', readKey: 'lb_read_x', fetch: fetch as unknown as typeof globalThis.fetch };
    expect(await readAuditEvent(options, 'e 2')).toEqual(detail);
    expect(await readAuditEvent(options, 'missing')).toBeNull();
    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('https://logbird.test/v1/events/e%202'));
    await expect(readAuditEvent(options, '  ')).rejects.toThrow(TrailQueryError);
    fetch.mockImplementationOnce(async () => json({ error: {} }, 500));
    await expect(readAuditEvent(options, 'e1')).rejects.toThrow(/HTTP 500/);
  });
});

describe('iterateAuditTrail', () => {
  /** A stand-in server: `pages` events per page, the window it applied, and every request it received. */
  function server(ids: string[], perPage: number, applied = { from: FROM, to: TO }) {
    const requests: URLSearchParams[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      const params = new URL(String(url)).searchParams;
      requests.push(params);
      const start = Number(params.get('cursor') ?? 0);
      const data = ids.slice(start, start + perPage).map(event);
      const next = start + perPage < ids.length ? String(start + perPage) : null;
      return json({ data, nextCursor: next, total: ids.length, totalExact: true, range: applied, tookMs: 1 } satisfies SearchResponse);
    });
    return {
      requests,
      options: { endpoint: 'https://logbird.test', readKey: 'lb_read_x', fetch: fetch as unknown as typeof globalThis.fetch },
      fetch,
    };
  }

  it('reads every page oldest first within the window the first page applied, then stops', async () => {
    const { requests, options } = server(['a', 'b', 'c', 'd', 'e'], 2);
    const seen: string[] = [];
    for await (const e of iterateAuditTrail(options, { tenant: 'acme', range: { from: FROM }, order: 'asc', limit: 2 })) seen.push(e.id);
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(requests).toHaveLength(3);
    // Page one sends only `from`; every later page pins the applied window, so `to` never moves with the clock.
    expect(requests[0]?.get('to')).toBeNull();
    for (const params of requests.slice(1)) expect([params.get('from'), params.get('to'), params.get('order')]).toEqual([FROM, TO, 'asc']);
    expect(requests.map((p) => p.get('cursor'))).toEqual([null, '2', '4']);
  });

  it('stops before the next request when the caller breaks out', async () => {
    const { options, fetch } = server(['a', 'b', 'c', 'd'], 2);
    for await (const e of iterateAuditTrail(options, { tenant: 'acme', range: { from: FROM, to: TO } })) if (e.id === 'a') break;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('needs a range with `from`, and refuses the server default, before anything is sent', async () => {
    const { options, fetch } = server(['a'], 2);
    const drain = async (trail: Parameters<typeof iterateAuditTrail>[1]) => {
      for await (const _ of iterateAuditTrail(options, trail)) void _;
    };
    await expect(drain({ tenant: 'acme' })).rejects.toThrow(/needs a `range`/);
    await expect(drain({ tenant: 'acme', range: SERVER_DEFAULT_RANGE })).rejects.toThrow(/a whole trail needs `range: \{ from \}`/);
    await expect(drain({ range: { from: FROM } })).rejects.toThrow(/empty trail/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a server that repeats a cursor instead of looping', async () => {
    const fetch = vi.fn(async () => json({ data: [event('a')], nextCursor: 'same', total: 2, range: { from: FROM, to: TO }, tookMs: 1 }));
    const options = { endpoint: 'https://logbird.test', readKey: 'k', fetch: fetch as unknown as typeof globalThis.fetch };
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const e of iterateAuditTrail(options, { tenant: 'acme', range: { from: FROM } })) seen.push(e.id);
      })(),
    ).rejects.toThrow(/repeated a page cursor/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('iterateAuditTrail checks every page before it yields', () => {
  const reply = (pages: Record<string, unknown>[]) => {
    let i = 0;
    const fetch = vi.fn(async () => json(pages[Math.min(i++, pages.length - 1)]));
    return { fetch, options: { endpoint: 'https://logbird.test', readKey: 'k', fetch: fetch as unknown as typeof globalThis.fetch } };
  };
  const collect = async (options: Parameters<typeof iterateAuditTrail>[0], trail: Parameters<typeof iterateAuditTrail>[1]) => {
    const seen: string[] = [];
    let error: unknown;
    try {
      for await (const e of iterateAuditTrail(options, trail)) seen.push(e.id);
    } catch (cause) {
      error = cause;
    }
    return { seen, error: error instanceof Error ? error.message : undefined };
  };

  it('refuses a first page whose window is not the one asked for, before yielding it', async () => {
    const { options } = reply([{ data: [event('a')], nextCursor: null, total: 1, range: { from: '2026-02-01T00:00:00.000Z', to: TO }, tookMs: 1 }]);
    expect(await collect(options, { tenant: 'acme', range: { from: FROM } })).toEqual({
      seen: [],
      error: expect.stringMatching(/not the window asked for/),
    });
    // A bound the server moved onto its store limit is the same window.
    const clamped = reply([{ data: [event('a')], nextCursor: null, total: 1, range: { from: '1900-01-01T00:00:00.000Z', to: TO }, tookMs: 1 }]);
    expect(await collect(clamped.options, { tenant: 'acme', range: { from: '0001-01-01T00:00:00.000Z', to: TO } })).toEqual({
      seen: ['a'],
      error: undefined,
    });
  });

  it('refuses a window that changes between pages, before yielding the changed page', async () => {
    const { options } = reply([
      { data: [event('a')], nextCursor: 'c1', total: 2, range: { from: FROM, to: TO }, tookMs: 1 },
      { data: [event('b')], nextCursor: null, total: 2, range: { from: FROM, to: '2026-11-03T00:00:00.000Z' }, tookMs: 1 },
    ]);
    expect(await collect(options, { tenant: 'acme', range: { from: FROM } })).toEqual({
      seen: ['a'],
      error: expect.stringMatching(/changed the window/),
    });
  });

  it('cannot keep a fixed end on a server that reports no window: needs `to` before a second page', async () => {
    const pages = [
      { data: [event('a')], nextCursor: 'c1', total: 2, tookMs: 1 },
      { data: [event('b')], nextCursor: null, total: 2, tookMs: 1 },
    ];
    expect(await collect(reply(pages).options, { tenant: 'acme', range: { from: FROM } })).toEqual({
      seen: [],
      error: expect.stringMatching(/pass `range.to`/),
    });
    const fixed = reply(pages);
    expect(await collect(fixed.options, { tenant: 'acme', range: { from: FROM, to: TO } })).toEqual({ seen: ['a', 'b'], error: undefined });
    const second = fixed.fetch.mock.calls[1] as unknown as [URL];
    expect(new URL(String(second[0])).searchParams.get('to')).toBe(TO);
  });

  it('ends on any cursor it has used, and skips an id it has already yielded', async () => {
    const cycle = reply([
      { data: [event('a')], nextCursor: 'A', total: 9, range: { from: FROM, to: TO }, tookMs: 1 },
      { data: [event('b')], nextCursor: 'B', total: 9, range: { from: FROM, to: TO }, tookMs: 1 },
      { data: [event('c')], nextCursor: 'A', total: 9, range: { from: FROM, to: TO }, tookMs: 1 },
    ]);
    expect(await collect(cycle.options, { tenant: 'acme', range: { from: FROM } })).toEqual({
      seen: ['a', 'b'],
      error: expect.stringMatching(/repeated a page cursor/),
    });
    const repeats = reply([
      { data: [event('a'), event('b')], nextCursor: 'c1', total: 3, range: { from: FROM, to: TO }, tookMs: 1 },
      { data: [event('b'), event('c')], nextCursor: null, total: 3, range: { from: FROM, to: TO }, tookMs: 1 },
    ]);
    expect(await collect(repeats.options, { tenant: 'acme', range: { from: FROM } })).toEqual({ seen: ['a', 'b', 'c'], error: undefined });
  });

  it('reads the trail and the reader once, when called: later changes to those objects do not reach the pass', async () => {
    const first = reply([{ data: [event('a')], nextCursor: null, total: 1, range: { from: FROM, to: TO }, tookMs: 1 }]);
    const other = reply([{ data: [event('x')], nextCursor: null, total: 1, range: { from: FROM, to: TO }, tookMs: 1 }]);
    const trail = { tenant: 'acme', range: { from: FROM } };
    const options = { ...first.options };
    const pass = iterateAuditTrail(options, trail);
    trail.tenant = 'globex';
    options.fetch = other.options.fetch;
    const seen: string[] = [];
    for await (const e of pass) seen.push(e.id);
    expect(seen).toEqual(['a']);
    expect(new URL(String((first.fetch.mock.calls[0] as unknown as [URL])[0])).searchParams.get('q')).toBe('tenant:"acme"');
    expect(other.fetch).not.toHaveBeenCalled();
  });

  it('stops yielding a page once its signal aborts', async () => {
    const { options } = reply([{ data: [event('a'), event('b'), event('c')], nextCursor: null, total: 3, range: { from: FROM, to: TO }, tookMs: 1 }]);
    const controller = new AbortController();
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const e of iterateAuditTrail(options, { tenant: 'acme', range: { from: FROM } }, controller.signal)) {
          seen.push(e.id);
          controller.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(seen).toEqual(['a']);
  });
});

describe('the helpers keep what the caller and the server gave', () => {
  it('leaves a caller order in place when the trail gives none', () => {
    expect({ order: 'asc', ...trailQuery({ tenant: 'acme', range: { from: FROM } }) }.order).toBe('asc');
  });

  it('never takes a range or order from Object.prototype', () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.range = SERVER_DEFAULT_RANGE;
    proto.order = 'asc';
    try {
      expect(() => trailQuery(Object.assign(Object.create(null), { tenant: 'acme' }))).toThrow(/needs a `range`/);
      // A null-prototype input has no order: the snapshot built from it must not pick one up from Object.prototype.
      const bare = Object.assign(Object.create(null), { tenant: 'acme', range: Object.assign(Object.create(null), { from: FROM }) });
      expect(Object.hasOwn(trailQuery(bare), 'order')).toBe(false);
    } finally {
      delete proto.range;
      delete proto.order;
    }
  });

  it('keeps the exact digits of numbers in the original payload, and refuses an id no URL path can hold', async () => {
    const body = `{"event":${JSON.stringify(event('e1'))},"payload":{"accountId":9007199254740993,"ratio":0.1000000000000000055511151231257827},"parents":[],"childCount":0,"operationSize":1}`;
    const fetch = vi.fn(async () => new Response(body, { status: 200 }));
    const options = { endpoint: 'https://logbird.test', readKey: 'k', fetch: fetch as unknown as typeof globalThis.fetch };
    const detail = await readAuditEvent(options, 'e1');
    expect(JSON.stringify(detail?.payload)).toBe('{"accountId":9007199254740993,"ratio":0.1000000000000000055511151231257827}');
    for (const id of ['.', '..']) await expect(readAuditEvent(options, id)).rejects.toThrow(/cannot be addressed in a URL path/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('iterateAuditTrail, round two', () => {
  const reply = (pages: Record<string, unknown>[]) => {
    let i = 0;
    const fetch = vi.fn(async () => json(pages[Math.min(i++, pages.length - 1)]));
    return { fetch, options: { endpoint: 'https://logbird.test', readKey: 'k', fetch: fetch as unknown as typeof globalThis.fetch } };
  };
  const collect = async (options: Parameters<typeof iterateAuditTrail>[0], trail: Parameters<typeof iterateAuditTrail>[1]) => {
    const seen: string[] = [];
    let error: unknown;
    try {
      for await (const e of iterateAuditTrail(options, trail)) seen.push(e.id);
    } catch (cause) {
      error = cause;
    }
    return { seen, error: error instanceof Error ? error.message : undefined };
  };
  const windowed = (ids: string[], nextCursor: string | null, range: unknown = { from: FROM, to: TO }) => ({
    data: ids.map(event),
    nextCursor,
    total: 9,
    ...(range === null ? {} : { range }),
    tookMs: 1,
  });

  it('refuses a later page that stops reporting the window, before yielding it', async () => {
    const { options } = reply([windowed(['a'], 'c1'), windowed(['b'], null, null)]);
    expect(await collect(options, { tenant: 'acme', range: { from: FROM } })).toEqual({
      seen: ['a'],
      error: expect.stringMatching(/stopped reporting it/),
    });
  });

  it('refuses a reported window that is not two instants, start first', async () => {
    for (const range of [{ from: FROM }, { from: TO, to: FROM }, { from: FROM, to: 'soon' }]) {
      const { options } = reply([windowed(['a'], 'c1', range)]);
      expect(await collect(options, { tenant: 'acme', range: { from: FROM } })).toEqual({
        seen: [],
        error: expect.stringMatching(/not two instants/),
      });
    }
  });

  it('needs bounds it can compare: with Z or an offset, a Date, or a date alone', async () => {
    const { options, fetch } = reply([windowed(['a'], null)]);
    expect(() => iterateAuditTrail(options, { tenant: 'acme', range: { from: '2026-11-01T00:00:00' } })).toThrow(/has no time zone/);
    expect(() => iterateAuditTrail(options, { tenant: 'acme', range: { from: FROM, to: '2026-11-02T00:00' } })).toThrow(/has no time zone/);
    expect(fetch).not.toHaveBeenCalled();
    expect(await collect(options, { tenant: 'acme', range: { from: '2026-11-01', to: '2026-11-02T03:00:00+03:00' } })).toEqual({
      seen: ['a'],
      error: undefined,
    });
  });

  it('refuses a page holding an event outside the window, before yielding any of it', async () => {
    const outside = { ...windowed(['a'], null), data: [event('a'), { ...event('b'), timestamp: TO }] };
    const { options } = reply([outside]);
    expect(await collect(options, { tenant: 'acme', range: { from: FROM } })).toEqual({
      seen: [],
      error: expect.stringMatching(/outside the window/),
    });
  });

  it('reads the transport once, when called', async () => {
    const { fetch } = reply([windowed(['a'], null)]);
    let reads = 0;
    const options = {
      endpoint: 'https://logbird.test',
      readKey: 'k',
      get fetch() {
        reads++;
        return reads === 1 ? (fetch as unknown as typeof globalThis.fetch) : undefined;
      },
    };
    expect(await collect(options, { tenant: 'acme', range: { from: FROM } })).toEqual({ seen: ['a'], error: undefined });
    expect(reads).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('readAuditEvent returns only the event asked for', () => {
  it('refuses another event, or an answer that is not a detail', async () => {
    for (const body of [
      { event: event('other'), payload: null, parents: [], childCount: 0, operationSize: 0 },
      { error: { code: 'x', message: 'y' } },
      { event: event('e1'), parents: [], childCount: 0, operationSize: 0 },
    ]) {
      const fetch = vi.fn(async () => json(body));
      const options = { endpoint: 'https://logbird.test', readKey: 'k', fetch: fetch as unknown as typeof globalThis.fetch };
      await expect(readAuditEvent(options, 'e1')).rejects.toThrow(/not the detail of the event asked for/);
    }
  });
});

describe('round three: shapes and ownership', () => {
  const reply = (pages: unknown[]) => {
    let i = 0;
    const fetch = vi.fn(async () => json(pages[Math.min(i++, pages.length - 1)]));
    return { fetch, options: { endpoint: 'https://logbird.test', readKey: 'k', fetch: fetch as unknown as typeof globalThis.fetch } };
  };
  const collect = async (options: Parameters<typeof iterateAuditTrail>[0], trail: Parameters<typeof iterateAuditTrail>[1]) => {
    const seen: string[] = [];
    let error: unknown;
    try {
      for await (const e of iterateAuditTrail(options, trail)) seen.push(e.id);
    } catch (cause) {
      error = cause;
    }
    return { seen, error: error instanceof Error ? error.message : undefined };
  };

  it('ignores a `to` added to Object.prototype after the pass was created', async () => {
    const { options, fetch } = reply([{ data: [event('a')], nextCursor: null, total: 1, range: { from: FROM, to: TO }, tookMs: 1 }]);
    const pass = iterateAuditTrail(options, { tenant: 'acme', range: { from: FROM } });
    const proto = Object.prototype as Record<string, unknown>;
    proto.to = '2026-11-01T00:00:00.500Z';
    try {
      const seen: string[] = [];
      for await (const e of pass) seen.push(e.id);
      expect(seen).toEqual(['a']);
      expect(new URL(String((fetch.mock.calls[0] as unknown as [URL])[0])).searchParams.get('to')).toBeNull();
    } finally {
      delete proto.to;
    }
  });

  it('refuses a page that is not a page of events, before yielding any of it', async () => {
    const noCursor = { data: [event('a')], total: 1, range: { from: FROM, to: TO }, tookMs: 1 };
    expect(await collect(reply([noCursor]).options, { tenant: 'acme', range: { from: FROM } })).toEqual({
      seen: [],
      error: expect.stringMatching(/not a page of events/),
    });
    const noIds = {
      data: [
        { ...event('a'), id: undefined },
        { ...event('b'), id: undefined },
      ],
      nextCursor: null,
      total: 2,
      range: { from: FROM, to: TO },
      tookMs: 1,
    };
    expect(await collect(reply([noIds]).options, { tenant: 'acme', range: { from: FROM } })).toEqual({
      seen: [],
      error: expect.stringMatching(/not a page of events/),
    });
  });

  it('accepts a reported window only in the server form: UTC with three fractional digits', async () => {
    for (const range of [
      { from: '2026-11-01T00:00:00.0009Z', to: TO },
      { from: FROM, to: '2026-11-02T00:00:00' },
      { from: '2026-11-01T00:00:00Z', to: TO },
    ]) {
      const { options } = reply([{ data: [event('a')], nextCursor: null, total: 1, range, tookMs: 1 }]);
      expect(await collect(options, { tenant: 'acme', range: { from: FROM } })).toEqual({
        seen: [],
        error: expect.stringMatching(/not two instants/),
      });
    }
  });

  it('refuses a detail whose event, parents or counts break the contract', async () => {
    for (const body of [
      { event: { id: 'e1' }, payload: null, parents: [], childCount: 0, operationSize: 0 },
      { event: event('e1'), payload: null, parents: [null], childCount: 0, operationSize: 0 },
      { event: event('e1'), payload: null, parents: [], childCount: 1.5, operationSize: 0 },
      { event: event('e1'), payload: null, parents: [], childCount: 0, operationSize: -1 },
    ]) {
      const fetch = vi.fn(async () => json(body));
      const options = { endpoint: 'https://logbird.test', readKey: 'k', fetch: fetch as unknown as typeof globalThis.fetch };
      await expect(readAuditEvent(options, 'e1')).rejects.toThrow(/not the detail of the event asked for/);
    }
  });
});
