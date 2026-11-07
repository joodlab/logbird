import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Post } from './publications';

const post: Post = {
  slug: 'qa-first-post',
  title: 'A fictional first post',
  description: 'Lina Haddad cancels bk_1042 and the trail shows who did it.',
  published: '2026-11-07',
  author: 'QA Editor',
  body: ['Send any JSON object with an `action`.', 'The **actor** stays the customer.'],
};

afterEach(() => {
  vi.doUnmock('./publications');
  vi.resetModules();
});

describe('publications', () => {
  it('keeps the changelog and blog unready, and prerenders no post, until the owner publishes something', async () => {
    vi.resetModules();
    const { getPage, prerenderPaths, isReady } = await import('./site-map');
    const { sitemapXml } = await import('./discovery');
    expect(getPage('/changelog').ready).toBe(false);
    expect(getPage('/blog').ready).toBe(false);
    expect(isReady('/about')).toBe(true);
    expect(getPage('/legal/privacy').ready).toBe(false);
    expect(getPage('/legal/terms').ready).toBe(false);
    expect(prerenderPaths.filter((path) => path.startsWith('/blog/'))).toEqual([]);
    expect(sitemapXml()).not.toMatch(/\/blog|\/changelog|\/legal/);
  });

  it('publishes a post: the blog becomes ready, the post is prerendered, listed and gets its own head', async () => {
    vi.resetModules();
    vi.doMock('./publications', async (original) => ({ ...(await original<typeof import('./publications')>()), posts: [post] }));
    const { getPage, prerenderPaths } = await import('./site-map');
    const { sitemapXml, llmsTxt } = await import('./discovery');
    const { postHead } = await import('./seo');
    const { SITE_URL } = await import('../env');
    expect(getPage('/blog').ready).toBe(true);
    expect(prerenderPaths).toContain('/blog/qa-first-post');
    expect(sitemapXml()).toContain(`${SITE_URL}/blog/qa-first-post`);
    expect(llmsTxt()).toContain('[A fictional first post]');
    const head = postHead(post);
    expect(head.links).toEqual([{ rel: 'canonical', href: `${SITE_URL}/blog/qa-first-post` }]);
    expect(head.meta).toContainEqual({ property: 'og:type', content: 'article' });
    expect(head.meta).not.toContainEqual({ name: 'robots', content: 'noindex' });
    expect(head.scripts[0]?.children).toContain('"@type":"BlogPosting"');
  });

  it('a build-log entry makes the changelog ready', async () => {
    vi.resetModules();
    vi.doMock('./publications', async (original) => ({
      ...(await original<typeof import('./publications')>()),
      buildLog: [{ date: '2026-11-07', title: 'Search by dotted path', summary: 'Nested fields are searchable.' }],
    }));
    const { getPage } = await import('./site-map');
    expect(getPage('/changelog').ready).toBe(true);
  });

  it('renders a post with its byline, UTC date and inline marks', async () => {
    const { BlogArticle } = await import('../components/marketing/blog-article');
    const html = renderToStaticMarkup(createElement(BlogArticle, { post }));
    expect(html).toContain('<h1 class="h1">A fictional first post</h1>');
    expect(html).toContain('<time dateTime="2026-11-07">7 November 2026</time>');
    expect(html).toContain('<code>action</code>');
    expect(html).toContain('<strong class="font-semibold text-foreground">actor</strong>');
  });
});
