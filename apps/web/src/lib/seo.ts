import { GITHUB_PUBLIC, GITHUB_URL, ORG_NAME, SITE_URL } from '../env';
import { type Post, postPath } from './publications';
import { pageIndexable, siteIndexable } from './release';
import { getPage, isReady } from './site-map';
export const canonicalHref = (path: string) => new URL(path, `${SITE_URL}/`).href;
export function pageMeta({
  title,
  description,
  path,
  type = 'website',
  ogSlug = 'home',
}: {
  title: string;
  description: string;
  path: string;
  type?: 'website' | 'article';
  ogSlug?: string;
}) {
  const fullTitle = path === '/' ? 'Logbird — open-source audit logs for your product' : `${title} · Logbird`;
  const image = canonicalHref(`/og/${ogSlug}.png`);
  return [
    { title: fullTitle },
    { name: 'description', content: description },
    { property: 'og:type', content: type },
    { property: 'og:site_name', content: 'Logbird' },
    { property: 'og:locale', content: 'en_US' },
    { property: 'og:title', content: fullTitle },
    { property: 'og:description', content: description },
    { property: 'og:url', content: canonicalHref(path) },
    { property: 'og:image', content: image },
    { property: 'og:image:width', content: '1200' },
    { property: 'og:image:height', content: '630' },
    { property: 'og:image:alt', content: `Logbird — ${title}` },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: fullTitle },
    { name: 'twitter:description', content: description },
    { name: 'twitter:image', content: image },
    { name: 'twitter:image:alt', content: `Logbird — ${title}` },
  ];
}
function ld(data: Record<string, unknown>) {
  return { type: 'application/ld+json', children: JSON.stringify({ '@context': 'https://schema.org', ...data }).replaceAll('<', '\\u003c') };
}
/** Only when the publisher's legal name is set (WEB_ORG_NAME, pending the owner); otherwise no company is named. */
export const organizationLd = () =>
  ORG_NAME
    ? ld({
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: ORG_NAME,
        alternateName: 'Logbird',
        url: SITE_URL,
        logo: canonicalHref('/brand/logbird-wordmark-light.svg'),
        ...(GITHUB_PUBLIC && GITHUB_URL ? { sameAs: [GITHUB_URL] } : {}),
      })
    : null;
export const websiteLd = () =>
  ld({
    '@type': 'WebSite',
    name: 'Logbird',
    url: SITE_URL,
    inLanguage: 'en',
    ...(ORG_NAME ? { publisher: { '@id': `${SITE_URL}/#organization` } } : {}),
  });
export const softwareLd = () =>
  ld({
    '@type': 'SoftwareApplication',
    name: 'Logbird',
    url: SITE_URL,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, Docker',
    license: 'https://opensource.org/licenses/MIT',
    // A $0 self-hosted offer only once anyone can self-host: the source is public and the self-host page is published.
    ...(GITHUB_PUBLIC && isReady('/self-hosting')
      ? { offers: { '@type': 'Offer', name: 'Self-hosted', price: '0', priceCurrency: 'USD', url: canonicalHref('/self-hosting') } }
      : {}),
  });
export const breadcrumbLd = (items: { name: string; path: string }[]) =>
  ld({
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: canonicalHref(item.path) })),
  });
export const articleLd = (article: {
  title: string;
  description: string;
  path: string;
  published: string;
  modified?: string;
  author: string;
  ogSlug: string;
}) =>
  ld({
    '@type': 'BlogPosting',
    headline: article.title,
    description: article.description,
    url: canonicalHref(article.path),
    datePublished: article.published,
    dateModified: article.modified ?? article.published,
    author: { '@type': 'Person', name: article.author },
    ...(ORG_NAME ? { publisher: { '@id': `${SITE_URL}/#organization` } } : {}),
    image: canonicalHref(`/og/${article.ogSlug}.png`),
  });
export const faqLd = (items: { q: string; a: string }[]) =>
  ld({
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })),
  });
/** Head for a static page. Published posts use postHead(); `/blog/$slug` adds no head for an unknown slug. */
export function pageHead(path: string) {
  const page = getPage(path);
  return {
    // Not-ready pages, and every page while a release blocker is open, are noindex (release.ts).
    meta: [...pageMeta({ ...page, path }), ...(pageIndexable(page) ? [] : [{ name: 'robots', content: 'noindex' }])],
    links: [{ rel: 'canonical', href: canonicalHref(path) }],
    scripts:
      path === '/'
        ? [organizationLd(), websiteLd(), softwareLd()].filter((script) => script !== null)
        : [
            breadcrumbLd([
              { name: 'Home', path: '/' },
              ...(path.startsWith('/compare/') ? [{ name: 'Compare', path: '/compare' }] : []),
              { name: page.title, path },
            ]),
          ],
  };
}

/** Head for one published post: its own canonical, article card and BlogPosting data. */
export function postHead(post: Post) {
  const path = postPath(post);
  return {
    meta: [
      ...pageMeta({ title: post.title, description: post.description, path, type: 'article', ogSlug: 'blog' }),
      ...(siteIndexable() ? [] : [{ name: 'robots', content: 'noindex' }]),
    ],
    links: [{ rel: 'canonical', href: canonicalHref(path) }],
    scripts: [
      articleLd({ ...post, path, ogSlug: 'blog' }),
      breadcrumbLd([
        { name: 'Home', path: '/' },
        { name: 'Blog', path: '/blog' },
        { name: post.title, path },
      ]),
    ],
  };
}
