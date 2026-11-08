/**
 * Serves the prerendered site from .output/public the way Cloudflare's static assets do: files only, pre-compressed
 * .br/.gz variants when the client accepts them, each page with its own hashed Content-Security-Policy from
 * `.output/csp.json` (scripts/csp.ts), and `404.html` with status 404 for everything else. Requests are routed by the
 * same rules as the Node server (src/lib/page-response.ts), so escaped or traversing paths are 404s here too.
 * Use it for Lighthouse and captures of what actually ships. There is no /api here (the waitlist needs `pnpm start`).
 *
 *   PORT=4620 tsx scripts/serve-static.ts
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { CSP_MANIFEST_FILE, type CspManifest } from '../src/lib/csp';
import { decidePage } from '../src/lib/page-response';
import { ASSET_CACHE, MEDIA_CACHE, PAGE_CACHE, securityHeaders } from '../src/lib/security-headers';

const root = resolve('.output/public');
const manifest = JSON.parse(await readFile(resolve('.output', CSP_MANIFEST_FILE), 'utf8')) as CspManifest;
if (!Array.isArray(manifest.publicFiles)) {
  throw new Error('.output/csp.json predates the public-file list: rebuild (pnpm build ends with scripts/csp.ts).');
}
const port = Number(process.env.PORT ?? 4620);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function isFile(path: string) {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}
createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const decision = decidePage({ method: request.method ?? 'GET', pathname: url.pathname, manifest });
  if (decision.kind === 'method-not-allowed') {
    response.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' }).end();
    return;
  }
  const notFound = decidePage({ method: 'GET', pathname: '/__no-such-page__', manifest });
  // `pass` is a canonical public file or /api/*; there is no /api here, so that's the 404 page.
  const page = decision.kind === 'page' ? decision : url.pathname.startsWith('/api/') ? notFound : null;
  const found = page && page.kind === 'page' ? { file: resolve(root, page.file), status: page.status, policy: page.policy } : null;
  const target = found?.file ?? resolve(root, `.${decodeURIComponent(url.pathname)}`);
  const headers: Record<string, string> = {
    ...securityHeaders,
    ...(found ? { 'Content-Security-Policy': found.policy } : {}),
    'Content-Type': types[extname(target)] ?? 'application/octet-stream',
    Vary: 'Accept-Encoding',
    'Cache-Control': found
      ? PAGE_CACHE
      : url.pathname.startsWith('/assets/')
        ? ASSET_CACHE
        : url.pathname.startsWith('/media/')
          ? MEDIA_CACHE
          : PAGE_CACHE,
  };
  let file = target;
  const accepts = String(request.headers['accept-encoding'] ?? '');
  for (const [encoding, suffix] of [
    ['br', '.br'],
    ['gzip', '.gz'],
  ] as const) {
    if (accepts.includes(encoding) && (await isFile(`${target}${suffix}`))) {
      file = `${target}${suffix}`;
      headers['Content-Encoding'] = encoding;
      break;
    }
  }
  response.writeHead(found?.status ?? 200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`serve-static: http://127.0.0.1:${port} (${root})`));
