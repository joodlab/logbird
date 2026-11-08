import { describe, expect, it } from 'vitest';
import { isProxiedPath } from './proxy-paths';

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
