import { describe, expect, it, vi } from 'vitest';
import { legalPagesReady } from '../test/launch-ready';

describe('release gate', () => {
  it('blocks indexing and robots while any media entry is interim', async () => {
    vi.resetModules();
    vi.doMock('./media-manifest', async (original) => {
      const actual = await original<typeof import('./media-manifest')>();
      return { ...actual, interimMedia: () => ['explorer'] };
    });
    await legalPagesReady();
    const { releaseBlockers, pageIndexable } = await import('./release');
    const { robotsTxt, sitemapXml } = await import('./discovery');
    expect(releaseBlockers()).toContain('interim media: explorer');
    expect(pageIndexable({ ready: true, path: '/' })).toBe(false);
    expect(robotsTxt()).toBe('User-agent: *\nDisallow: /\n');
    expect(sitemapXml()).not.toContain('<url>');
    vi.doUnmock('./media-manifest');
  });
  it('the shipped manifest has no interim media', async () => {
    vi.resetModules();
    const { interimMedia } = await import('./media-manifest');
    expect(interimMedia()).toEqual([]);
  });
  it('blocks release until the publisher and a privacy contact are named, and while a legal page is unready', async () => {
    vi.resetModules();
    const { siteConfigFrom } = await import('../env');
    const { RELEASED_ENV } = await import('../test/launch-ready');
    const { getPage } = await import('./site-map');
    const { releaseBlockers, siteIndexable } = await import('./release');
    const { robotsTxt, sitemapXml } = await import('./discovery');
    // The legal pages ship ready: their real text renders whatever the configuration.
    expect([getPage('/legal/privacy').ready, getPage('/legal/terms').ready]).toEqual([true, true]);
    const { WEB_ORG_NAME: _org, WEB_PRIVACY_EMAIL: _privacy, ...unnamed } = RELEASED_ENV;
    const pending = siteConfigFrom(unnamed);
    expect(releaseBlockers(pending)).toEqual(['publisher: set WEB_ORG_NAME', 'privacy contact: set WEB_PRIVACY_EMAIL']);
    expect(siteIndexable(pending)).toBe(false);
    expect(robotsTxt(pending)).toBe('User-agent: *\nDisallow: /\n');
    expect(sitemapXml(pending)).not.toContain('<url>');
    const released = siteConfigFrom(RELEASED_ENV);
    expect(releaseBlockers(released)).toEqual([]);
    expect(siteIndexable(released)).toBe(true);
    // A legal page taken back to unready blocks release again.
    getPage('/legal/terms').ready = false;
    expect(releaseBlockers(released)).toEqual(['legal placeholder: /legal/terms needs counsel-reviewed text']);
    getPage('/legal/terms').ready = true;
  });
  it('blocks release while the domain or the security mailbox is provisional', async () => {
    vi.resetModules();
    await legalPagesReady();
    const { siteConfigFrom } = await import('../env');
    const { releaseBlockers, siteIndexable } = await import('./release');
    const { robotsTxt } = await import('./discovery');
    const provisional = siteConfigFrom({});
    expect(releaseBlockers(provisional)).toEqual([
      'provisional domain: set WEB_SITE_URL',
      'security contact: set WEB_SECURITY_EMAIL',
      'contact mailbox: set WEB_CONTACT_EMAIL',
      'publisher: set WEB_ORG_NAME',
      'privacy contact: set WEB_PRIVACY_EMAIL',
    ]);
    expect(siteIndexable(provisional)).toBe(false);
    expect(robotsTxt(provisional)).toBe('User-agent: *\nDisallow: /\n');
    expect(releaseBlockers(siteConfigFrom({ WEB_SITE_URL: 'https://site.example.test' }))).toEqual([
      'security contact: set WEB_SECURITY_EMAIL',
      'contact mailbox: set WEB_CONTACT_EMAIL',
      'publisher: set WEB_ORG_NAME',
      'privacy contact: set WEB_PRIVACY_EMAIL',
    ]);
    expect(
      releaseBlockers(
        siteConfigFrom({
          WEB_SITE_URL: 'https://site.example.test',
          WEB_SECURITY_EMAIL: 'security@example.test',
          WEB_CONTACT_EMAIL: 'hello@example.test',
          WEB_ORG_NAME: 'Example Publisher',
          WEB_PRIVACY_EMAIL: 'privacy@example.test',
        }),
      ),
    ).toEqual([]);
  });
  it('rejects a security contact that is not an email address', async () => {
    const { siteConfigFrom } = await import('../env');
    expect(() => siteConfigFrom({ WEB_SECURITY_EMAIL: 'not an address' })).toThrow(/WEB_SECURITY_EMAIL/);
    expect(() => siteConfigFrom({ WEB_CONTACT_EMAIL: 'not an address' })).toThrow(/WEB_CONTACT_EMAIL/);
    expect(() => siteConfigFrom({ WEB_PRIVACY_EMAIL: 'not an address' })).toThrow(/WEB_PRIVACY_EMAIL/);
  });
});
