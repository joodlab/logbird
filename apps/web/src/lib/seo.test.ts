import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITE_URL, siteConfigFrom } from '../env';
import { legalPagesReady, RELEASED_ENV } from '../test/launch-ready';
import { llmsTxt, robotsTxt, sitemapXml } from './discovery';
import { articleLd, breadcrumbLd, faqLd, organizationLd, pageHead, pageMeta, softwareLd, websiteLd } from './seo';
import { publishedPages, staticPages } from './site-map';

// Chosen from the manifest so these tests survive each page PR flipping `ready`.
const unready = staticPages.find((page) => !page.ready && !page.path.startsWith('/legal/'));
// These tests exercise an indexable site: the legal pages as they'll be at launch (release.test.ts covers the gate).
let undoLegal: () => void = () => undefined;
beforeAll(async () => {
  undoLegal = await legalPagesReady();
});
afterAll(() => undoLegal());

describe('metadata', () => {
  it('uses a canonical origin, page title and 1200×63 social card', () => {
    const head = pageHead('/product');
    expect(head.links).toContainEqual({ rel: 'canonical', href: `${SITE_URL}/product` });
    expect(head.meta).toContainEqual({ title: 'Product · Logbird' });
    expect(head.meta).toContainEqual({ property: 'og:image', content: `${SITE_URL}/og/product.png` });
    expect(head.meta).toContainEqual({ property: 'og:image:width', content: '1200' });
    expect(head.meta).toContainEqual({ property: 'og:image:height', content: '630' });
    expect(head.meta).toContainEqual({ name: 'twitter:card', content: 'summary_large_image' });
    expect(pageMeta({ title: 'Home', description: 'Description', path: '/' })).toContainEqual({
      title: 'Logbird — open-source audit logs for your product',
    });
  });
  it('keeps drafts and pages that are not ready out of search', () => {
    expect(pageHead('/blog/$slug').meta).toContainEqual({ name: 'robots', content: 'noindex' });
    if (unready) {
      expect(pageHead(unready.path).meta).toContainEqual({ name: 'robots', content: 'noindex' });
    }
    expect(pageHead('/').meta).not.toContainEqual({ name: 'robots', content: 'noindex' });
  });
  it('emits real schema types and limits the zero-price offer to self-hosting', () => {
    const parse = (script: { children: string }) => JSON.parse(script.children);
    // No publisher name is set (WEB_ORG_NAME is pending the owner): no Organization, and the WebSite names no publisher.
    expect(organizationLd()).toBeNull();
    expect(parse(websiteLd())).toMatchObject({ '@type': 'WebSite', name: 'Logbird' });
    expect(parse(websiteLd())).not.toHaveProperty('publisher');
    expect(parse(softwareLd())).toMatchObject({
      '@type': 'SoftwareApplication',
      operatingSystem: 'Linux, Docker',
      license: 'https://opensource.org/licenses/MIT',
    });
    // No $0 self-host offer while the source is private (and /self-hosting isn't published).
    expect(parse(softwareLd())).not.toHaveProperty('offers');
    expect(
      parse(
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Product', path: '/product' },
        ]),
      ).itemListElement[1],
    ).toMatchObject({ position: 2, item: `${SITE_URL}/product` });
    expect(
      parse(
        articleLd({ title: '<Draft>', description: 'Draft', path: '/blog/draft', published: '2026-11-07', author: 'Editor', ogSlug: 'blog-draft' }),
      ),
    ).toMatchObject({ '@type': 'BlogPosting', headline: '<Draft>', datePublished: '2026-11-07' });
    expect(
      articleLd({ title: '</script>', description: 'Draft', path: '/blog/draft', published: '2026-11-07', author: 'Editor', ogSlug: 'blog-draft' })
        .children,
    ).not.toContain('</script>');
    expect(parse(faqLd([{ q: 'Question?', a: 'Answer.' }])).mainEntity[0].acceptedAnswer.text).toBe('Answer.');
    expect(pageHead('/').scripts).toHaveLength(2);
  });
});
describe('static discovery', () => {
  it('uses the resolved build origin everywhere, not process.env', () => {
    const config = siteConfigFrom(RELEASED_ENV);
    expect(sitemapXml(config)).toContain('<loc>https://site.example.test/</loc>');
    expect(robotsTxt(config)).toContain('Sitemap: https://site.example.test/sitemap.xml');
    expect(llmsTxt(config)).toContain('(https://site.example.test/contact)');
  });
  it('lists only ready pages, never drafts or the not-found page', () => {
    const xml = sitemapXml(siteConfigFrom(RELEASED_ENV));
    const listed = new Set(publishedPages.map((page) => page.path));
    expect(xml).toContain('<loc>https://site.example.test/about</loc>');
    for (const page of staticPages) {
      const loc = `<loc>${new URL(page.path, 'https://site.example.test').href}</loc>`;
      if (listed.has(page.path)) {
        expect(xml).toContain(loc);
      } else {
        expect(xml).not.toContain(loc);
      }
    }
    expect(publishedPages.length).toBeGreaterThan(0);
    expect(xml).not.toMatch(/404|\$slug|blog\/draft/);
    expect(xml).toContain('<priority>1</priority>');
    const released = siteConfigFrom(RELEASED_ENV);
    expect(robotsTxt(released)).toBe('User-agent: *\nAllow: /\nSitemap: https://site.example.test/sitemap.xml\n');
    expect(llmsTxt(released)).toContain('(https://site.example.test/contact)');
    if (unready) {
      expect(llmsTxt(released)).not.toContain(`(${new URL(unready.path, 'https://site.example.test').href})`);
    }
  });
});
