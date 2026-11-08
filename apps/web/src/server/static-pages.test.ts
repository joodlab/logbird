import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inlineScripts, scriptHash, scriptSources, writeCsp } from '../lib/csp';
import { decidePage } from '../lib/page-response';

/**
 * The Node server's page middleware (server/static-pages.ts), called as Nitro calls it, against a fictional build in a
 * temporary `.output`. Every response that carries HTML must carry the policy that covers that HTML's inline scripts.
 */
const page = (name: string) =>
  `<!DOCTYPE html><html><head><script>document.documentElement.className='light'</script></head><body>${name}` +
  `<script class="$tsr">self.$_TSR={page:"${name}",id:"__root__\0"}</script><script type="module" src="/assets/app.js"></script></body></html>`;
const files: Record<string, string> = {
  'index.html': page('Home'),
  'about/index.html': page('About'),
  '404.html': page('Not found'),
  'assets/app.js': 'console.log("app")',
  'robots.txt': 'User-agent: *\nDisallow: /\n',
};

type Handler = (event: unknown) => Promise<unknown>;
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
  const module = (await import('../../server/static-pages')) as { default: Handler | { handler: Handler } };
  handler = typeof module.default === 'function' ? module.default : module.default.handler;
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

/** The response is the given HTML file, with a policy covering every inline script in it and no 'unsafe-inline'. */
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
}

describe('Node server pages', () => {
  it('serves each prerendered page with its own policy', async () => {
    await expectPage('/', 'index.html', 200);
    await expectPage('/about', 'about/index.html', 200);
    await expectPage('/about/', 'about/index.html', 200);
    await expectPage('/about/index.html', 'about/index.html', 200);
    await expectPage('/404.html', '404.html', 200);
  });

  it('answers every other path with the 404 page and its policy, dotted or not', async () => {
    for (const path of [
      '/no-such-page',
      '/foo.bar',
      '/x.js',
      '/blog/no-such-post.md',
      '/no-such-page.ext',
      '/assets/missing.js',
      '/assets/',
      '/%E0%A4%A',
      '/..%2F..%2Fpackage.json',
      '/about/index.html/x',
    ]) {
      await expectPage(path, '404.html', 404);
    }
  });

  it('leaves existing public files, the waitlist API and other methods to Nitro', async () => {
    for (const [path, method] of [
      ['/assets/app.js', 'GET'],
      ['/robots.txt', 'GET'],
      ['/api/waitlist', 'GET'],
      ['/api/waitlist', 'POST'],
      ['/about', 'POST'],
    ] as const) {
      const response = await request(path, method);
      expect(response.body, `${method} ${path}`).toBeUndefined();
      expect(response.headers.get('content-security-policy'), `${method} ${path}`).toBeNull();
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
  const manifest = { pages: { '/': { file: 'index.html', scriptHashes: ['sha256-a='] }, '/404': { file: '404.html', scriptHashes: ['sha256-b='] } } };
  it('never returns pass for an unknown GET path, only for public files and the API', () => {
    const none = () => false;
    expect(decidePage({ method: 'GET', pathname: '/x.y', manifest, isPublicFile: none })).toMatchObject({
      kind: 'page',
      status: 404,
      file: '404.html',
    });
    expect(decidePage({ method: 'GET', pathname: '/x.y', manifest, isPublicFile: () => true })).toEqual({ kind: 'pass' });
    expect(decidePage({ method: 'GET', pathname: '/api', manifest, isPublicFile: none })).toEqual({ kind: 'pass' });
    expect(decidePage({ method: 'GET', pathname: '/apix', manifest, isPublicFile: none })).toMatchObject({ status: 404 });
    expect(() => decidePage({ method: 'GET', pathname: '/', manifest: { pages: {} }, isPublicFile: none })).toThrow('no /404 page');
  });
});
