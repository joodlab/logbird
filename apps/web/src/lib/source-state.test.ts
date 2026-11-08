import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSourcePhrases, SOURCE_OPEN_PHRASES, SOURCE_STATE_PHRASES } from './source-state';

const PUBLIC_ENV = { WEB_GITHUB_PUBLIC: 'true', WEB_GITHUB_URL: 'https://github.example.test/acme/logbird' };
const open = (html: string) => findSourcePhrases(html, SOURCE_OPEN_PHRASES).map((match) => match.label);
const closed = (html: string) => findSourcePhrases(html, SOURCE_STATE_PHRASES).map((match) => match.label);

describe('source-state matching', () => {
  it('treats the public "Source on GitHub" link label as open, in any case or qualified form', () => {
    expect(open('<a class="hover:text-foreground" href="https://github.example.test/acme/logbird">Source on GitHub</a>')).toEqual([
      'Source on GitHub',
    ]);
    expect(open('<p>source on github</p>')).toEqual(['Source on GitHub']);
    expect(open('<p>SOURCE ON GITHUB, under the MIT licence.</p>')).toEqual(['Source on GitHub']);
    expect(open('<span>Source on\n  <b>GitHub</b></span>')).toEqual(['Source on GitHub']);
    expect(open('MIT; source on GitHub')).toEqual(['Source on GitHub']);
  });

  it('tells the private placeholder apart from the public link', () => {
    for (const placeholder of [
      '<p>Source on GitHub — coming soon.</p>',
      '<span><svg aria-hidden="true"></svg>Source on GitHub — coming soon</span>',
      '<p>Source on <b>GitHub</b> &mdash; Coming Soon.</p>',
      '<dd>Source on GitHub — coming soon. Logbird Cloud is not open yet.</dd>',
    ]) {
      expect(open(placeholder)).toEqual([]);
      expect(closed(placeholder)).toEqual(['coming soon']);
    }
    // The placeholder next to a leaked link still fails a private build.
    expect(open('<p>Source on GitHub — coming soon.</p><a href="/x">Source on GitHub</a>')).toEqual(['Source on GitHub']);
  });

  it('catches reworded "released" sentences but not the private "not released yet" wording', () => {
    for (const sentence of [
      'We released it under the MIT licence.',
      'We&#x27;ve released Logbird under MIT.',
      'we have now released the source.',
      'Logbird is released under the MIT licence.',
      'The source has been released.',
    ]) {
      expect(open(sentence), sentence).toEqual(['released (the source)']);
    }
    for (const sentence of [
      'Nothing has been released yet. The first release, 0.1.0, is in progress.',
      'Not released',
      'Not released yet (0.1 line)',
      'Nothing has been released yet: there are no npm packages or Docker images.',
    ]) {
      expect(open(sentence), sentence).toEqual([]);
    }
  });

  it('matches whole words, case-insensitively, after decoding entities', () => {
    expect(closed('The repository ISN&#x27;T PUBLIC yet.')).toEqual(["isn't public"]);
    expect(closed('<p>Coming Soon</p>')).toEqual(['coming soon']);
    expect(open('Self-host items')).toEqual([]);
    expect(open('<a>Self-host it</a>')).toEqual(['Self-host it']);
    expect(findSourcePhrases('coming soon, coming soon', SOURCE_STATE_PHRASES)).toEqual([{ label: 'coming soon', count: 2 }]);
  });

  it('ignores a phrase quoted from someone else, but not a half-quoted one', () => {
    // The Retraced comparison quotes its Kubernetes docs page.
    expect(closed('the Kubernetes docs page says &quot;Coming soon&quot;')).toEqual([]);
    expect(closed('Kubernetes page: “Coming soon”')).toEqual([]);
    expect(closed('&quot;Coming soon, they said')).toEqual(['coming soon']);
    expect(closed('Self-hosting is coming soon&quot;')).toEqual(['coming soon']);
  });
});

/**
 * Renders whole pages (root shell, header, footer and route) through the real router, in a fresh module graph so the
 * repository state comes from the environment the test sets.
 */
async function renderPages(paths: string[], env: Record<string, string> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { routeTree } = await import('../routeTree.gen');
  const pages: { path: string; html: string }[] = [];
  for (const path of paths) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), isServer: true });
    await router.load();
    pages.push({ path, html: renderToString(createElement(RouterProvider, { router })) });
  }
  return pages;
}

describe('rendered pages', () => {
  beforeEach(() => {
    // Asset URLs (`?url` imports) are empty under vitest, and React warns about the empty stylesheet href.
    const error = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('href')) {
        error(...args);
      }
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('renders the footer and /open-source link label only when the repository is public', async () => {
    const [publicPage] = await renderPages(['/open-source'], PUBLIC_ENV);
    expect(publicPage?.html).toContain('href="https://github.example.test/acme/logbird"');
    // The footer link and the /open-source button.
    expect(findSourcePhrases(publicPage?.html ?? '', SOURCE_OPEN_PHRASES)).toContainEqual({ label: 'Source on GitHub', count: 2 });
    const [privatePage] = await renderPages(['/open-source']);
    expect(privatePage?.html).toContain('Source on GitHub — coming soon');
    expect(open(privatePage?.html ?? '')).toEqual([]);
  });

  it('says the source is closed on a private site, and never that it is open', async () => {
    const { staticPages } = await import('./site-map');
    const pages = await renderPages(staticPages.map((page) => page.path));
    expect(pages.flatMap(({ path, html }) => open(html).map((label) => `${path}: ${label}`))).toEqual([]);
    expect(pages.filter(({ html }) => closed(html).length).length).toBeGreaterThan(0);
  });

  it('drops every "source is closed" phrase once the repository is public', async () => {
    const { staticPages } = await import('./site-map');
    const pages = await renderPages(
      staticPages.map((page) => page.path),
      PUBLIC_ENV,
    );
    expect(pages.flatMap(({ path, html }) => closed(html).map((label) => `${path}: ${label}`))).toEqual([]);
  });
});
