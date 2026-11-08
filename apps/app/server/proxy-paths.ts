/**
 * Which requests the console forwards to the private API listener. Everything else is served by the console (pages,
 * assets) and every other API path stays private, so adding a public server route needs a change here.
 *
 * - `/api/*` and `/v1/*`: the internal and public APIs (all methods, with credentials).
 * - `/health`, `/livez`, `/readyz`: operational checks.
 * - `/docs` and `/openapi.json`: the read-only API reference and its document (owner decision 2026-11-08, #61). Only
 *   GET and HEAD, and without credentials: the console answers other methods itself with 405.
 */
const apiPrefix = /^\/(api|v1)(\/|$)/;
const healthPaths = new Set(['/health', '/livez', '/readyz']);
const referencePaths = new Set(['/docs', '/openapi.json']);

export const referenceMethods = ['GET', 'HEAD'] as const;

/** Request headers never forwarded with an API-reference request: the reference is public and credential-free. */
export const referenceStrippedHeaders = ['cookie', 'authorization', 'proxy-authorization'] as const;

export type ProxyDecision = 'console' | 'api' | 'reference' | 'method-not-allowed';

export function proxyDecision(pathname: string, method: string): ProxyDecision {
  if (apiPrefix.test(pathname) || healthPaths.has(pathname)) return 'api';
  if (!referencePaths.has(pathname)) return 'console';
  return (referenceMethods as readonly string[]).includes(method.toUpperCase()) ? 'reference' : 'method-not-allowed';
}

/** Whether any request to this path reaches the API listener (path allowlist only). */
export function isProxiedPath(pathname: string): boolean {
  return proxyDecision(pathname, 'GET') !== 'console';
}

/**
 * CSP for the proxied `/docs` page only. Scripts: exactly the pinned, integrity-checked Scalar bundle (see
 * apps/server/src/api-reference.ts) plus Scalar's one inline init script by hash; no other jsDelivr file and no other
 * inline script can run. Styles stay 'unsafe-inline' because the bundle injects its styles at runtime. The page may
 * fetch only this origin. The console's own pages keep the strict default. apps/server/src/api-reference.test.ts
 * fails if the bundle URL or the inline script changes without updating this policy.
 */
export const apiReferenceScriptSources = [
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0/dist/browser/standalone.js',
  "'sha256-fdA7IADxugqK4SkGwA9CdB5bfTF8Itgy8PRry3IMbnw='",
] as const;

export const apiReferenceContentSecurityPolicy = `default-src 'self'; script-src ${apiReferenceScriptSources.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`;
