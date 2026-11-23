import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { computeAssetVersions, computeOgDesignVersion } from '../../scripts/asset-versions-lib';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
import { ASSET_VERSIONS, OG_DESIGN_VERSION } from './asset-versions';
import { prerenderPaths } from './site-map';

/**
 * /media/* is cached for a day (plus a week stale) at the CDN and in browsers, so a file replaced under the same name
 * would keep serving the old bytes. Every URL to a fixed-name file carries its content version (src/lib/asset-url.ts).
 */
it('the committed versions, manifest and OG design version match the sources (run pnpm assets:versions)', async () => {
  const { versions, manifestText } = await computeAssetVersions();
  expect(ASSET_VERSIONS).toEqual(versions);
  expect(readFileSync(fileURLToPath(new URL('../../public/site.webmanifest', import.meta.url)), 'utf8')).toBe(manifestText);
  expect(OG_DESIGN_VERSION).toBe(await computeOgDesignVersion());
});

it('every media, card, brand and manifest URL a page writes carries its content version', async () => {
  quietHrefWarnings();
  const pages = await renderPages(prerenderPaths);
  let media = 0;
  for (const { path, html } of pages) {
    for (const [url] of html.matchAll(/\/(?:media|brand)\/[^\s"',)]+|\/site\.webmanifest[^\s"',)]*/g)) {
      if (url.startsWith('/media/')) media++;
      expect(url, `${path}: ${url}`).toMatch(/\?v=[0-9a-f]{10}$/);
    }
    for (const [url] of html.matchAll(/\/og\/[^\s"',)]+/g)) {
      expect(url, `${path}: ${url}`).toMatch(/\.png\?v=[0-9a-f]{8}$/);
    }
    expect(html, path).toMatch(/rel="icon"[^>]*href="\/brand\/logbird-favicon\.svg\?v=/);
    expect(html, path).toMatch(/rel="manifest"[^>]*href="\/site\.webmanifest\?v=/);
  }
  expect(media).toBeGreaterThan(50);
}, 120_000);
