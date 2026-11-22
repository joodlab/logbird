import { describe, expect, it } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
import { textSegments } from './source-state';

/**
 * Maintainer rule (2026-11-22): a feature may be called planned, coming or on the roadmap only if docs/roadmap.md or a
 * GitHub milestone says so; otherwise the page states the absence and stops. A feature that is built but not released
 * is "not in a published release yet", never "on the roadmap".
 *
 * Every sentence that mentions the roadmap is listed here with the docs/roadmap.md entry behind it; a new one fails
 * until it is checked and added. Looser words (planned, coming, upcoming…) fail outright. "Source on GitHub — coming
 * soon" is the repository's publication state (source-state.test.ts), not a feature.
 */
const ROADMAP_SENTENCES: Record<string, string[]> = {
  '/product': [
    "SSO isn't available yet. It's on the roadmap.", // § Later candidates: "Console SSO"
    'On the roadmap', // the section eyebrow; its items follow docs/roadmap.md
    "What's on our roadmap.",
    'These are candidates from our public roadmap, not features or commitments.', // the doc's "candidates, not delivery commitments"
  ],
  '/self-hosting': ['SSO is on the roadmap.'], // § Later candidates: "Console SSO"
  '/about': ['Integration feedback helps inform the roadmap.'], // says where feedback goes; names no feature
};
const REPOSITORY_STATE = 'Source on GitHub — coming soon';
const LOOSE = /\b(planned|plans? to|we plan|coming|upcoming|on the way|later this year|will ship|will support)\b/i;

const GITHUB = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
const STATES = {
  public: { ...GITHUB, WEB_GITHUB_PUBLIC: 'true' },
  'public, Cloud open': { ...GITHUB, WEB_GITHUB_PUBLIC: 'true', WEB_APP_URL: 'https://app.example.test' },
  private: GITHUB,
  'private, Cloud open': { ...GITHUB, WEB_APP_URL: 'https://app.example.test' },
};

/** What's left of a segment on `path` once its approved roadmap sentences and the repository-state phrase are removed. */
function unapproved(path: string, segment: string): string {
  let rest = segment.replaceAll(REPOSITORY_STATE, '');
  for (const sentence of ROADMAP_SENTENCES[path] ?? []) rest = rest.replaceAll(sentence, '');
  return rest;
}

describe('roadmap claims', () => {
  it('flags unlisted roadmap sentences and loose promises, and passes the approved ones', () => {
    const flagged = (text: string, path = '/compare/workos-audit-logs') => {
      const rest = unapproved(path, text);
      return /roadmap/i.test(rest) || LOOSE.test(rest);
    };
    expect(flagged('On the roadmap', '/product')).toBe(false); // the /product eyebrow is approved there…
    expect(flagged('On the roadmap')).toBe(true); // …but not as a comparison cell, the claim the guard once missed
    expect(flagged('Streaming to SIEM On the roadmap Log Streams')).toBe(true);
    expect(flagged('Django integration coming soon.')).toBe(true);
    expect(flagged('Webhooks are upcoming.')).toBe(true);
    expect(flagged('Express, Next.js, Laravel and Django are planned.')).toBe(true);
    expect(flagged(`${REPOSITORY_STATE}. Logbird Cloud is not open yet.`)).toBe(false);
    expect(flagged("SSO isn't available yet. It's on the roadmap.", '/product')).toBe(false);
    expect(flagged('Tenant-scoped read tokens are on the roadmap.', '/developers')).toBe(true);
  });

  it('no page makes an unlisted roadmap claim or a loose promise, in any repository or Cloud state', async () => {
    quietHrefWarnings();
    const { staticPages } = await import('./site-map');
    const paths = [...staticPages.map((page) => page.path), '/404'];
    const found = new Set<string>();
    for (const [state, env] of Object.entries(STATES)) {
      for (const { path, html } of await renderPages(paths, env)) {
        for (const segment of textSegments(html, { joinLinks: true })) {
          const rest = unapproved(path, segment);
          if (/roadmap/i.test(rest) || LOOSE.test(rest)) found.add(`${path} (${state}): ${segment.slice(0, 160)}`);
        }
      }
    }
    expect([...found]).toEqual([]);
  }, 180_000);
});
