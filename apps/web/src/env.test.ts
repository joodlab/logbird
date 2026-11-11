import { describe, expect, it } from 'vitest';
import { TEST_PUBLIC_ENV } from '../vitest.config';
import { localPublicUrls, PUBLIC_ENV_KEYS, siteConfig, siteConfigFrom } from './env';

describe('public configuration', () => {
  it('runs tests on a pinned configuration, not the machine environment', () => {
    // vitest.config.ts sets every public key before any test imports env.ts.
    expect(Object.keys(TEST_PUBLIC_ENV).sort()).toEqual([...PUBLIC_ENV_KEYS].sort());
    for (const key of PUBLIC_ENV_KEYS) {
      expect(process.env[key] ?? '', key).toBe(TEST_PUBLIC_ENV[key]);
    }
    expect(siteConfig).toEqual({
      SITE_URL: 'https://site.example.test',
      APP_URL: undefined,
      GITHUB_PUBLIC: false,
      GITHUB_URL: undefined,
      ORG_NAME: undefined,
      SECURITY_EMAIL: 'security@example.test',
      CONTACT_EMAIL: 'hello@example.test',
      PRIVACY_EMAIL: undefined,
      LEGAL_ADDRESS: undefined,
      GOVERNING_LAW: undefined,
      HOSTING_PROVIDER: undefined,
      EMAIL_PROVIDER: undefined,
      MAILBOX_PROVIDER: undefined,
      FORM_RETENTION_MONTHS: 24,
      SITE_URL_CONFIGURED: true,
    });
  });
  it('flags any public URL that points at a developer machine (a Cloudflare build fails on these)', () => {
    expect(localPublicUrls({ WEB_SITE_URL: 'http://localhost:4620', WEB_APP_URL: 'http://127.0.0.1:4600', WEB_GITHUB_URL: undefined })).toEqual([
      'WEB_SITE_URL',
      'WEB_APP_URL',
    ]);
    expect(localPublicUrls({ WEB_SITE_URL: 'https://audit.example.test', WEB_APP_URL: undefined })).toEqual([]);
  });
  it('reads the form retention period as whole months from 1 to 120, 24 when unset', () => {
    expect(siteConfigFrom({}).FORM_RETENTION_MONTHS).toBe(24);
    expect(siteConfigFrom({ WEB_FORM_RETENTION_MONTHS: ' 12 ' }).FORM_RETENTION_MONTHS).toBe(12);
    for (const value of ['0', '121', '1.5', 'two years', '0x18', '1e1', '24.0']) {
      expect(() => siteConfigFrom({ WEB_FORM_RETENTION_MONTHS: value }), value).toThrow(/WEB_FORM_RETENTION_MONTHS/);
    }
  });
});
