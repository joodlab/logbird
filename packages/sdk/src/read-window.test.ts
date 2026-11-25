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
