import { access, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineEventHandler } from 'nitro/h3';
import type { CspManifest } from '../src/lib/csp';
import { contentSecurityPolicy, PAGE_CACHE } from '../src/lib/security-headers';

/**
 * Node server only (vite.config.ts registers it for node-server builds, never in dev or on Cloudflare). Serves the
 * prerendered page for each path, with that page's hashed Content-Security-Policy from `.output/csp.json`: the same
 * bytes and policy Cloudflare serves. Unknown page paths get 404.html with status 404, as on Cloudflare.
 *
 * Nitro's own static handler can't do this: its asset list is fixed before TanStack Start prerenders, so the server
 * would render each page again per request, and every render carries a fresh hydration timestamp that no build-time
 * hash can match. Files (paths with an extension) and /api/* fall through to Nitro.
 */
const main = (globalThis as { __nitro_main__?: string }).__nitro_main__ ?? import.meta.url;
const outputDir = resolve(dirname(fileURLToPath(main)), '..');

let manifest: Promise<CspManifest> | undefined;
function loadManifest() {
  manifest ??= readFile(resolve(outputDir, 'csp.json'), 'utf8')
    .then((text) => JSON.parse(text) as CspManifest)
    .catch((error: unknown) => {
      manifest = undefined;
      throw new Error(`Missing ${resolve(outputDir, 'csp.json')}: run pnpm build (it ends with scripts/csp.ts) before pnpm start.`, {
        cause: error,
      });
    });
  return manifest;
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

export default defineEventHandler(async (event) => {
  // During the build TanStack Start prerenders through this server; let it render.
  if (process.env.TSS_PRERENDERING === 'true') {
    return;
  }
  const method = event.req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(event.url.pathname).replace(/\/+$/, '') || '/';
  } catch {
    return;
  }
  if (pathname.startsWith('/api/')) {
    return;
  }
  const { pages } = await loadManifest();
  let page = pages[pathname];
  let status = 200;
  if (!page) {
    if (extname(pathname)) {
      return;
    }
    page = pages['/404'];
    status = 404;
  }
  if (!page) {
    return;
  }
  let file = resolve(outputDir, 'public', page.file);
  const accepts = event.req.headers.get('accept-encoding') ?? '';
  let encoding: string | undefined;
  for (const [name, suffix] of [
    ['br', '.br'],
    ['gzip', '.gz'],
  ] as const) {
    if (accepts.includes(name) && (await exists(`${file}${suffix}`))) {
      file = `${file}${suffix}`;
      encoding = name;
      break;
    }
  }
  event.res.status = status;
  event.res.headers.set('Content-Security-Policy', contentSecurityPolicy(page.scriptHashes));
  event.res.headers.set('Content-Type', 'text/html; charset=utf-8');
  event.res.headers.set('Cache-Control', PAGE_CACHE);
  event.res.headers.set('Vary', 'Accept-Encoding');
  if (encoding) {
    event.res.headers.set('Content-Encoding', encoding);
  }
  return method === 'HEAD' ? '' : await readFile(file);
});
