import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';

/**
 * Hosting serves one prerendered file for many URLs: contact/index.html for `/contact?status=…` and
 * `/contact?interest=…`, and 404.html for every unknown path. The browser hydrates that file at the requested URL, so
 * the document rendered for the URL must equal the document in the file, or React reports a hydration mismatch (#418).
 * Script contents (hydration data, JSON-LD) are data, not markup React compares, so they are blanked.
 */
const markup = (html: string) => html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/g, '$1</script>');

describe('prerendered files hydrate at every URL that serves them', () => {
  beforeEach(quietHrefWarnings);
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // The first render transforms the full route tree; this checks markup, not cold-start latency.
  it('renders /contact identically with ?status= or ?interest= (both apply after mount)', async () => {
    const [plain, ...variants] = await renderPages([
      '/contact',
      '/contact?status=ok',
      '/contact?status=rate_limited',
      '/contact?interest=self-host',
      '/contact?interest=correction&status=error',
    ]);
    for (const variant of variants) {
      expect(markup(variant.html), variant.path).toBe(markup(plain?.html ?? ''));
    }
  }, 15_000);

  it('renders an unknown path identically to the prerendered /404 page', async () => {
    const [notFound, ...unknown] = await renderPages([
      '/404',
      '/no-such-page',
      '/blog/no-such-post.md',
      '/compare/nothing',
      // Beneath a matched leaf: the router keeps the /product (or /compare/bemi) match and flags the root.
      '/product/no-such-page',
      '/compare/bemi/no-such-page',
      '/developers/x/y',
      '/legal/privacy/x',
    ]);
    expect(notFound?.html).toContain('No event at this address.');
    expect(notFound?.html).not.toContain('aria-current="page"');
    for (const page of unknown) {
      expect(page.html, page.path).not.toContain('aria-current="page"');
      expect(markup(page.html), page.path).toBe(markup(notFound?.html ?? ''));
    }
  });
});
