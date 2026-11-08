import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
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

  it('counts quoted first-party claims; only explicitly marked third-party quotations are left out', () => {
    // A leaked public link in quotation marks still fails a private build.
    expect(open('<a href="https://github.example.test/acme/logbird">&quot;Source on GitHub&quot;</a>')).toEqual(['Source on GitHub']);
    expect(open('<p>“We released it under MIT.”</p>')).toEqual(['released (the source)']);
    // Quoted closed-source copy still fails a public build.
    expect(closed('<p>Logbird is &quot;coming soon&quot;.</p>')).toEqual(['coming soon']);
    expect(closed('<p>Self-hosting is “coming soon”.</p>')).toEqual(['coming soon']);
    // The comparison pages mark what they quote from another product's docs (Rich thirdPartyQuotes).
    expect(closed('the Kubernetes docs page says <span data-third-party-quote="">&quot;Coming soon&quot;</span>')).toEqual([]);
    // The marker covers its own element only.
    expect(closed('<span data-third-party-quote="">"Coming soon"</span> and Logbird is coming soon')).toEqual(['coming soon']);
    expect(closed('<span data-third-party-quotes-like="">coming soon</span>')).toEqual(['coming soon']);
  });

  it('matches claims split across markup, on the visible text', () => {
    expect(open('<p>We have <b>released</b> Logbird under MIT.</p>')).toEqual(['released (the source)']);
    expect(open('<p>The code is <em>released</em> <strong>under MIT</strong>.</p>')).toEqual(['released (the source)']);
    expect(open('<p>Logbird is released <strong>under MIT</strong>.</p>')).toEqual(['released (the source)']);
    expect(open('<p><a href="/self-hosting">Self-host</a>\n  <span>it</span></p>')).toEqual(['Self-host it']);
    expect(closed('<p>The repository <!-- note --> <b>is public</b> soon? No: it <i>isn&#39;t public</i>.</p>')).toEqual([
      'repository is public',
      "isn't public",
    ]);
    expect(open('<p>Not released <b>under</b> any licence yet.</p>')).toEqual([]);
  });

  it('checks text-bearing attributes, each on its own', () => {
    expect(closed('<meta name="description" content="One repository that opens publicly soon."/>')).toEqual(['opens publicly soon']);
    expect(open('<img alt="Source on GitHub" src="/x.png"/>')).toEqual(['Source on GitHub']);
    // A phrase can't run from one attribute into the next.
    expect(closed('<meta content="Self-hosting is coming"/><meta content="soon to a server near you"/>')).toEqual([]);
  });
});

describe('rendered pages', () => {
  beforeEach(quietHrefWarnings);
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
    // Third-party quotation markers appear only on comparison pages, and only around double-quoted passages.
    const marked = pages.flatMap(({ path, html }) =>
      [...html.matchAll(/<span data-third-party-quote="">([^<]*)<\/span>/g)].map((match) => ({ path, text: match[1] ?? '' })),
    );
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.filter(({ path }) => !path.startsWith('/compare/'))).toEqual([]);
    expect(marked.every(({ text }) => /^(&quot;|")[^"]+(&quot;|")$/.test(text))).toBe(true);
    expect(pages.reduce((sum, { html }) => sum + html.split('data-third-party-quote').length - 1, 0)).toBe(marked.length);
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
