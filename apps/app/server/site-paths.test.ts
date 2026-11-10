import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { siteDecision, siteFiles, sitePrefixes, siteRoutePatterns, siteSegments } from './site-paths';

const decide = (pathname: string, method = 'GET', cookie?: string) => siteDecision({ pathname, method, cookie });
describe('marketing routing', () => {
  it('routes each segment and its descendants, exact files and prefixes', () => {
    for (const path of siteSegments) {
      for (const suffix of ['', '/', '/nested/page']) expect(decide(path + suffix), path + suffix).toBe('site');
      expect(decide(`${path}x`)).toBe('console');
      expect(decide(path.toUpperCase())).toBe('console');
    }
    for (const path of siteFiles) {
      expect(decide(path)).toBe('site');
      expect(decide(`${path}/x`)).toBe('console');
    }
    for (const path of sitePrefixes) expect(decide(`${path}file.js`)).toBe('site');
    for (const route of siteRoutePatterns) expect(decide(route.replace('/**', '/file.png'))).toBe('site');
  });
  it.each([undefined, '', 'other=x', 'logbird.session_token=', '__Secure-logbird.session_token=; other=x'])('anonymous root: %s', (cookie) => {
    expect(decide('/', 'GET', cookie)).toBe('site');
    expect(decide('/', 'HEAD', cookie)).toBe('site');
  });
  it.each([
    'logbird.session_token=x',
    '__Secure-logbird.session_token=x',
    'other=x; logbird.session_token=x',
    'logbird.session_token=; __Secure-logbird.session_token=x',
  ])('signed-in root: %s', (cookie) => {
    expect(decide('/', 'GET', cookie)).toBe('console');
    expect(decide('/product', 'GET', cookie)).toBe('site');
  });
  it.each([
    '/product%2fsecret',
    '/product/%5Csecret',
    '/product%2Fsecret',
    '/product\\secret',
    '/product//x',
    '//product',
    '/product/./x',
    '/product/../x',
    '/product/%2e/x',
    '/product/%2E%2e/x',
    '/product/%',
    '/Product',
    '/brand/logbird-favicon.svg',
    '/favicon.svg',
    '/api/waitlist',
    '/login',
    '/site-api',
    '/site-assets',
  ])('keeps ambiguous or console path %s', (path) => {
    expect(decide(path)).toBe('console');
  });
  it('allows GET/HEAD everywhere and POST only in the site API', () => {
    for (const path of ['/', ...siteSegments, ...siteFiles, ...sitePrefixes.map((p) => `${p}x`)]) {
      expect(decide(path, 'HEAD')).toBe('site');
      expect(decide(path, 'get')).toBe('site');
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
        expect(decide(path, method), `${method} ${path}`).toBe(method === 'POST' && path.startsWith('/site-api/') ? 'site' : 'console');
      }
    }
  });
});

it('has no console route top-level collision with the site namespace', () => {
  const tree = readFileSync(resolve('src/routeTree.gen.ts'), 'utf8');
  // Full-path interface keys include every console route, including pathless layout descendants.
  const interfaceBody = tree.split('export interface FileRoutesByFullPath {')[1]?.split('}')[0] ?? '';
  const routePaths = [...interfaceBody.matchAll(/^ {2}['"](\/[^'"]*)['"]:/gm)].map((match) => match[1]);
  expect(routePaths.length).toBeGreaterThan(5);
  for (const path of routePaths) {
    if (!path || path === '/') continue;
    const top = `/${path.split('/')[1]}`;
    expect([...siteSegments, ...sitePrefixes.map((prefix) => prefix.slice(0, -1))], path).not.toContain(top);
  }
});

it('serves every shared brand file byte-identically from the console', () => {
  const source = resolve('../web/public/brand');
  const files = readdirSync(source, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  expect(files.length).toBeGreaterThan(0);
  for (const entry of files) {
    const file = resolve(entry.parentPath, entry.name);
    const relative = file.slice(source.length + 1);
    expect(readFileSync(resolve('public/brand', relative)), relative).toEqual(readFileSync(file));
  }
});
