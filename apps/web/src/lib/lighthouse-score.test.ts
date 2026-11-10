import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { siteConfigFrom } from '../env';
import { legalPagesReady, RELEASED_ENV } from '../test/launch-ready';
import { robotsTxt } from './discovery';
import { indexedPaths, type LighthouseResult, robotsAllowsCrawling, seoPassMark, seoWithoutCrawlable } from './lighthouse-score';

const lhr = (scores: Record<string, number | null>): LighthouseResult => ({
  categories: { seo: { score: null, auditRefs: Object.keys(scores).map((id) => ({ id, weight: 1 })) } },
  audits: Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, { score }])),
});

describe('Lighthouse SEO pass mark', () => {
  let undo: () => void = () => undefined;
  beforeAll(async () => {
    undo = await legalPagesReady();
  });
  afterAll(() => undo());

  it('scores SEO without is-crawlable, skipping unscored audits', () => {
    expect(seoWithoutCrawlable(lhr({ 'is-crawlable': 0, 'meta-description': 1, 'link-text': 1 }))).toBe(100);
    expect(seoWithoutCrawlable(lhr({ 'is-crawlable': 0, 'meta-description': 0, 'link-text': 1 }))).toBe(50);
    expect(seoWithoutCrawlable(lhr({ 'is-crawlable': 1, 'meta-description': 1, 'link-text': null }))).toBe(100);
  });

  it('reads the served robots.txt the way discovery.ts writes it', () => {
    expect(robotsAllowsCrawling(robotsTxt(siteConfigFrom(RELEASED_ENV)))).toBe(true);
    // A gated build (any release blocker open) disallows everything.
    expect(robotsAllowsCrawling(robotsTxt(siteConfigFrom({})))).toBe(false);
    expect(robotsAllowsCrawling('')).toBe(false);
  });

  it('reads robots.txt behind a CDN that prepends its own groups (Cloudflare managed content signals)', () => {
    const cloudflare = [
      '# As a condition of accessing this website, you agree to abide by the following',
      '# BEGIN Cloudflare Managed content',
      '',
      'User-agent: *',
      'Content-Signal: search=yes,ai-train=no,use=reference',
      'Allow: /',
      '',
      '# Training crawlers',
      'User-agent: GPTBot',
      'Disallow: /',
      '',
      'User-agent: CCBot',
      'Disallow: /',
      '',
      '# END Cloudflare Managed Content',
      '',
    ].join('\r\n');
    const released = robotsTxt(siteConfigFrom({ ...RELEASED_ENV, WEB_APP_URL: RELEASED_ENV.WEB_SITE_URL }));
    // Named AI crawlers being blocked does not make an indexable site look gated...
    expect(robotsAllowsCrawling(cloudflare + released)).toBe(true);
    // ...and the CDN's `Allow: /` for everyone does not hide the site's own gate.
    expect(robotsAllowsCrawling(cloudflare + robotsTxt(siteConfigFrom({})))).toBe(false);
  });

  it('keeps crawlers off console and API paths only when the console shares the origin', () => {
    const shared = robotsTxt(siteConfigFrom({ ...RELEASED_ENV, WEB_APP_URL: RELEASED_ENV.WEB_SITE_URL }));
    expect(robotsAllowsCrawling(shared)).toBe(true);
    for (const path of ['/api/', '/v1/', '/login', '/p/', '/docs']) {
      expect(shared).toContain(`\nDisallow: ${path}\n`);
    }
    const separate = robotsTxt(siteConfigFrom({ ...RELEASED_ENV, WEB_APP_URL: 'https://console.example.test' }));
    expect(separate).not.toContain('Disallow');
  });

  it('keeps is-crawlable in the mark for ready pages once the site is indexable', () => {
    // An accidental noindex on a ready page: full SEO 66, everything else perfect.
    const noindexed = { path: '/about', seo: 66, 'seo-content': 100 };
    expect(seoPassMark(noindexed, true)).toEqual({ key: 'seo', score: 66 });
    // While gated, every page is noindex by design and the mark is seo-content.
    expect(seoPassMark(noindexed, false)).toEqual({ key: 'seo-content', score: 100 });
    // Pages that stay noindex on an indexable site keep seo-content.
    expect(indexedPaths().has('/404')).toBe(false);
    expect(seoPassMark({ path: '/404', seo: 66, 'seo-content': 100 }, true)).toEqual({ key: 'seo-content', score: 100 });
    expect(seoPassMark({ path: '/blog/qa-post', seo: 66, 'seo-content': 100 }, true, new Set(['/blog/qa-post'])).key).toBe('seo');
    expect(indexedPaths().has('/about')).toBe(true);
  });
});
