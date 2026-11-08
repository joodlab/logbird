/**
 * The console's API proxy handler against a capturing upstream: `fetch` is stubbed, so no port is opened and the
 * exact method and headers the API listener would receive are recorded.
 */
import { H3 } from 'nitro/h3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from './proxy';

type Captured = { url: string; method: string; headers: Headers };
let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  vi.stubEnv('LOGBIRD_SERVER_URL', 'http://api.logbird.test:4601');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers as HeadersInit) });
      return new Response('{"upstream":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const app = new H3().use(handler).use(() => new Response('console page', { status: 404 }));
const credentials = {
  cookie: 'better-auth.session_token=fixture-session',
  authorization: 'Bearer lb_read_fixture',
  'proxy-authorization': 'Basic Zml4dHVyZTpmaXh0dXJl',
  'x-request-id': 'fixture-request',
};
const send = (path: string, method = 'GET', body?: string) =>
  app.fetch(new Request(`http://console.logbird.test${path}`, { method, headers: credentials, body }));

describe('API reference forwarding', () => {
  it.each(['/docs', '/openapi.json'])('forwards GET and HEAD %s without credentials', async (path) => {
    for (const method of ['GET', 'HEAD']) {
      const response = await send(`${path}?theme=dark`, method);
      expect(response.status).toBe(200);
    }
    expect(captured).toHaveLength(2);
    for (const request of captured) {
      expect(request.url).toBe(`http://api.logbird.test:4601${path}?theme=dark`);
      expect(request.headers.get('cookie')).toBeNull();
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('proxy-authorization')).toBeNull();
      expect(request.headers.get('x-request-id')).toBe('fixture-request');
    }
    expect(captured.map((r) => r.method)).toEqual(['GET', 'HEAD']);
  });

  it.each([
    ['/docs', 'POST'],
    ['/docs', 'PUT'],
    ['/docs', 'PATCH'],
    ['/docs', 'DELETE'],
    ['/docs', 'OPTIONS'],
    ['/openapi.json', 'POST'],
    ['/openapi.json', 'PUT'],
    ['/openapi.json', 'PATCH'],
    ['/openapi.json', 'DELETE'],
    ['/openapi.json', 'OPTIONS'],
  ])('answers %s %s with 405 without reaching the API', async (path, method) => {
    const response = await send(path, method, ['POST', 'PUT', 'PATCH'].includes(method) ? '{"fixture":true}' : undefined);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(captured).toHaveLength(0);
  });
});

describe('authenticated API forwarding is unchanged', () => {
  it.each([
    ['/api/projects', 'GET'],
    ['/api/projects', 'POST'],
    ['/v1/events', 'POST'],
  ])('%s %s keeps Cookie and Authorization', async (path, method) => {
    const response = await send(path, method, method === 'POST' ? '{"action":"fixture.created"}' : undefined);
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe(method);
    expect(captured[0]?.headers.get('cookie')).toBe(credentials.cookie);
    expect(captured[0]?.headers.get('authorization')).toBe(credentials.authorization);
  });

  it('leaves console paths to the console', async () => {
    for (const path of ['/internal', '/docs/anything', '/openapi.yaml']) expect((await send(path)).status).toBe(404);
    expect(captured).toHaveLength(0);
  });
});

describe('dot segments and asset requests cannot reach other API paths', () => {
  const asset = (path: string, method = 'GET') =>
    app.fetch(new Request(`http://console.logbird.test${path}`, { method, headers: { ...credentials, 'sec-fetch-dest': 'image' } }));

  it.each([
    ['/api/../docs', 'POST'],
    ['/api/%2e%2e/openapi.json', 'POST'],
    ['/v1/%2E%2E/docs', 'DELETE'],
  ])('%s %s is the reference: 405, nothing forwarded', async (path, method) => {
    expect((await asset(path, method)).status).toBe(405);
    expect(captured).toHaveLength(0);
  });

  it.each([
    ['/api/../docs', '/docs'],
    ['/api/%2e%2e/openapi.json', '/openapi.json'],
  ])('GET %s is forwarded as %s without credentials', async (path, upstream) => {
    expect((await asset(path)).status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(new URL(captured[0]?.url ?? '').pathname).toBe(upstream);
    expect(captured[0]?.headers.get('cookie')).toBeNull();
    expect(captured[0]?.headers.get('authorization')).toBeNull();
  });

  it.each(['/v1/../internal', '/api/../metrics', '/api/%2e%2e/internal', '/api/../openapi.json/'])('%s stays on the console', async (path) => {
    expect((await asset(path, 'POST')).status).toBe(404);
    expect(captured).toHaveLength(0);
  });
});
