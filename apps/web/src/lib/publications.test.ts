import { isNotFound } from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { legalPagesReady, RELEASED_ENV } from '../test/launch-ready';
import type { Post } from './publications';

const post: Post = {
  slug: 'qa-first-post',
  title: 'A fictional first post',
  description: 'Lina Haddad cancels bk_1042 and the trail shows who did it.',
  published: '2026-11-07',
  author: 'QA Editor',
  body: ['Send any JSON object with an `action`.', 'The **actor** stays the customer.'],
};

/**
 * A fresh module graph where the publication lists hold the given fixtures. The fixtures go into the real arrays, so
 * everything that reads them (site-map readiness, prerender paths, discovery, findPost and the route loader) sees the
 * same data. Modules that derive from the lists at load time are imported afterwards.
 */
async function withPublications(fixtures: { posts?: Post[]; buildLog?: { date: string; title: string; summary: string }[] } = {}) {
  vi.resetModules();
  const publications = await import('./publications');
  publications.posts.push(...(fixtures.posts ?? []));
  publications.buildLog.push(...(fixtures.buildLog ?? []));
  await legalPagesReady();
  const { siteConfigFrom } = await import('../env');
  return {
    publications,
    released: siteConfigFrom(RELEASED_ENV),
    siteMap: await import('./site-map'),
    discovery: await import('./discovery'),
    seo: await import('./seo'),
  };
}

afterEach(() => {
  vi.resetModules();
});

describe('publications', () => {
  it('keeps the changelog and blog unready, and prerenders no post, until the owner publishes something', async () => {
    const { siteMap, discovery, released } = await withPublications();
    expect(siteMap.getPage('/changelog').ready).toBe(false);
    expect(siteMap.getPage('/blog').ready).toBe(false);
    expect(siteMap.isReady('/about')).toBe(true);
    expect(siteMap.prerenderPaths.filter((path) => path.startsWith('/blog/'))).toEqual([]);
    const xml = discovery.sitemapXml(released);
    // Positive control first, so the negative check can't pass on an empty sitemap.
    expect(xml).toContain('<loc>https://site.example.test/about</loc>');
    expect(xml).not.toMatch(/\/blog|\/changelog/);
  });

  it('publishes a post: the blog becomes ready, the post is prerendered, listed and gets its own head', async () => {
    const { siteMap, discovery, seo, released } = await withPublications({ posts: [post] });
    expect(siteMap.getPage('/blog').ready).toBe(true);
    expect(siteMap.prerenderPaths).toContain('/blog/qa-first-post');
    expect(discovery.sitemapXml(released)).toContain('<loc>https://site.example.test/blog/qa-first-post</loc>');
    expect(discovery.llmsTxt(released)).toContain('[A fictional first post](https://site.example.test/blog/qa-first-post)');
    const head = seo.postHead(post);
    expect(head.links).toHaveLength(1);
    expect(head.links[0]?.href).toMatch(/\/blog\/qa-first-post$/);
    expect(head.meta).toContainEqual({ property: 'og:type', content: 'article' });
    expect(head.scripts[0]?.children).toContain('"@type":"BlogPosting"');
  });

  it('a build-log entry makes the changelog ready', async () => {
    const { siteMap } = await withPublications({ buildLog: [{ date: '2026-11-07', title: 'Search by dotted path', summary: 'Nested fields.' }] });
    expect(siteMap.getPage('/changelog').ready).toBe(true);
  });
});

describe('/blog/$slug route', () => {
  async function route(posts: Post[]) {
    await withPublications({ posts });
    const { Route } = await import('../routes/blog.$slug');
    const loader = Route.options.loader as unknown as (context: { params: { slug: string } }) => Post;
    const head = Route.options.head as unknown as (context: { loaderData?: Post }) => { meta?: unknown[]; links?: unknown[] };
    return { loader, head };
  }

  it('loads a published post by slug, gives it its head, and renders it', async () => {
    const { loader, head } = await route([post]);
    const loaded = loader({ params: { slug: 'qa-first-post' } });
    expect(loaded).toBe(post);
    expect(head({ loaderData: loaded }).meta).toContainEqual({ title: 'A fictional first post · Logbird' });
    const { BlogArticle } = await import('../components/marketing/blog-article');
    const html = renderToStaticMarkup(createElement(BlogArticle, { post: loaded }));
    expect(html).toContain('<h1 class="h1">A fictional first post</h1>');
    expect(html).toContain('<time dateTime="2026-11-07">7 November 2026</time>');
    expect(html).toContain('<code>action</code>');
    expect(html).toContain('<strong class="font-semibold text-foreground">actor</strong>');
  });

  it('throws notFound for an unknown slug, and adds no head of its own', async () => {
    const { loader, head } = await route([post]);
    let thrown: unknown;
    try {
      loader({ params: { slug: 'no-such-post' } });
    } catch (error) {
      thrown = error;
    }
    expect(isNotFound(thrown)).toBe(true);
    expect(head({})).toEqual({});
  });

  it('throws notFound for every slug while nothing is published', async () => {
    const { loader } = await route([]);
    expect(() => loader({ params: { slug: 'qa-first-post' } })).toThrow();
  });
});
