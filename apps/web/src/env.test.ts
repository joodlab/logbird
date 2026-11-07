import { describe, expect, it } from 'vitest';
import { localPublicUrls } from './env';

describe('public configuration', () => {
  it('flags any public URL that points at a developer machine (a Cloudflare build fails on these)', () => {
    expect(localPublicUrls({ WEB_SITE_URL: 'http://localhost:4620', WEB_APP_URL: 'http://127.0.0.1:4600', WEB_GITHUB_URL: undefined })).toEqual([
      'WEB_SITE_URL',
      'WEB_APP_URL',
    ]);
    expect(localPublicUrls({ WEB_SITE_URL: 'https://audit.example.test', WEB_APP_URL: undefined })).toEqual([]);
  });
});
