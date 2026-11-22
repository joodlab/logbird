import { describe, expect, it } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
import { textSegments } from './source-state';

/**
 * Maintainer rule (2026-11-22): a feature may be called planned, coming or on the roadmap only if docs/roadmap.md or a
 * GitHub milestone says so; otherwise the page states the absence and stops. A feature that is built but not released
 * is "not in a published release yet", never "on the roadmap".
 *
 * Every sentence that mentions the roadmap is listed here, per page, with the docs/roadmap.md entry behind it; a new
 * one fails until it is checked and added. The /product roadmap list must hold exactly the approved items. Looser words
 * (planned, coming, upcoming…) and feature promises ("we'll add…", "we'll document…") fail outright. "Source on GitHub —
 * coming soon" is the repository's publication state (source-state.test.ts), not a feature.
 */
const ROADMAP_SENTENCES: Record<string, string[]> = {
  '/product': [
    "SSO isn't available yet. It's on the roadmap.", // § Later candidates: "Console SSO"
    'On the roadmap', // the section eyebrow; its items are checked below
    "What's on our roadmap.",
    'These are candidates from our public roadmap, not features or commitments.', // the doc's "candidates, not delivery commitments"
  ],
  '/self-hosting': ['SSO is on the roadmap.'], // § Later candidates: "Console SSO"
  '/about': ['Integration feedback helps inform the roadmap.'], // says where feedback goes; names no feature
};
/** The /product roadmap list, item by item, each with the docs/roadmap.md entry behind it. Nothing built goes here. */
const ROADMAP_ITEMS = [
  'Project-level redaction controls, behind the redaction your client already does.', // § Customer-facing history
  'Alerts on chosen actions.', // § Later candidates: "Action alerts"
  'Signed webhooks and archive exports.', // § Later candidates
  'Single sign-on for the console.', // § Later candidates: "Console SSO"
];
const ROADMAP_HEADING = "What's on our roadmap.";
/** docs/roadmap.md: "These are candidates, not delivery commitments." */
const ROADMAP_INTRODUCTION = 'These are candidates from our public roadmap, not features or commitments. Order and timing can change.';
const REPOSITORY_STATE = 'Source on GitHub — coming soon';
const LOOSE = /\b(planned|plans? to|we plan|coming|upcoming|on the way|later this year|will ship|will support)\b/i;
/**
 * Promises that a feature or a document will exist. Business and legal commitments (prices, the hosting region, notice
 * of changed terms, replying to a message) are not features and aren't matched.
 */
const FEATURE_PROMISE =
  /\bwe'?ll (add|build|ship|support|document|release)\b|\bwe will (add|build|ship|support|document|release)\b|\bpublish service levels\b|\bdocument how to migrate\b/i;

const GITHUB = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
const STATES = {
  public: { ...GITHUB, WEB_GITHUB_PUBLIC: 'true' },
  'public, Cloud open': { ...GITHUB, WEB_GITHUB_PUBLIC: 'true', WEB_APP_URL: 'https://app.example.test' },
  private: GITHUB,
  'private, Cloud open': { ...GITHUB, WEB_APP_URL: 'https://app.example.test' },
};

/** Whether a text segment on `path` makes a claim this rule forbids. */
function flagged(path: string, segment: string): boolean {
  let rest = segment.replaceAll(REPOSITORY_STATE, '');
  for (const sentence of ROADMAP_SENTENCES[path] ?? []) rest = rest.replaceAll(sentence, '');
  return /roadmap/i.test(rest) || LOOSE.test(rest) || FEATURE_PROMISE.test(rest);
}

describe('roadmap claims', () => {
  it('flags unlisted roadmap sentences, loose words and feature promises, and passes the approved ones', () => {
    const cell = '/compare/workos-audit-logs';
    expect(flagged('/product', 'On the roadmap')).toBe(false); // the /product eyebrow is approved there…
    expect(flagged(cell, 'On the roadmap')).toBe(true); // …but not as a comparison cell, the claim the guard once missed
    expect(flagged(cell, 'Streaming to SIEM On the roadmap Log Streams')).toBe(true);
    expect(flagged(cell, 'Django integration coming soon.')).toBe(true);
    expect(flagged(cell, 'Webhooks are upcoming.')).toBe(true);
    expect(flagged('/developers', 'Express, Next.js, Laravel and Django are planned.')).toBe(true);
    expect(flagged('/developers', "We'll add them when we use those stacks ourselves.")).toBe(true);
    expect(flagged('/developers', 'Tenant-scoped read tokens are on the roadmap.')).toBe(true);
    expect(flagged('/cloud', "We'll document how to migrate before the cloud opens. There's no migration tool today.")).toBe(true);
    expect(flagged('/cloud', "We'll publish service levels and limits together with the cloud's launch terms.")).toBe(true);
    expect(flagged('/', `${REPOSITORY_STATE}. Logbird Cloud is not open yet.`)).toBe(false);
    expect(flagged('/product', "SSO isn't available yet. It's on the roadmap.")).toBe(false);
    // Business commitments are not feature promises.
    expect(flagged('/contact', "Thanks, we've got it. We'll reply by email.")).toBe(false);
    expect(flagged('/cloud', "We'll publish the hosting region before the cloud opens.")).toBe(false);
  });

  it('no page makes an unlisted roadmap claim, a loose promise or a feature promise, in any repository or Cloud state', async () => {
    quietHrefWarnings();
    const { staticPages } = await import('./site-map');
    const paths = [...staticPages.map((page) => page.path), '/404'];
    const found = new Set<string>();
    for (const [state, env] of Object.entries(STATES)) {
      for (const { path, html } of await renderPages(paths, env)) {
        for (const segment of textSegments(html, { joinLinks: true })) {
          if (flagged(path, segment)) found.add(`${path} (${state}): ${segment.slice(0, 160)}`);
        }
      }
    }
    expect([...found]).toEqual([]);
  }, 180_000);

  it('the /product roadmap section says exactly the approved heading, introduction and items', async () => {
    const [page] = await renderPages(['/product'], STATES.public);
    const html = page?.html ?? '';
    const plain = (fragment: string) =>
      fragment
        .replace(/<[^>]+>/g, ' ')
        .replaceAll('&#x27;', "'")
        .replace(/\s+/g, ' ')
        .trim();
    const headingAt = html.indexOf('id="roadmap-title"');
    const section = html.slice(html.indexOf('>', headingAt) + 1);
    // The heading and introduction, word for word: "plans" or "what we plan to build" would promote candidates.
    expect(plain(section.slice(0, section.indexOf('<ul')))).toBe(`${ROADMAP_HEADING} ${ROADMAP_INTRODUCTION}`);
    const list = section.slice(section.indexOf('<ul'), section.indexOf('</ul>'));
    const items = [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(([, inner]) => plain(inner ?? ''));
    // A built feature, or anything docs/roadmap.md doesn't list, fails here even under the approved heading.
    expect(items).toEqual(ROADMAP_ITEMS);
  });
});
