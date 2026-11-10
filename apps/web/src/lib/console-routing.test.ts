import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { siteDecision } from '../../../app/server/site-paths';
import { prerenderPaths } from './site-map';

it('forwards every prerendered page and public site namespace through the console', () => {
  const publicEntries = readdirSync(resolve('public'), { withFileTypes: true });
  expect(publicEntries.length).toBeGreaterThan(0);
  const paths = [
    ...prerenderPaths,
    '/404.html',
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/site-assets/build.js',
    '/site-assets/manifest.json',
    '/site-api/waitlist',
    '/media/capture.webp',
    '/og/home.png',
  ];
  for (const entry of publicEntries) {
    // Shared console assets intentionally stay on the front door; app/server tests assert identical bytes.
    if (entry.name === 'brand' || entry.name === 'favicon.svg') continue;
    paths.push(`/${entry.name}${entry.isDirectory() ? '/file' : ''}`);
  }
  for (const pathname of paths) expect(siteDecision({ pathname, method: 'GET' }), pathname).toBe('site');
  // After a build, also check every emitted public file (including newly introduced generated namespaces).
  const manifestPath = resolve('.output/csp.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { publicFiles: string[] };
    for (const pathname of manifest.publicFiles) {
      if (pathname.startsWith('/brand/') || pathname === '/favicon.svg') continue;
      expect(siteDecision({ pathname, method: 'GET' }), pathname).toBe('site');
    }
  }
});
