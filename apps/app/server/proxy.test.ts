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
  vi.stubEnv('LOGBIRD_SITE_URL', '');
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

describe('optional marketing upstream', () => {
  const policy = "default-src 'self'; script-src 'self' 'sha256-fixture'";
  const siteHeaders = {
    'content-security-policy': policy,
    'cache-control': 'public, max-age=0, must-revalidate',
    'strict-transport-security': 'max-age=31536000',
    'set-cookie': '__Secure-logbird.session_token=evil; Secure',
  };
  const staged = new H3()
    .use((event) => {
      event.res.headers.set('content-security-policy', 'console policy');
      event.res.headers.set('referrer-policy', 'console policy');
      event.req.ip = '192.0.2.3';
    })
    .use(handler)
    .use(() => new Response('console page'));
  const request = (path: string, method = 'GET', cookie = 'other=x') =>
    staged.fetch(
      new Request(`https://console.logbird.test${path}`, {
        method,
        headers: { ...credentials, cookie, 'x-forwarded-for': '192.0.2.1', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'console.logbird.test' },
        ...(['POST', 'PUT', 'PATCH'].includes(method) ? { body: 'fixture' } : {}),
      }),
    );
  beforeEach(() => {
    vi.stubEnv('LOGBIRD_SITE_URL', 'http://site.logbird.test:4620');
  });
  it('marks `/` as varying by Cookie, whether the site or the console answers it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('site home', { status: 200, headers: siteHeaders })),
    );
    const site = await request('/');
    expect(site.headers.get('content-security-policy')).toBe(policy);
    expect(site.headers.get('vary')).toMatch(/cookie/i);
    const consolePage = await request('/', 'GET', '__Secure-logbird.session_token=fixture');
    expect(await consolePage.text()).toBe('console page');
    expect(consolePage.headers.get('vary')).toMatch(/cookie/i);
    expect((await request('/product')).headers.get('vary') ?? '').not.toMatch(/cookie/i);
  });
  it('preserves existing behavior when unset, even for unsupported site methods', async () => {
    vi.stubEnv('LOGBIRD_SITE_URL', '');
    for (const path of ['/', '/product', '/site-assets/a.js']) {
      expect(await (await request(path)).text()).toBe('console page');
      expect(await (await request(path, 'POST')).text()).toBe('console page');
    }
    expect(captured).toHaveLength(0);
  });
  it.each(['logbird.session_token=x', '__Secure-logbird.session_token=x'])('keeps signed-in root on console: %s', async (cookie) => {
    expect(await (await request('/', 'GET', cookie)).text()).toBe('console page');
    expect(captured).toHaveLength(0);
  });
  it.each(['other=x', 'logbird.session_token=', '__Secure-logbird.session_token=; other=x'])('forwards anonymous root: %s', async (cookie) => {
    expect((await request('/', 'GET', cookie)).status).toBe(200);
    expect(captured[0]?.url).toBe('http://site.logbird.test:4620/');
  });
  it('strips credentials and Set-Cookie, preserves upstream policy and appends forwarding address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers) });
        return new Response('site html', { headers: siteHeaders });
      }),
    );
    const response = await request('/product?tour=1');
    expect(await response.text()).toBe('site html');
    expect(response.headers.get('content-security-policy')).toBe(policy);
    expect(response.headers.get('cache-control')).toBe(siteHeaders['cache-control']);
    expect(response.headers.get('strict-transport-security')).toBe(siteHeaders['strict-transport-security']);
    expect(response.headers.get('referrer-policy')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    const forwarded = captured[0];
    expect(forwarded?.url).toBe('http://site.logbird.test:4620/product?tour=1');
    for (const name of ['cookie', 'authorization', 'proxy-authorization']) expect(forwarded?.headers.get(name)).toBeNull();
    expect(forwarded?.headers.get('x-forwarded-for')).toBe('192.0.2.1, 192.0.2.3');
    expect(forwarded?.headers.get('x-forwarded-proto')).toBe('https');
    expect(forwarded?.headers.get('x-forwarded-host')).toBe('console.logbird.test');
  });
  it.each(['/product/../about', '/product/%2e%2e/about', '/product//x', '/product%2Fx', '/product%5cx'])(
    'rejects raw ambiguous path %s before URL normalization',
    async (path) => {
      const raw = new Request('https://console.logbird.test/');
      Object.defineProperty(raw, 'url', { value: `https://console.logbird.test${path}` });
      const response = await staged.fetch(raw);
      expect(await response.text()).toBe('console page');
      expect(captured).toHaveLength(0);
    },
  );
  it('retains API precedence and credentials, including the old waitlist namespace', async () => {
    await request('/api/waitlist', 'POST', 'logbird.session_token=x');
    expect(captured[0]?.url).toBe('http://api.logbird.test:4601/api/waitlist');
    expect(captured[0]?.headers.get('cookie')).toBe('logbird.session_token=x');
  });
  it('forwards HEAD assets and POST site-api, and answers other methods with Allow', async () => {
    for (const [path, method] of [
      ['/site-assets/x.js', 'HEAD'],
      ['/site-api/waitlist', 'POST'],
    ] as const) {
      expect((await request(path, method)).status).toBe(200);
    }
    expect(captured.map((r) => r.method)).toEqual(['HEAD', 'POST']);
    for (const [path, method, allow] of [
      ['/product', 'POST', 'GET, HEAD'],
      ['/site-api/x', 'DELETE', 'GET, HEAD, POST'],
    ] as const) {
      const response = await request(path, method);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe(allow);
    }
    expect(captured).toHaveLength(2);
  });
  it.each(['unreachable', '500', '503'])('falls back at root for %s; elsewhere relays site errors, 502 only when unreachable', async (failure) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (failure === 'unreachable') throw new Error('fixture offline');
        return new Response('site error', { status: Number(failure), headers: siteHeaders });
      }),
    );
    const root = await request('/');
    expect(await root.text()).toBe('console page');
    expect(root.headers.get('content-security-policy')).toBe('console policy');
    for (const path of ['/product', '/site-api/waitlist', '/site-assets/x.js']) {
      const response = await request(path);
      if (failure === 'unreachable') {
        expect(response.status).toBe(502);
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(await response.text()).toBe('Bad Gateway');
      } else {
        // The site's own error (and its policy) passes through, so the page can react to its error code.
        expect(response.status).toBe(Number(failure));
        expect(await response.text()).toBe('site error');
        expect(response.headers.get('content-security-policy')).toBe(policy);
      }
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });
  it('preserves a site 404 and its policy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404, headers: siteHeaders })),
    );
    const response = await request('/product/missing');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBe(policy);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it('preserves redirects without rewriting their headers or relaying cookies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const headers = new Headers({ ...siteHeaders, location: 'http://site.logbird.test:4620/contact?status=ok' });
        headers.append('set-cookie', 'other=fixture');
        return new Response(null, { status: 303, headers });
      }),
    );
    const response = await request('/site-api/waitlist', 'POST');
    expect(response.status).toBe(303);
    // An absolute redirect to the private site address becomes a path on the console origin.
    expect(response.headers.get('location')).toBe('/contact?status=ok');
    expect(response.headers.get('content-security-policy')).toBe(policy);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
