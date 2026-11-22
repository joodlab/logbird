import { describe, expect, it } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
import { textSegments } from './source-state';

/**
 * Maintainer rule (2026-11-22): a feature may be called planned, coming or on the roadmap only if docs/roadmap.md or a
 * GitHub milestone says so; otherwise the page states the absence and stops. Pages say "on the roadmap" only for items
 * docs/roadmap.md lists (checked in review against the brief's sources); this test stops the looser words, which no
 * roadmap entry backs, from coming back. "Coming soon" about the repository opening is a publication state, not a
 * feature, and is checked by source-state.test.ts.
 */
const LOOSE = /\b(planned|plan to|we plan|coming|on the way|later this year|will ship|will support)\b/i;

describe('roadmap claims', () => {
  it('no page calls a feature planned or coming, in any repository or Cloud state', async () => {
    quietHrefWarnings();
    const { staticPages } = await import('./site-map');
    const paths = staticPages.map((page) => page.path);
    const github = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
    const found: string[] = [];
    for (const env of [
      { ...github, WEB_GITHUB_PUBLIC: 'true' },
      { ...github, WEB_GITHUB_PUBLIC: 'true', WEB_APP_URL: 'https://app.example.test' },
      github,
    ]) {
      for (const { path, html } of await renderPages(paths, env)) {
        for (const segment of textSegments(html, { joinLinks: true })) {
          const text = segment.replace(/coming soon/gi, '');
          if (LOOSE.test(text)) found.push(`${path}: ${segment.slice(0, 160)}`);
        }
      }
    }
    expect([...new Set(found)]).toEqual([]);
  }, 120_000);
});
