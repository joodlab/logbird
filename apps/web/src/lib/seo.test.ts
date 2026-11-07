import { describe, expect, it } from 'vitest';
import { SITE_URL } from '../env';
import { llmsTxt, robotsTxt, sitemapXml } from './discovery';
import { articleLd, breadcrumbLd, faqLd, organizationLd, pageHead, pageMeta, softwareLd, websiteLd } from './seo';
import { staticPages } from './site-map';

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
  it('keeps drafts out of search', () => {
    expect(pageHead('/blog/$slug').meta).toContainEqual({ name: 'robots', content: 'noindex' });
  });
  it('emits real schema types and limits the zero-price offer to self-hosting', () => {
    const parse = (script: { children: string }) => JSON.parse(script.children);
    expect(parse(organizationLd())).toMatchObject({ '@type': 'Organization', name: 'Joodlab', alternateName: 'Logbird' });
    expect(parse(websiteLd())).toMatchObject({ '@type': 'WebSite', name: 'Logbird' });
    expect(parse(softwareLd())).toMatchObject({
      '@type': 'SoftwareApplication',
      operatingSystem: 'Linux, Docker',
      license: 'https://opensource.org/licenses/MIT',
      offers: { price: '0', url: `${SITE_URL}/self-hosting` },
    });
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
    expect(pageHead('/').scripts).toHaveLength(3);
  });
});
describe('static discovery', () => {
  it('includes all public pages, excludes drafts and the not-found page', () => {
    const xml = sitemapXml();
    for (const page of staticPages) {
      expect(xml).toContain(`<loc>${new URL(page.path, SITE_URL).href}</loc>`);
    }
    expect(xml).not.toMatch(/404|\$slug|blog\/draft/);
    expect(xml).toContain('<priority>1</priority>');
    expect(robotsTxt()).toBe(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    expect(llmsTxt()).toContain(`[Product](${SITE_URL}/product)`);
  });
});
