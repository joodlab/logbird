import { describe, expect, it, vi } from 'vitest';
import { renderPages } from '../test/render-pages';

/**
 * With SCOPED_READ_LIVE off, neither the landing page's "How it is enforced" link nor its target on /security renders,
 * and the landing page's limit is the backend one. The flag is a constant, so this file renders with it mocked off.
 */
vi.mock('./site', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./site')>();
  return { ...actual, SCOPED_READ_LIVE: false, SITE: { ...actual.SITE, scopedReadLive: false } };
});

describe('scoped read access, flag off', () => {
  it('renders no link to /security § Scoped reads and no target block', async () => {
    const pages = await renderPages(['/', '/security']);
    const page = (path: string) => pages.find((entry) => entry.path === path)?.html ?? '';
    expect(page('/')).not.toContain('#scoped-reads');
    expect(page('/')).not.toContain('Viewer tokens');
    expect(page('/')).toContain('A read key reads the whole project, so your backend must decide which customer account each user may see.');
    expect(page('/security')).not.toContain('id="scoped-reads"');
  }, 60_000);
});
