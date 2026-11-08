import { contentSecurityPolicy } from './security-headers';

/** The parts of `.output/csp.json` (src/lib/csp.ts) the Node server reads. */
export interface PageManifest {
  pages: Record<string, { file: string; scriptHashes: string[] }>;
}

export type PageDecision =
  /** Nitro answers: a build-time public file through its static handler, or an /api/* route (JSON, never HTML). */
  | { kind: 'pass' }
  /** Serve this prerendered HTML file with its own hashed policy. */
  | { kind: 'page'; file: string; status: 200 | 404; policy: string }
  /** A method other than GET/HEAD outside /api/: 405, as static files can't take it (and the renderer mustn't). */
  | { kind: 'method-not-allowed' };

/**
 * Files written into `.output/public` after Nitro listed its static assets: Nitro doesn't know them, so a request for
 * one would reach the on-demand renderer. Browsers never ask for them directly; they are 404s here as on Cloudflare,
 * which never serves `_headers`.
 */
const POST_BUILD_FILE = /(?:^|\/)_(?:headers|redirects)$|\.(?:br|gz)$/;

/**
 * How the Node server answers a request, mirroring Cloudflare's static assets (wrangler.jsonc):
 *
 * - `/api/…` (the raw path, exactly as Nitro routes it) goes to Nitro, whose `/api/**` routes answer JSON only
 *   (server/waitlist.ts, server/api-not-found.ts);
 * - a prerendered page, by its URL or its file name, is served with its own hashed policy;
 * - an existing build-time public file goes to Nitro's static handler, but only for a canonical path, the one key that
 *   handler looks up (no `%2F`/`%5C`, `.`/`..` segments, `//` or backslashes);
 * - everything else (unknown, dotted, escaped, traversing or post-build paths) is 404.html with status 404 and the 404
 *   page's policy. Nothing reaches the on-demand renderer, whose inline scripts no build-time hash covers.
 */
export function decidePage({
  method,
  pathname,
  manifest,
  isPublicFile,
}: {
  method: string;
  /** The raw request path, still percent-encoded. */
  pathname: string;
  manifest: PageManifest;
  /** True when `.output/public` has a regular file at this decoded, canonical path. */
  isPublicFile: (decodedPath: string) => boolean;
}): PageDecision {
  const notFound = manifest.pages['/404'];
  if (!notFound) {
    throw new Error('The CSP manifest has no /404 page. Rebuild: pnpm build ends with scripts/csp.ts.');
  }
  if (pathname.startsWith('/api/')) {
    return { kind: 'pass' };
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return { kind: 'method-not-allowed' };
  }
  const page = (entry: { file: string; scriptHashes: string[] }, status: 200 | 404): PageDecision => ({
    kind: 'page',
    file: entry.file,
    status,
    policy: contentSecurityPolicy(entry.scriptHashes),
  });
  // Encoded separators make the decoded path differ from the key Nitro looks up; there's no legitimate use for them.
  if (/%(?:2f|5c|00)/i.test(pathname)) {
    return page(notFound, 404);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return page(notFound, 404);
  }
  const segments = decoded.split('/').slice(1);
  const canonical =
    decoded.startsWith('/') &&
    !decoded.includes('\\') &&
    !decoded.includes('\0') &&
    segments.every((segment, index) => segment !== '.' && segment !== '..' && (segment !== '' || index === segments.length - 1));
  if (!canonical) {
    return page(notFound, 404);
  }
  const path = decoded.replace(/\/$/, '') || '/';
  const byPath = manifest.pages[path];
  if (byPath) {
    return page(byPath, 200);
  }
  // `/about/index.html` or `/404.html`: the page file itself, never Nitro's renderer.
  const byFile = Object.values(manifest.pages).find((entry) => `/${entry.file}` === path);
  if (byFile) {
    return page(byFile, 200);
  }
  if (!POST_BUILD_FILE.test(path) && isPublicFile(path)) {
    return { kind: 'pass' };
  }
  return page(notFound, 404);
}
