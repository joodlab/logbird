import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';

const PUBLIC_REPO = { WEB_GITHUB_PUBLIC: 'true', WEB_GITHUB_URL: 'https://github.example.test/acme/logbird' };
const CLOUD_OPEN = { ...PUBLIC_REPO, WEB_APP_URL: 'https://site.example.test' };
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ');

describe('Cloud state', () => {
  beforeEach(quietHrefWarnings);
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('with a console URL: no waitlist wording, access requests instead, and sign-in goes to /login', async () => {
    const { staticPages } = await import('./site-map');
    const pages = await renderPages(
      staticPages.map((page) => page.path),
      CLOUD_OPEN,
    );
    const stale = /waitlist|isn't open yet|not open yet|when it opens/i;
    expect(pages.filter(({ html }) => stale.test(text(html))).map(({ path }) => path)).toEqual([]);
    // The header's sign-in link on every page, never the console root (a signed-out `/` is the marketing home).
    expect(pages.every(({ html }) => html.includes('href="https://site.example.test/login"'))).toBe(true);
    expect(pages.some(({ html }) => html.includes('href="https://site.example.test"'))).toBe(false);
    // Every page offers the access request (the header button; legal pages and the 404 have nothing else).
    expect(pages.filter(({ html }) => !text(html).includes('Request access')).map(({ path }) => path)).toEqual([]);
  }, 30_000);

  it('without a console URL: the waitlist, and no sign-in link', async () => {
    const [home, cloud] = await renderPages(['/', '/cloud'], PUBLIC_REPO);
    for (const page of [home, cloud]) {
      expect(text(page?.html ?? '')).toContain('Join the waitlist');
      expect(page?.html).not.toContain('/login');
    }
  }, 15_000);

  it('pins the self-host quickstart to the latest release and links the repository guides', async () => {
    const { latestRelease } = await import('./releases');
    const [selfHosting] = await renderPages(['/self-hosting'], PUBLIC_REPO);
    const html = selfHosting?.html ?? '';
    expect(text(html)).toContain(`git clone --branch v${latestRelease?.version}`);
    expect(text(html)).toContain('docker compose pull');
    expect(text(html)).not.toMatch(/no images are published|builds? from source;/i);
    expect(html).toContain('href="https://github.example.test/acme/logbird/blob/master/docs/coolify.md"');
    expect(text(html)).toContain('ghcr.io/acme');
  }, 15_000);
});
