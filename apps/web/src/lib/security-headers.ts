/**
 * The site's Content-Security-Policy. Scripts run only from our origin or as inline scripts whose sha256 hash is
 * listed: every page is prerendered, so scripts/csp.ts hashes each page's inline scripts (the theme bootstrap, JSON-LD
 * and TanStack Start's hydration data) after the build and serves each page its own list (`_headers` on Cloudflare,
 * server/static-pages.ts for the Node server, scripts/serve-static.ts locally). No `'unsafe-inline'` for scripts.
 *
 * `style-src 'unsafe-inline'` stays until the runtime styles are reviewed separately (#84).
 */
export function contentSecurityPolicy(scriptHashes: readonly string[] = []) {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...scriptHashes.map((hash) => `'${hash}'`)].join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * `vite dev` only: pages are rendered on demand there (no prerendered HTML to hash) and Vite injects inline scripts
 * for HMR, so the dev server keeps `'unsafe-inline'`. Never used for a build.
 */
export const DEV_CONTENT_SECURITY_POLICY = contentSecurityPolicy().replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");

/**
 * Response headers for every response (Nitro routeRules, Cloudflare `_headers`, scripts/serve-static.ts). The CSP here
 * allows no inline script at all: it covers non-page responses (assets, the waitlist API). Pages replace it with
 * their own hashed policy.
 */
export const securityHeaders = {
  'Content-Security-Policy': contentSecurityPolicy(),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // No includeSubDomains until the domain (and the console's subdomain) is decided.
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/** Media keeps stable URLs (scripts/media.ts), so a replaced capture must be able to reach browsers: a day, never immutable. */
export const MEDIA_CACHE = 'public, max-age=86400, stale-while-revalidate=604800';
/** Hashed build assets. */
export const ASSET_CACHE = 'public, max-age=31536000, immutable';
/** Prerendered HTML: revalidate on every visit, so a deploy is visible at once. */
export const PAGE_CACHE = 'public, max-age=0, must-revalidate';
