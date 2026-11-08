/**
 * Which request paths the console forwards to the private API listener. Everything else is served by the console
 * (pages, assets) and every other API path stays private, so adding a public server route needs a change here.
 *
 * - `/api/*` and `/v1/*`: the internal and public APIs.
 * - `/health`, `/livez`, `/readyz`: operational checks.
 * - `/docs` and `/openapi.json`: the read-only API reference and its document (owner decision 2026-11-08, #61).
 */
const exactPaths = new Set(['/health', '/livez', '/readyz', '/docs', '/openapi.json']);

export function isProxiedPath(pathname: string): boolean {
  return /^\/(api|v1)(\/|$)/.test(pathname) || exactPaths.has(pathname);
}

/**
 * CSP for the proxied `/docs` page only. The API reference UI is a pinned, integrity-checked script from jsDelivr (see
 * apps/server/src/api-reference.ts); it may fetch only this origin. The console's own pages keep the strict default.
 */
export const apiReferenceContentSecurityPolicy =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";
