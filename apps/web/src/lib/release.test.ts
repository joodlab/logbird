import { describe, expect, it, vi } from 'vitest';

describe('release gate', () => {
  it('blocks indexing and robots while any media entry is interim', async () => {
    vi.resetModules();
    vi.doMock('./media-manifest', async (original) => {
      const actual = await original<typeof import('./media-manifest')>();
      return { ...actual, interimMedia: () => ['explorer'] };
    });
    const { releaseBlockers, pageIndexable } = await import('./release');
    const { robotsTxt, sitemapXml } = await import('./discovery');
    expect(releaseBlockers()).toEqual(['interim media: explorer']);
    expect(pageIndexable({ ready: true, path: '/' })).toBe(false);
    expect(robotsTxt()).toBe('User-agent: *\nDisallow: /\n');
    expect(sitemapXml()).not.toContain('<url>');
    vi.doUnmock('./media-manifest');
  });
  it('the shipped manifest has no interim media', async () => {
    vi.resetModules();
    const { releaseBlockers } = await import('./release');
    expect(releaseBlockers()).toEqual([]);
  });
});
