import { contentSecurityPolicy } from './security-headers';

/** The parts of `.output/csp.json` (src/lib/csp.ts) the Node server reads. */
export interface PageManifest {
  pages: Record<string, { file: string; scriptHashes: string[] }>;
}

export type PageDecision =
  /** Not a page request: Nitro handles it (an existing public file, the waitlist API, or a non-GET/HEAD method). */
  | { kind: 'pass' }
  /** Serve this prerendered HTML file with its own hashed policy. */
  | { kind: 'page'; file: string; status: 200 | 404; policy: string };

/**
 * How the Node server answers a request, mirroring Cloudflare's static assets (wrangler.jsonc): a prerendered page by
 * its URL (or its file name), an existing public file as itself, and everything else, dotted or not (`/x.js`,
 * `/blog/no-such-post.md`, a malformed escape), as 404.html with status 404 and the 404 page's policy. Nothing falls
 * through to on-demand rendering, whose inline scripts no build-time hash covers.
 */
export function decidePage({
  method,
  pathname,
  manifest,
  isPublicFile,
}: {
  method: string;
  pathname: string;
  manifest: PageManifest;
  /** True when `.output/public` has a file at this decoded path (Nitro's static handler serves it). */
  isPublicFile: (decodedPath: string) => boolean;
}): PageDecision {
  if (method !== 'GET' && method !== 'HEAD') {
    return { kind: 'pass' };
  }
  const page = (entry: { file: string; scriptHashes: string[] }, status: 200 | 404): PageDecision => ({
    kind: 'page',
    file: entry.file,
    status,
    policy: contentSecurityPolicy(entry.scriptHashes),
  });
  const notFound = manifest.pages['/404'];
  if (!notFound) {
    throw new Error('The CSP manifest has no /404 page. Rebuild: pnpm build ends with scripts/csp.ts.');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return page(notFound, 404);
  }
  if (decoded === '/api' || decoded.startsWith('/api/')) {
    return { kind: 'pass' };
  }
  const path = decoded.replace(/\/+$/, '') || '/';
  const byPath = manifest.pages[path];
  if (byPath) {
    return page(byPath, 200);
  }
  // `/about/index.html` or `/404.html`: the page file itself, never Nitro's renderer.
  const byFile = Object.values(manifest.pages).find((entry) => `/${entry.file}` === decoded);
  if (byFile) {
    return page(byFile, 200);
  }
  if (isPublicFile(decoded)) {
    return { kind: 'pass' };
  }
  return page(notFound, 404);
}
