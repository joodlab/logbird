import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inlineScripts, scriptHash, scriptSources, writeCsp } from '../lib/csp';
import { decidePage } from '../lib/page-response';
import { securityHeaders } from '../lib/security-headers';

/**
 * The Node server's page middleware (server/static-pages.ts), called as Nitro calls it, against a fictional build in a
 * temporary `.output`. Every response that carries HTML must carry the policy that covers that HTML's inline scripts.
 */
const page = (name: string) =>
  `<!DOCTYPE html><html><head><script>document.documentElement.className='light'</script></head><body>${name}` +
  `<script class="$tsr">self.$_TSR={page:"${name}",id:"__root__\0"}</script><script type="module" src="/site-assets/app.js"></script></body></html>`;
const files: Record<string, string> = {
  'index.html': page('Home'),
  'about/index.html': page('About'),
  '404.html': page('Not found'),
  'site-assets/app.js': 'console.log("app")',
  'robots.txt': 'User-agent: *\nDisallow: /\n',
  // Written after Nitro listed its assets (compress-html, scripts/csp.ts): never served as files.
  'about/index.html.br': 'not really brotli',
  'sitemap.xml.gz': 'not really gzip',
};

type Handler = (event: unknown) => Promise<unknown>;
const handlerOf = (module: { default: Handler | { handler: Handler } }) =>
  typeof module.default === 'function' ? module.default : module.default.handler;
let output: string;
let handler: Handler;

beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), 'logbird-web-node-'));
  for (const [file, body] of Object.entries(files)) {
    await mkdir(dirname(join(output, 'public', file)), { recursive: true });
    await writeFile(join(output, 'public', file), body);
  }
  await writeCsp(output);
  // The middleware finds .output from Nitro's entry point, as in `node .output/server/index.mjs`.
  (globalThis as { __nitro_main__?: string }).__nitro_main__ = pathToFileURL(join(output, 'server', 'index.mjs')).href;
  vi.resetModules();
  handler = handlerOf((await import('../../server/static-pages')) as { default: Handler | { handler: Handler } });
});
afterAll(async () => {
  delete (globalThis as { __nitro_main__?: string }).__nitro_main__;
  await rm(output, { recursive: true, force: true });
});

async function request(path: string, method = 'GET') {
  const url = new URL(path, 'http://127.0.0.1:4620');
  const event = { req: new Request(url, { method }), url, res: { status: 200, headers: new Headers() } };
  const body = await handler(event);
  return { body, status: event.res.status, headers: event.res.headers };
}

/**
 * The response is the given HTML file, with a policy covering every inline script in it, no 'unsafe-inline', and the
 * other security headers.
 */
async function expectPage(path: string, file: string, status: number) {
  const response = await request(path);
  const html = await readFile(join(output, 'public', file), 'utf8');
  expect(response.status, path).toBe(status);
  expect(Buffer.from(response.body as Uint8Array).toString('utf8'), path).toBe(html);
  const sources = scriptSources(response.headers.get('content-security-policy') ?? undefined);
  expect(sources, path).not.toBeNull();
  expect(sources).not.toContain("'unsafe-inline'");
  for (const script of inlineScripts(html)) {
    expect(sources, `${path}: ${script.slice(0, 30)}`).toContain(`'${scriptHash(script)}'`);
  }
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  // Set by the middleware itself, not left to the routeRules middleware's order.
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (name !== 'Content-Security-Policy') {
      expect(response.headers.get(name), `${path}: ${name}`).toBe(value);
    }
  }
}

describe('Node server pages', () => {
  it('serves each prerendered page with its own policy and the security headers', async () => {
    await expectPage('/', 'index.html', 200);
    await expectPage('/about', 'about/index.html', 200);
    await expectPage('/about/', 'about/index.html', 200);
    await expectPage('/about/index.html', 'about/index.html', 200);
    await expectPage('/404.html', '404.html', 200);
  });

  it('answers every other path with the 404 page and its policy', async () => {
    for (const path of [
      '/no-such-page',
      '/foo.bar',
      '/x.js',
      '/blog/no-such-post.md',
      '/no-such-page.ext',
      '/site-assets/missing.js',
      '/site-assets/',
      '/%E0%A4%A',
      '/..%2F..%2Fpackage.json',
      '/about/index.html/x',
      // Escaped separators and traversal that would resolve back to a real page or asset: Nitro looks these up
      // verbatim and would hand them to the renderer.
      '/x%2f..%2fabout%2findex.html',
      '/x%2F..%2Fsite-assets%2Fapp.js',
      '/site-assets%2fapp.js',
      '/site-assets%5capp.js',
      '/x/%2e%2e%2fabout',
      '//site-assets/app.js',
      '/site-assets//app.js',
      '/site-assets/app.js%00',
      // API look-alikes that Nitro doesn't route to /site-api/**.
      '/site-api',
      '/site-api%2fwaitlist',
      '/SITE-API/waitlist',
      '/%61pi/waitlist',
      // Post-build files.
      '/_headers',
      '/about/index.html.br',
      '/sitemap.xml.gz',
      // Case variants: Windows and macOS file systems would find these files, Nitro's case-exact asset table doesn't.
      '/SITE-ASSETS/app.js',
      '/site-assets/APP.JS',
      '/Site-assets/App.js',
      '/ROBOTS.TXT',
      '/About/index.html',
      '/ABOUT/INDEX.HTML',
      '/About',
      '/_HEADERS',
      '/About/Index.Html.Br',
      '/INDEX.HTML',
    ]) {
      await expectPage(path, '404.html', 404);
    }
  });

  it('leaves canonical build-time public files and /site-api/* to Nitro', async () => {
    for (const [path, method] of [
      ['/site-assets/app.js', 'GET'],
      ['/site-assets/app.js', 'HEAD'],
      ['/robots.txt', 'GET'],
      ['/site-api/waitlist', 'GET'],
      ['/site-api/waitlist', 'POST'],
      ['/site-api/no-such-endpoint', 'GET'],
      ['/site-api/no-such-endpoint', 'DELETE'],
    ] as const) {
      const response = await request(path, method);
      expect(response.body, `${method} ${path}`).toBeUndefined();
      expect(response.headers.get('content-security-policy'), `${method} ${path}`).toBeNull();
    }
  });

  it('answers other methods on pages with 405, never the renderer', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = (await request('/about', method)).body as Response;
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('answers HEAD with the headers and no body', async () => {
    const response = await request('/x.js', 'HEAD');
    expect(response.status).toBe(404);
    expect(response.body).toBe('');
    expect(response.headers.get('content-security-policy')).toContain("'sha256-");
  });
});

describe('decidePage', () => {
  const manifest = {
    pages: { '/': { file: 'index.html', scriptHashes: ['sha256-a='] }, '/404': { file: '404.html', scriptHashes: ['sha256-b='] } },
    publicFiles: ['/site-assets/app.js', '/robots.txt'],
  };
  const decide = (pathname: string, method = 'GET') => decidePage({ method, pathname, manifest });
  it('passes only case-exact listed public files and the raw /site-api/ prefix', () => {
    expect(decide('/site-assets/app.js')).toEqual({ kind: 'pass' });
    expect(decide('/site-assets/app.js/')).toEqual({ kind: 'pass' });
    expect(decide('/site-assets/app%2Ejs')).toEqual({ kind: 'pass' });
    for (const path of [
      '/SITE-ASSETS/app.js',
      '/site-assets/App.js',
      '/Robots.txt',
      '/x.y',
      '/x%2Fy.js',
      '/site-assets/./app.js',
      '/site-api',
      '/site-apix',
      '/INDEX.HTML',
    ]) {
      expect(decide(path), path).toMatchObject({ kind: 'page', status: 404, file: '404.html' });
    }
    expect(decide('/site-api/x')).toEqual({ kind: 'pass' });
    expect(decide('/', 'POST')).toEqual({ kind: 'method-not-allowed' });
    expect(() => decidePage({ method: 'GET', pathname: '/', manifest: { pages: {}, publicFiles: [] } })).toThrow('no /404 page');
  });
});

describe('build manifest public files', () => {
  it('lists every build-time file with its exact case, and nothing written after Nitro listed its assets', async () => {
    const manifest = JSON.parse(await readFile(join(output, 'csp.json'), 'utf8'));
    expect(manifest.publicFiles).toEqual(['/robots.txt', '/site-assets/app.js']);
  });
});

describe('method guard (every preset)', () => {
  it('answers 405 for other methods outside /site-api/, and lets GET, HEAD and /site-api/* through', async () => {
    const guard = handlerOf((await import('../../server/method-guard')) as unknown as { default: Handler | { handler: Handler } });
    const call = (path: string, method: string) => {
      const url = new URL(path, 'http://127.0.0.1:4621');
      return guard({ req: new Request(url, { method }), url }) as Promise<Response | undefined> | Response | undefined;
    };
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = (await call('/about/', method)) as Response;
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
    }
    expect(await call('/about/', 'GET')).toBeUndefined();
    expect(await call('/about/', 'HEAD')).toBeUndefined();
    expect(await call('/site-api/waitlist', 'POST')).toBeUndefined();
  });
});

describe('API catch-all', () => {
  it('answers unknown /site-api/* paths with JSON, never HTML', async () => {
    const apiHandler = handlerOf((await import('../../server/api-not-found')) as unknown as { default: Handler | { handler: Handler } });
    const response = (await apiHandler({})) as Response;
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'No such API endpoint.' } });
  });
});
