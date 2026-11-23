import { expect, it } from 'vitest';
import { computeMediaVersions } from '../../scripts/media-versions-lib';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
import { MEDIA_VERSIONS } from './media-versions';
import { prerenderPaths } from './site-map';

/**
 * /media/* is cached for a day (plus a week stale) at the CDN and in browsers, so a file replaced under the same name
 * would keep serving the old bytes. Every media URL carries its content version instead (src/lib/media-url.ts).
 */
it('the committed media versions match the sources (run pnpm media:versions after a recapture)', async () => {
  expect(MEDIA_VERSIONS).toEqual(await computeMediaVersions());
});

it('every media URL a page writes carries its content version', async () => {
  quietHrefWarnings();
  const pages = await renderPages(prerenderPaths);
  let seen = 0;
  for (const { path, html } of pages) {
    for (const [url] of html.matchAll(/\/media\/[^\s"',)]+/g)) {
      seen++;
      expect(url, `${path}: ${url}`).toMatch(/\?v=[0-9a-f]{10}$/);
    }
    for (const [url] of html.matchAll(/\/og\/[^\s"',)]+\.png[^\s"',)]*/g)) {
      expect(url, `${path}: ${url}`).toMatch(/\.png\?v=[0-9a-f]{8}$/);
    }
  }
  expect(seen).toBeGreaterThan(50);
}, 120_000);
