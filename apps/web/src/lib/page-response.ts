import { contentSecurityPolicy } from './security-headers';

/** The parts of `.output/csp.json` (src/lib/csp.ts) the Node server reads. */
export interface PageManifest {
  pages: Record<string, { file: string; scriptHashes: string[] }>;
  /** Exact, case-sensitive URL paths of the files Nitro's static handler serves (src/lib/csp.ts). */
  publicFiles: string[];
}

export type PageDecision =
  /** Nitro answers: a build-time public file through its static handler, or an /site-api/* route (JSON, never HTML). */
  | { kind: 'pass' }
  /** Serve this prerendered HTML file with its own hashed policy. */
  | { kind: 'page'; file: string; status: 200 | 404; policy: string }
  /** A method other than GET/HEAD outside /site-api/: 405, as static files can't take it (and the renderer mustn't). */
  | { kind: 'method-not-allowed' };

// The manifest's public files as a Set, built once per manifest object.
const publicSets = new WeakMap<PageManifest, ReadonlySet<string>>();
const publicSet = (manifest: PageManifest) => {
  let set = publicSets.get(manifest);
  if (!set) {
    set = new Set(manifest.publicFiles);
    publicSets.set(manifest, set);
  }
  return set;
};

/**
 * How the Node server answers a request, mirroring Cloudflare's static assets (wrangler.jsonc):
 *
 * - `/site-api/…` (the raw path, exactly as Nitro routes it) goes to Nitro, whose `/site-api/**` routes answer JSON only
 *   (server/waitlist.ts, server/api-not-found.ts);
 * - a prerendered page, by its URL or its file name, is served with its own hashed policy;
 * - a build-time public file goes to Nitro's static handler, but only when the canonical path (no `%2F`/`%5C`,
 *   `.`/`..` segments, `//` or backslashes) is in the manifest's case-exact list: the key that handler looks up.
 *   Filesystem existence is never consulted, since Windows and macOS ignore case (`/SITE-ASSETS/app.js`);
 * - everything else (unknown, dotted, escaped, traversing, case-variant or post-build paths) is 404.html with status
 *   404 and the 404 page's policy. Nothing reaches the on-demand renderer, whose inline scripts no build-time hash
 *   covers.
 */
export function decidePage({
  method,
  pathname,
  manifest,
}: {
  method: string;
  /** The raw request path, still percent-encoded. */
  pathname: string;
  manifest: PageManifest;
}): PageDecision {
  const notFound = manifest.pages['/404'];
  if (!notFound) {
    throw new Error('The CSP manifest has no /404 page. Rebuild: pnpm build ends with scripts/csp.ts.');
  }
  if (pathname.startsWith('/site-api/')) {
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
  if (publicSet(manifest).has(path)) {
    return { kind: 'pass' };
  }
  return page(notFound, 404);
}
