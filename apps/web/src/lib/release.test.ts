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
  it('blocks release while the domain or the security mailbox is provisional', async () => {
    vi.resetModules();
    const { siteConfigFrom } = await import('../env');
    const { releaseBlockers, siteIndexable } = await import('./release');
    const { robotsTxt } = await import('./discovery');
    const provisional = siteConfigFrom({});
    expect(releaseBlockers(provisional)).toEqual([
      'provisional domain: set WEB_SITE_URL',
      'security contact: set WEB_SECURITY_EMAIL',
      'contact mailbox: set WEB_CONTACT_EMAIL',
    ]);
    expect(siteIndexable(provisional)).toBe(false);
    expect(robotsTxt(provisional)).toBe('User-agent: *\nDisallow: /\n');
    expect(releaseBlockers(siteConfigFrom({ WEB_SITE_URL: 'https://site.example.test' }))).toEqual([
      'security contact: set WEB_SECURITY_EMAIL',
      'contact mailbox: set WEB_CONTACT_EMAIL',
    ]);
    expect(
      releaseBlockers(
        siteConfigFrom({
          WEB_SITE_URL: 'https://site.example.test',
          WEB_SECURITY_EMAIL: 'security@example.test',
          WEB_CONTACT_EMAIL: 'hello@example.test',
        }),
      ),
    ).toEqual([]);
  });
  it('rejects a security contact that is not an email address', async () => {
    const { siteConfigFrom } = await import('../env');
    expect(() => siteConfigFrom({ WEB_SECURITY_EMAIL: 'not an address' })).toThrow(/WEB_SECURITY_EMAIL/);
    expect(() => siteConfigFrom({ WEB_CONTACT_EMAIL: 'not an address' })).toThrow(/WEB_CONTACT_EMAIL/);
  });
});
