import { auth } from '@logbird/auth';
import { routes } from '@logbird/contracts';
import { expect, it, vi } from 'vitest';
import { app } from './app';
import { mutationPermissions } from './middlewares/require-role';
import { authMatrix, consoleMatrix } from './route-authorization.matrix';

// Registry and policy checks only: avoid opening Redis connections when loading
// the real Hono route tree. Authorization behavior is tested in the service suite.
vi.mock('./rate-limit', () => ({
  clientAddress: () => undefined,
  rateLimit: (_c: unknown, next: () => Promise<void>) => next(),
  requestRateLimit: () => (_c: unknown, next: () => Promise<void>) => next(),
  publicRateLimits: { authenticated: () => (_c: unknown, next: () => Promise<void>) => next() },
}));
vi.mock('@logbird/worker/queue', () => ({ connection: {}, retentionQueue: {} }));

function contractRoutes(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if ('method' in value && 'path' in value) return [`${value.method} ${value.path}`];
  return Object.values(value).flatMap(contractRoutes);
}

it('accounts for every concrete /api and /v1 route and contract', () => {
  const expected = consoleMatrix.map(([method, path]) => `${method} ${path}`).sort();
  const actual = app.routes
    .filter((r) => r.method !== 'ALL' && /^\/(api|v1)\//.test(r.path) && r.path !== '/api/auth/*')
    .map((r) => `${r.method} ${r.path}`);
  // Hono registers documentation/validation middleware once per method too.
  expect([...new Set(actual)].sort()).toEqual(expected);
  expect(
    contractRoutes(routes)
      .filter((r) => / \/(api|v1)\//.test(r))
      .sort(),
  ).toEqual(expected);
  expect(new Set(expected).size).toBe(expected.length);
});

it('accounts for every configured auth capability, including methods that are server-only', () => {
  expect(Object.keys(auth.api).sort()).toEqual(Object.keys(authMatrix).sort());
  for (const [name, endpoint] of Object.entries(auth.api)) {
    const policy = authMatrix[name as keyof typeof authMatrix];
    expect(typeof endpoint.path === 'string', name).toBe(policy !== 'server-only');
  }
});

it.each(consoleMatrix.filter(([method, path]) => method !== 'GET' && path.startsWith('/api/') && !path.includes(':token/accept')))(
  '%s %s has the exact reviewed mutation roles (%s)',
  (method, path, policy) => {
    const permissions = mutationPermissions.filter((permission) => permission.method === method && permission.path.test(path));
    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.roles).toEqual(policy === 'admin' ? ['owner', 'admin'] : ['owner', 'admin', 'member']);
  },
);

it('does not grant any mutation permission to unlisted routes or methods', () => {
  for (const [method, path] of [
    ['POST', '/api/projects/fictional/future-mutation'],
    ['PUT', '/api/projects/fictional'],
    ['DELETE', '/api/workspace'],
  ]) {
    expect(mutationPermissions.some((p) => p.method === method && p.path.test(path ?? ''))).toBe(false);
  }
});
