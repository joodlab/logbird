import { describe, expect, it } from 'vitest';
import { legalLinksFrom } from './legal-links';

describe('legal links on the sign-in screen', () => {
  it('shows none on a self-hosted install that configures nothing', () => {
    expect(legalLinksFrom({})).toEqual({ terms: undefined, privacy: undefined });
  });

  it("links the forwarded site's legal pages on this origin when LOGBIRD_SITE_URL is set (Logbird Cloud)", () => {
    expect(legalLinksFrom({ LOGBIRD_SITE_URL: 'http://logbird-site:4620' })).toEqual({ terms: '/legal/terms', privacy: '/legal/privacy' });
  });

  it("uses the operator's own pages when configured, over the site defaults", () => {
    expect(
      legalLinksFrom({
        LOGBIRD_SITE_URL: 'http://logbird-site:4620',
        LOGBIRD_TERMS_URL: 'https://audit.example.com/terms',
        LOGBIRD_PRIVACY_URL: ' /privacy ',
      }),
    ).toEqual({ terms: 'https://audit.example.com/terms', privacy: '/privacy' });
    expect(legalLinksFrom({ LOGBIRD_PRIVACY_URL: 'https://audit.example.com/privacy' })).toEqual({
      terms: undefined,
      privacy: 'https://audit.example.com/privacy',
    });
  });

  it('ignores values that are not http(s) URLs or same-origin paths', () => {
    for (const value of ['javascript:alert(1)', '//evil.example', 'terms.html', 'ftp://files.example/terms', '/\\evil.example', '   ']) {
      expect(legalLinksFrom({ LOGBIRD_TERMS_URL: value }).terms, value).toBeUndefined();
    }
    // Browsers strip tabs and line breaks inside URLs, which would turn these into off-origin "//evil.example" links.
    for (const value of ['/\t/evil.example/terms', '/\n/evil.example', '/\r/evil.example', 'https://audit.example.com/te\trms']) {
      expect(legalLinksFrom({ LOGBIRD_TERMS_URL: value }).terms, JSON.stringify(value)).toBeUndefined();
    }
  });
});
