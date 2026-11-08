/**
 * Serves the prerendered site from .output/public the way Cloudflare's static assets do: files only, pre-compressed
 * .br/.gz variants when the client accepts them, `/x` → `/x/index.html`, and `404.html` with status 404.
 * Each page gets its own hashed Content-Security-Policy from `.output/csp.json` (scripts/csp.ts), as on Cloudflare.
 * Use it for Lighthouse and captures of what actually ships. There is no /api here (the waitlist needs `pnpm start`).
 *
 *   PORT=4620 tsx scripts/serve-static.ts
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { CSP_MANIFEST_FILE, type CspManifest } from '../src/lib/csp';
import { ASSET_CACHE, contentSecurityPolicy, MEDIA_CACHE, PAGE_CACHE, securityHeaders } from '../src/lib/security-headers';

const root = resolve('.output/public');
const manifest = JSON.parse(await readFile(resolve('.output', CSP_MANIFEST_FILE), 'utf8')) as CspManifest;
// HTML file (relative to root) → its hashed policy.
const policies = new Map(Object.values(manifest.pages).map((page) => [page.file, contentSecurityPolicy(page.scriptHashes)]));
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

async function locate(pathname: string): Promise<{ file: string; status: number } | null> {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const base = join(root, safe);
  if (!base.startsWith(root)) {
    return null;
  }
  for (const candidate of [base, join(base, 'index.html'), `${base}.html`]) {
    if (await isFile(candidate)) {
      return { file: candidate, status: 200 };
    }
  }
  return { file: join(root, '404.html'), status: 404 };
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const found = await locate(url.pathname);
  if (!found) {
    response.writeHead(400).end();
    return;
  }
  const accepts = String(request.headers['accept-encoding'] ?? '');
  let file = found.file;
  const policy = policies.get(relative(root, found.file).replaceAll('\\', '/'));
  if (found.file.endsWith('.html') && !policy) {
    response.writeHead(500).end('No CSP for this page: rebuild (pnpm build ends with scripts/csp.ts).');
    return;
  }
  const headers: Record<string, string> = {
    ...securityHeaders,
    ...(policy ? { 'Content-Security-Policy': policy } : {}),
    'Content-Type': types[extname(found.file)] ?? 'application/octet-stream',
    Vary: 'Accept-Encoding',
    'Cache-Control': url.pathname.startsWith('/assets/') ? ASSET_CACHE : url.pathname.startsWith('/media/') ? MEDIA_CACHE : PAGE_CACHE,
  };
  for (const [encoding, suffix] of [
    ['br', '.br'],
    ['gzip', '.gz'],
  ] as const) {
    if (accepts.includes(encoding) && (await isFile(`${found.file}${suffix}`))) {
      file = `${found.file}${suffix}`;
      headers['Content-Encoding'] = encoding;
      break;
    }
  }
  response.writeHead(found.status, headers);
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`serve-static: http://127.0.0.1:${port} (${root})`));
