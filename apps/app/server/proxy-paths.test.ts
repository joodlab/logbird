import { describe, expect, it } from 'vitest';
import { isProxiedPath, proxiedRoutePatterns, proxyDecision } from './proxy-paths';

describe('console → API proxy allowlist', () => {
  it.each(['/api', '/api/auth/get-session', '/v1', '/v1/events', '/health', '/livez', '/readyz', '/docs', '/openapi.json'])('forwards %s', (path) => {
    expect(isProxiedPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/login',
    '/internal',
    '/internal/metrics',
    '/metrics',
    '/docs/',
    '/docs/anything',
    '/docsx',
    '/openapi.yaml',
    '/openapi.json/extra',
    '/apis',
    '/v10/events',
    '/v1x',
    '/.env',
    '/assets/index.js',
  ])('keeps %s on the console', (path) => {
    expect(isProxiedPath(path)).toBe(false);
  });
});

describe('proxy decision by method', () => {
  it.each([
    ['/docs', 'GET', 'reference'],
    ['/docs', 'head', 'reference'],
    ['/openapi.json', 'GET', 'reference'],
    ['/docs', 'POST', 'method-not-allowed'],
    ['/openapi.json', 'OPTIONS', 'method-not-allowed'],
    ['/openapi.json', 'DELETE', 'method-not-allowed'],
    ['/api/projects', 'POST', 'api'],
    ['/v1/events', 'OPTIONS', 'api'],
    ['/readyz', 'GET', 'api'],
    ['/internal', 'POST', 'console'],
  ] as const)('%s %s → %s', (path, method, decision) => {
    expect(proxyDecision(path, method)).toBe(decision);
  });
});

describe('explicit Nitro routes', () => {
  it('cover exactly the proxied paths, including ids that end in an asset extension', () => {
    for (const route of proxiedRoutePatterns) {
      const sample = route.endsWith('/**') ? `${route.slice(0, -3)}/projects/p1/events/receipt.png` : route;
      expect(proxyDecision(sample, 'GET'), route).not.toBe('console');
    }
    expect(proxiedRoutePatterns).toEqual(['/api', '/api/**', '/v1', '/v1/**', '/health', '/livez', '/readyz', '/docs', '/openapi.json']);
  });
});
