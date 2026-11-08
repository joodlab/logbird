import { statSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineEventHandler } from 'nitro/h3';
import { decidePage, type PageManifest } from '../src/lib/page-response';
import { PAGE_CACHE } from '../src/lib/security-headers';

/**
 * Node server only (vite.config.ts registers it for node-server builds, never in dev or on Cloudflare). Answers every
 * GET/HEAD the way Cloudflare's static assets do (src/lib/page-response.ts): the prerendered page with its own hashed
 * Content-Security-Policy from `.output/csp.json`, an existing public file through Nitro, the waitlist API through
 * Nitro, and 404.html (status 404, the 404 page's policy) for every other path, dotted or not.
 *
 * Nitro's own static handler can't serve the pages: its asset list is fixed before TanStack Start prerenders, so the
 * server would render each page again per request, and every render carries a fresh hydration timestamp that no
 * build-time hash can match.
 */
const main = (globalThis as { __nitro_main__?: string }).__nitro_main__ ?? import.meta.url;
const outputDir = resolve(dirname(fileURLToPath(main)), '..');
const publicDir = resolve(outputDir, 'public');

let manifest: Promise<PageManifest> | undefined;
function loadManifest() {
  manifest ??= readFile(resolve(outputDir, 'csp.json'), 'utf8')
    .then((text) => JSON.parse(text) as PageManifest)
    .catch((error: unknown) => {
      manifest = undefined;
      throw new Error(`Missing ${resolve(outputDir, 'csp.json')}: run pnpm build (it ends with scripts/csp.ts) before pnpm start.`, {
        cause: error,
      });
    });
  return manifest;
}

/** A regular file inside .output/public at this decoded URL path (never outside it). */
function isPublicFile(decodedPath: string) {
  const file = resolve(publicDir, `.${decodedPath}`);
  if (!file.startsWith(publicDir + sep)) {
    return false;
  }
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
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
  const decision = decidePage({
    method: event.req.method,
    pathname: event.url.pathname,
    manifest: await loadManifest(),
    isPublicFile,
  });
  if (decision.kind === 'pass') {
    return;
  }
  let file = resolve(publicDir, decision.file);
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
  event.res.status = decision.status;
  event.res.headers.set('Content-Security-Policy', decision.policy);
  event.res.headers.set('Content-Type', 'text/html; charset=utf-8');
  event.res.headers.set('Cache-Control', PAGE_CACHE);
  event.res.headers.set('Vary', 'Accept-Encoding');
  if (encoding) {
    event.res.headers.set('Content-Encoding', encoding);
  }
  return event.req.method === 'HEAD' ? '' : await readFile(file);
});
