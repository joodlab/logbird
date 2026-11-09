import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
import { findSourcePhrases, repositoryReferences, SOURCE_OPEN_PHRASES, SOURCE_STATE_PHRASES } from './source-state';

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
    expect(open('<p><em>Self-host</em>\n  <span>it</span></p>')).toEqual(['Self-host it']);
    // Restored round-2 regression: the key word is a link.
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

  it('keeps links, blocks and list items as separate text units', () => {
    // A leaked link next to an unrelated paragraph that happens to start with the placeholder's words.
    expect(open('<a href="https://github.example.test/acme/logbird">Source on GitHub</a><p>&mdash; coming soon: Cloud hosting.</p>')).toEqual([
      'Source on GitHub',
    ]);
    // The label in a link, the placeholder words outside it: the link is still a link.
    expect(open('<p><a href="/x">Source on GitHub</a> — coming soon</p>')).toEqual(['Source on GitHub']);
    // No false match across independent blocks or list items.
    expect(closed('<p>The deployment is coming</p><p>Soon after launch, we add regions.</p>')).toEqual([]);
    expect(closed('<ul><li>Webhooks are coming</li><li>soon: nothing else</li></ul>')).toEqual([]);
    expect(closed('<td>coming</td><td>soon</td>')).toEqual([]);
    expect(closed('<p>coming<br/>soon</p>')).toEqual([]);
    // The legitimate placeholder, with an icon and inline markup, is one unit.
    expect(open('<span class="x"><svg aria-hidden="true"><path d="M0"/></svg>Source on <b>GitHub</b> — coming soon</span>')).toEqual([]);
  });

  it('catches claims whose key word is an inline link (the joined pass)', () => {
    // Inline-link examples.
    expect(open('<p><a href="/self-hosting">Self-host</a> it</p>')).toEqual(['Self-host it']);
    expect(open('<p>We have <a href="/changelog">released</a> Logbird under MIT.</p>')).toEqual(['released (the source)']);
    expect(closed('<p>Logbird is coming <a href="/roadmap">soon</a>.</p>')).toEqual(['coming soon']);
    // Additional inline-link examples.
    expect(open('<p><a href="/self-hosting">Self-host</a> it today.</p>')).toEqual(['Self-host it']);
    expect(open('<p>We have <a href="/open-source">released</a> the source under MIT.</p>')).toEqual(['released (the source)']);
    // Markup-split, with a button and nested inline markup.
    expect(open('<p>The source is <button type="button"><b>released</b></button> under MIT.</p>')).toEqual(['released (the source)']);
    expect(closed('<p>The <a href="/x"><em>repository</em> opens</a> next month.</p>')).toEqual(['repository opens']);
    // Either pass is enough; the reported count is the larger one, not the sum.
    expect(findSourcePhrases('<p><a href="/s">Self-host</a> it, or Self-host it.</p>', SOURCE_OPEN_PHRASES)).toEqual([
      { label: 'Self-host it', count: 2 },
    ]);
  });

  it('never joins across paragraphs, list items, cells or attributes, in either pass', () => {
    expect(closed('<p>Logbird is coming</p><p><a href="/x">Soon</a> after launch, regions.</p>')).toEqual([]);
    expect(closed('<li><a href="/a">Webhooks are coming</a></li><li><a href="/b">soon: none</a></li>')).toEqual([]);
    expect(open('<p>Read how to <a href="/self-hosting">Self-host</a></p><p>it is a guide.</p>')).toEqual([]);
    expect(closed('<td><a href="/a">coming</a></td><td>soon</td>')).toEqual([]);
    // The placeholder stays legitimate in both passes when the label isn't a link.
    expect(open('<p>Source on GitHub — coming soon.</p>')).toEqual([]);
  });

  it('normalizes typographic apostrophes and quotes', () => {
    expect(closed('The code isn’t public yet.')).toEqual(["isn't public"]);
    expect(closed('The code isn&rsquo;t public yet.')).toEqual(["isn't public"]);
    expect(closed('You’ll be able to self-host it.')).toEqual(["you'll be able to self-host"]);
    expect(closed('Youʼll be able to self-host it.')).toEqual(["you'll be able to self-host"]);
    expect(open('We’ve released our code under MIT.')).toEqual(['released (the source)']);
    expect(open('We&rsquo;ve released our code under MIT.')).toEqual(['released (the source)']);
  });
});

describe('repository references', () => {
  const repository = 'https://github.example.test/acme/logbird';
  it('finds every reference to the repository, in any URL form and any place', () => {
    const html = [
      `<a href="${repository}">Code</a>`,
      `<a href="${repository}/">Code</a>`,
      `<a href="${repository}/tree/main/apps/web">Web</a>`,
      `<a href='${repository}.git'>Clone</a>`,
      `<a href="HTTPS://GITHUB.EXAMPLE.TEST/acme/logbird?tab=readme">Readme</a>`,
      `<a href="${repository}#readme">Readme</a>`,
      `<a href="${repository}/issues?q=a&amp;b">Issues</a>`,
      // Other schemes and forms.
      '<a href="http://github.example.test/acme/logbird">http</a>',
      '<a href="//github.example.test/acme/logbird">protocol-relative</a>',
      '<a href="https://www.github.example.test/acme/logbird">www</a>',
      // Other places: src, action, meta, JSON-LD, code and plain text.
      '<img src="https://github.example.test/acme/logbird/raw/main/logo.png"/>',
      '<form action="https://github.example.test/acme/logbird/issues/new"></form>',
      '<meta property="og:see_also" content="https://github.example.test/acme/logbird"/>',
      '<script type="application/ld+json">{"sameAs":["https:\\/\\/github.example.test\\/acme\\/logbird"]}</script>',
      '<pre><code>git clone https://github.example.test/acme/logbird.git</code></pre>',
      '<p>Clone github.example.test/acme/logbird and run it.</p>',
    ].join('');
    expect(repositoryReferences(html, repository)).toHaveLength(16);
    expect(repositoryReferences(html, `${repository}/`)).toHaveLength(16);
    expect(repositoryReferences(html, 'http://www.github.example.test/acme/logbird.git')).toHaveLength(16);
  });
  it('ignores other repositories, owners and hosts', () => {
    expect(
      repositoryReferences(
        [
          `<a href="${repository}-other">x</a>`,
          '<a href="https://github.example.test/acme">owner</a>',
          '<a href="https://github.example.test/acme/logbirds">longer</a>',
          '<a href="https://notgithub.example.test/acme/logbird">other host</a>',
          '<p>acme/logbird on its own</p>',
        ].join(''),
        repository,
      ),
    ).toEqual([]);
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

  it('says the source is closed on a private site, and never that it is open or links to it', async () => {
    const { staticPages } = await import('./site-map');
    // Private, but with the repository URL already configured: no page may link to it under any label.
    const pages = await renderPages(
      staticPages.map((page) => page.path),
      { WEB_GITHUB_URL: PUBLIC_ENV.WEB_GITHUB_URL },
    );
    expect(pages.flatMap(({ path, html }) => open(html).map((label) => `${path}: ${label}`))).toEqual([]);
    expect(pages.flatMap(({ path, html }) => repositoryReferences(html, PUBLIC_ENV.WEB_GITHUB_URL).map((href) => `${path}: ${href}`))).toEqual([]);
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
    // Positive control for the link check: every page's footer links the repository once it's public.
    expect(pages.every(({ html }) => repositoryReferences(html, PUBLIC_ENV.WEB_GITHUB_URL).length > 0)).toBe(true);
  });
});
