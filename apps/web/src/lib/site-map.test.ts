import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { siteMap } from './site-map';

it('keeps route files and manifest paths in exact parity', () => {
  const routes = readdirSync('src/routes')
    .filter((name) => name.endsWith('.tsx') && name !== '__root.tsx')
    .map((name) => {
      const file = readFileSync(resolve('src/routes', name), 'utf8');
      const match = file.match(/createFileRoute\(['"]([^'"]+)['"]\)/);
      if (!match?.[1]) {
        throw new Error(`Missing route declaration: ${name}`);
      }
      return match[1] === '/' ? '/' : match[1].replace(/\/$/, '');
    });
  expect(routes.sort()).toEqual(siteMap.map((page) => page.path).sort());
  expect(new Set(siteMap.map((page) => page.ogSlug)).size).toBe(siteMap.length);
  expect(siteMap.filter((page) => page.inNav).map((page) => page.title)).toEqual([
    'Product',
    'Developers',
    'Self-host',
    'Cloud',
    'Open source',
    'Compare',
  ]);
});
it('defines the provisional domain only in env.ts', () => {
  const literal = ['logbird', 'dev'].join('.');
  const files = [
    ...readdirSync('src', { recursive: true })
      .map(String)
      .map((name) => resolve('src', name)),
    ...readdirSync('scripts', { recursive: true })
      .map(String)
      .map((name) => resolve('scripts', name)),
  ].filter((name) => /\.(ts|tsx|mjs)$/.test(name));
  const occurrences = files.filter((file) => readFileSync(file, 'utf8').includes(literal));
  expect(occurrences).toEqual([resolve('src/env.ts')]);
});
it('names no company or design partner anywhere in the site source (pending the owner)', () => {
  const files = [
    ...readdirSync('src', { recursive: true }).map((name) => resolve('src', String(name))),
    ...readdirSync('scripts', { recursive: true }).map((name) => resolve('scripts', String(name))),
    resolve('vite.config.ts'),
    resolve('server/waitlist.ts'),
  ]
    .filter((name) => /\.(ts|tsx|mjs)$/.test(name))
    .filter((name) => !name.endsWith('site-map.test.ts'));
  const pattern = new RegExp(['jo', 'od'].join(''), 'i');
  expect(files.filter((file) => pattern.test(readFileSync(file, 'utf8')))).toEqual([]);
});
