import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import { renderPages } from '../test/render-pages';
import { evidenceLimits } from './evidence-limits';
import { homeContent, homeMetaFor } from './home';
import { scopedReadLimits, scopedReadLimitText } from './scoped-read-limits';
import { SITE, type SiteState } from './site';
import { complianceEvidenceContent } from './use-cases/compliance-evidence';

/**
 * Pages render the typed content modules in this folder, so each claim has one source (#250). A file that has moved holds
 * layout only, and this test fails on a prose literal in it: visible JSX text with a letter, a string of two or more
 * words, a template's text, or any string given to a wording prop (title, label, caption…). Class names, `sizes` and `cn`/`cx` arguments
 * are layout. Files join MOVED as their pages move; the last step lists every route file and marketing component.
 */
const MOVED = [
  'routes/index.tsx',
  'components/marketing/cta-band.tsx',
  'components/marketing/guarantees.tsx',
  'components/marketing/log-stack.tsx',
  'components/marketing/plan-cards.tsx',
  'routes/pricing.tsx',
  'components/marketing/use-case.tsx',
  'routes/use-cases.compliance-evidence.tsx',
  'routes/use-cases.customer-audit-logs.tsx',
  'routes/use-cases.support-investigations.tsx',
  'components/marketing/self-host-cta.tsx',
  'components/marketing/steps.tsx',
  'routes/compare.index.tsx',
  'routes/compare.bemi.tsx',
  'routes/compare.pangea.tsx',
  'routes/compare.retraced.tsx',
  'routes/compare.workos-audit-logs.tsx',
  'components/marketing/comparison-page.tsx',
  'components/marketing/capture-lanes.tsx',
  'routes/developers.tsx',
  'routes/open-source.tsx',
  'components/marketing/feature-row.tsx',
  'routes/about.tsx',
  'routes/contact.tsx',
  'routes/changelog.tsx',
  'routes/product.tsx',
  'routes/cloud.tsx',
  'routes/security.tsx',
  'routes/self-hosting.tsx',
  'routes/legal.privacy.tsx',
  'routes/legal.terms.tsx',
  'components/marketing/legal-document.tsx',
  'lib/legal-facts.tsx',
  'routes/blog.index.tsx',
  'routes/blog.$slug.tsx',
  'components/marketing/blog-article.tsx',
  'routes/404.tsx',
  'components/not-found.tsx',
];

/** Props and keys whose string value is always wording, even one word. */
const WORDING = new Set(['alt', 'aria-label', 'body', 'caption', 'description', 'eyebrow', 'label', 'lead', 'note', 'placeholder', 'text', 'title']);
/**
 * Expressions a string passes through on its way to where it's used: `a ? 'x' : 'y'`, `ok && 'x'`, `{'x'}`, `{['x']}`,
 * `'x' as const`.
 */
const PASS_THROUGH = new Set([
  'ArrayExpression',
  'ConditionalExpression',
  'LogicalExpression',
  'JSXExpressionContainer',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
]);
/** Attributes (and object keys) whose value is layout or a reference, whatever it looks like: classes, styles, ids. */
const LAYOUT_ATTRIBUTES = new Set([
  'className',
  'sizes',
  'style',
  'id',
  'htmlFor',
  'labelledBy',
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
  'role',
  'rel',
  'target',
  'type',
  'd',
  'viewBox',
  'points',
  'transform',
]);
const LAYOUT_KEYS = new Set(['className', 'style', 'sizes']);
const LAYOUT_CALLS = new Set(['cn', 'cx']);
/** A prop named like wording (`frameTitle`, `requiredBadge`, `codeCaption`…) is wording too. */
const WORDING_NAME = /(title|label|badge|caption|text|heading|lead|note|description|eyebrow|prompt)$/i;
/** Two words, the first of at least two letters ("Join a team", "Retrace every step"). */
const TWO_WORDS = /\p{L}{2,}[^\S\n]+\p{L}/u;

interface AstNode {
  type: string;
  start: number;
  [key: string]: unknown;
}
const isNode = (value: unknown): value is AstNode => typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
const nameOf = (node: unknown): string | undefined => {
  if (!isNode(node)) return undefined;
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier') return node.name as string;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'JSXNamespacedName') return `${nameOf(node.namespace)}:${nameOf(node.name)}`;
  return undefined;
};

/** Prose literals in `source`, as `line: "text"`. */
function proseLiterals(source: string, file = 'file.tsx'): string[] {
  const found: string[] = [];
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const visit = (node: AstNode, ancestors: AstNode[]) => {
    // A `…Class` variable holds class names, but only as its own value: an object or array inside it is data.
    const classVariable = ancestors.findLastIndex((up) => up.type === 'VariableDeclarator' && /Class$/.test(nameOf(up.id) ?? ''));
    const layout =
      ancestors.some(
        (up) =>
          (up.type === 'JSXAttribute' && LAYOUT_ATTRIBUTES.has(nameOf(up.name) ?? '')) ||
          // As an object key only class names and styles are layout: a `role`, `type` or `id` key in data can be visible text.
          (up.type === 'Property' && LAYOUT_KEYS.has(nameOf(up.key) ?? '')) ||
          (up.type === 'CallExpression' && LAYOUT_CALLS.has(nameOf(up.callee) ?? '')),
      ) ||
      (classVariable >= 0 && !ancestors.slice(classVariable).some((up) => up.type === 'ObjectExpression' || up.type === 'ArrayExpression'));
    // A module specifier is a path, not words.
    const specifier = ancestors.at(-1)?.source === node;
    // Who receives the string: a prop, an object key, or the element's children (visible text, like JSX text).
    let at = ancestors.length - 1;
    let child: AstNode = node;
    while (at >= 0 && PASS_THROUGH.has((ancestors[at] as AstNode).type)) child = ancestors[at--] as AstNode;
    const holder = ancestors[at];
    const owner =
      holder?.type === 'JSXAttribute'
        ? nameOf(holder.name)
        : holder?.type === 'Property' && holder.value === child
          ? nameOf(holder.key)
          : holder?.type === 'JSXElement' || holder?.type === 'JSXFragment'
            ? 'children'
            : undefined;
    const report = (text: string) => found.push(`${file}:${lineOf(node.start)}: "${text.trim().replace(/\s+/g, ' ')}"`);
    if (node.type === 'JSXText' && /\p{L}/u.test(node.value as string)) report(node.value as string);
    const texts =
      node.type === 'Literal' && typeof node.value === 'string'
        ? [node.value]
        : node.type === 'TemplateElement'
          ? [(node.value as { cooked: string }).cooked]
          : [];
    for (const text of texts) {
      if (layout || specifier) continue;
      const letters = /\p{L}/u.test(text);
      // A template with text around a value is a sentence being built, so any letter counts.
      if (
        TWO_WORDS.test(text) ||
        (letters && node.type === 'TemplateElement') ||
        (letters && owner && (owner === 'children' || WORDING.has(owner) || WORDING_NAME.test(owner)))
      )
        report(text);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) visit(child, [...ancestors, node]);
    }
  };
  visit(parseAst(source, { lang: 'tsx' }) as unknown as AstNode, []);
  return found;
}

describe('content modules', () => {
  it('flags prose and leaves layout alone', () => {
    const sample = [
      "import { x } from 'some module path';",
      'const rowClass = "grid gap-3 px-4";',
      'export const A = () => (',
      '  <section aria-label="The explorer" className="relative overflow-hidden">',
      '    <h2 className={cn("h2 text-lg", on && "border-brand bg-muted")}>Retrace every step.</h2>',
      '    <Frame sizes="(min-width: 1024px) 680px, 100vw" label="Explorer" />{\' \'}→',
      '    <Tabs tabs={[{ id: "route", label: "Route", language: "ts" }]} />',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text for the parser, not a template
      '    {ok ? `Self-host ${version}` : "from source"}',
      "    <p>{'Join'}</p>",
      "    <Badge title={open ? 'Public' : 'Private'} />",
      '    <Rich text="Join a team" />',
      "    <h1>{['Join a team']}</h1>",
      `    <div style={{ gridTemplateAreas: '"hero main"' }} aria-labelledby="hero-title hero-status" />`,
      '  </section>',
      ');',
      "const planClass = { className: 'grid gap-2', label: 'Plans' };",
      "const flow = [{ name: 'API', role: 'Validates each event' }];",
      'const E = () => <Envelope frameTitle="POST /v1/events" requiredBadge="required" />;',
    ].join('\n');
    expect(proseLiterals(sample)).toEqual([
      'file.tsx:4: "The explorer"',
      'file.tsx:5: "Retrace every step."',
      'file.tsx:6: "Explorer"',
      'file.tsx:7: "Route"',
      'file.tsx:8: "Self-host"',
      'file.tsx:8: "from source"',
      'file.tsx:9: "Join"',
      'file.tsx:10: "Public"',
      'file.tsx:10: "Private"',
      'file.tsx:11: "Join a team"',
      'file.tsx:12: "Join a team"',
      // Line 13: a style value and an id list are layout and references, not prose.
      // The class-name exemption covers the variable's own value, not data nested in it.
      'file.tsx:16: "Plans"',
      // A `role` key in data is visible text (the architecture figure renders it), unlike the JSX `role` attribute.
      'file.tsx:17: "Validates each event"',
      // Props named like wording are wording.
      'file.tsx:18: "POST /v1/events"',
      'file.tsx:18: "required"',
    ]);
  });

  it('moved route files and components hold layout, not prose', () => {
    const src = fileURLToPath(new URL('../', import.meta.url));
    const found = MOVED.flatMap((file) => proseLiterals(readFileSync(`${src}${file}`, 'utf8'), file));
    expect(found, 'move these words into a module under src/content/').toEqual([]);
  });

  it('home has every state variant, and data-derived values come from the state', () => {
    const state = (overrides: Partial<SiteState>): SiteState => ({ repoPublic: true, cloudOpen: false, scopedReadLive: false, ...overrides });
    const closedPrivate = homeContent(state({ repoPublic: false }));
    const openPublic = homeContent(
      state({ cloudOpen: true, signInUrl: 'https://app.example.test/login', githubUrl: 'https://github.example.test/acme/logbird/' }),
    );
    expect(closedPrivate.hero.primaryCta.label).toBe('Join the waitlist');
    expect(closedPrivate.hero.status).toBe('Source on GitHub — coming soon. Logbird Cloud is not open yet.');
    expect(closedPrivate.hero.lead).toContain('once the source opens, or join the waitlist for Logbird Cloud.');
    expect(closedPrivate.hero.signIn).toBeUndefined();
    expect(closedPrivate.hero.github).toBeUndefined();
    expect(closedPrivate.developers.otherStacks.link).toBeUndefined();
    expect(openPublic.hero.primaryCta.label).toBe('Request access');
    expect(openPublic.hero.lead).toMatch(/run it on your own servers, or ask for early access to Logbird Cloud\.$/);
    expect(openPublic.hero.signIn?.href).toBe('https://app.example.test/login');
    expect(openPublic.hero.github?.href).toBe('https://github.example.test/acme/logbird/');
    expect(openPublic.developers.otherStacks.link?.href).toBe('https://github.example.test/acme/logbird/tree/master/sdks/dotnet');
    for (const repoPublic of [true, false]) {
      for (const cloudOpen of [true, false]) {
        const { description, fullTitle } = homeMetaFor(state({ repoPublic, cloudOpen }));
        expect(description.length, description).toBeLessThanOrEqual(155);
        expect(/self-host it/i.test(description), description).toBe(repoPublic);
        expect(/open-source/i.test(fullTitle), fullTitle).toBe(repoPublic);
      }
    }
    // No time claim until a measured, dated value exists (marketing/copy/home.md, Numbers).
    expect(openPublic.searchLatency).toBeUndefined();
  });

  it('home shows reading through your backend until scoped read access is proven, then scoped access in one change', async () => {
    const env = { WEB_GITHUB_PUBLIC: 'true', WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
    const [page] = await renderPages(['/'], env);
    // The page's text without tags, and each module text without its inline-code backticks, as Rich renders them.
    const html = (page?.html ?? '')
      .replace(/<[^>]+>/g, '')
      .replaceAll('&#x27;', "'")
      .replaceAll('&quot;', '"');
    const shownText = (text: string | undefined) => (text ?? '').replaceAll('`', '');
    const current = homeContent({ repoPublic: true, cloudOpen: false, scopedReadLive: false });
    const proven = homeContent({ repoPublic: true, cloudOpen: false, scopedReadLive: true });
    // What the page renders: the state SITE.scopedReadLive selects.
    const shown = SITE.scopedReadLive ? proven : current;
    for (const text of [
      shown.hero.title,
      shown.customers.access.points[0]?.title,
      shown.customers.access.limit,
      shown.evidence.rows[2]?.limit,
      shown.developers.otherStacks.text,
    ]) {
      expect(html).toContain(shownText(text));
    }
    // The other state's limit is not on the page.
    expect(html).not.toContain(shownText((SITE.scopedReadLive ? current : proven).customers.access.limit));
    // The page shows the state SCOPED_READ_LIVE selects: scoped access once its production proof is confirmed.
    expect(html.includes('Viewer tokens'), 'scoped access shown').toBe(SITE.scopedReadLive);
    // The route renders `customers.access`: the backend state now, the scoped state once proven.
    expect(current.customers.access).toBe(current.customers.now);
    expect(proven.customers.access).toBe(proven.customers.scoped);
    expect(proven.customers.access.points.map((point) => point.title)).toContain('Viewer tokens');
  }, 60_000);

  it('a private build never calls the source open-source: home social card, and the pages a visitor reaches from home', async () => {
    expect(homeMetaFor({ repoPublic: false, cloudOpen: false, scopedReadLive: false }).ogDescription).not.toMatch(/open.source/i);
    expect(homeMetaFor({ repoPublic: true, cloudOpen: false, scopedReadLive: false }).ogDescription).toMatch(/open-source/i);
    const github = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
    for (const env of [github, { ...github, WEB_APP_URL: 'https://app.example.test' }]) {
      for (const { path, html } of await renderPages(['/', '/cloud', '/about', '/blog'], env)) {
        // Descriptions, social titles and the visible hero; the /open-source nav label names a page, not the licence.
        const meta = [...html.matchAll(/<meta [^>]*content="([^"]*)"/g)].map(([, content]) => content).join(' | ');
        expect(meta, `${path} meta`).not.toMatch(/open-source/i);
        expect(html, `${path} body`).not.toMatch(/open-source codebase|an open-source audit log/i);
      }
    }
  }, 60_000);

  it('every repository and Cloud state renders a page that matches that state', async () => {
    const github = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
    const states = [
      { name: 'public, Cloud closed', env: { ...github, WEB_GITHUB_PUBLIC: 'true' }, repoPublic: true, cloudOpen: false },
      {
        name: 'public, Cloud open',
        env: { ...github, WEB_GITHUB_PUBLIC: 'true', WEB_APP_URL: 'https://app.example.test' },
        repoPublic: true,
        cloudOpen: true,
      },
      { name: 'private, Cloud closed', env: github, repoPublic: false, cloudOpen: false },
      { name: 'private, Cloud open', env: { ...github, WEB_APP_URL: 'https://app.example.test' }, repoPublic: false, cloudOpen: true },
    ];
    for (const state of states) {
      const [page] = await renderPages(['/'], state.env);
      const text = (page?.html ?? '')
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replaceAll('&#x27;', "'")
        .replaceAll('&quot;', '"')
        .replace(/\s+/g, ' ');
      const where = `/ (${state.name})`;
      if (state.cloudOpen) {
        // Open: access requests, never a waitlist or a future service.
        expect(text, where).not.toMatch(/waitlist|we will run|when it opens|isn't open yet/i);
        expect(text, where).toContain('Request access');
      } else {
        // Closed: never a service that runs today, and never "…or ours" as if it did.
        expect(text, where).not.toMatch(/early access|we run the servers|or on ours/i);
        expect(text, where).toContain('Join the waitlist');
      }
      if (!state.repoPublic) {
        // Anywhere on the page, the <title> and social titles included.
        expect(text, where).not.toMatch(/open-source|Open source and|self-host it\b/i);
        expect(page?.html ?? '', where).not.toMatch(/content="[^"]*open-source[^"]*"/i);
      }
      // No legal-hold roadmap claim, no unmeasured time, no assurance words.
      expect(text, where).not.toMatch(/on the roadmap|within seconds|tamper|immutable|certified|verify integrity/i);
    }
  }, 120_000);
});

describe('evidence limits', () => {
  it('the landing evidence table and the compliance page render the same retention and export limits', async () => {
    const home = homeContent(SITE).evidence.rows;
    expect(home[1]?.limit).toBe(evidenceLimits.shortenRetention);
    expect(home[2]?.limit).toBe(evidenceLimits.exportMatch);
    const sections = complianceEvidenceContent(SITE).sections;
    expect(sections.find((section) => section.id === 'retention')?.limits?.rows[1]?.limit).toBe(evidenceLimits.shortenRetention);
    expect(sections.find((section) => section.id === 'export')?.limit?.text).toBe(evidenceLimits.exportMatch);

    // Both pages show both sentences, and no page says the deletion starts "immediately" (maintainer rule).
    const pages = await renderPages(['/', '/use-cases/compliance-evidence', '/security']);
    for (const { path, html } of pages) {
      const text = html
        .replace(/<[^>]+>/g, '')
        .replaceAll('&#x27;', "'")
        .replaceAll('&quot;', '"');
      expect(text, path).not.toMatch(/starts immediately/i);
      if (path === '/security') continue;
      expect(text, path).toContain(evidenceLimits.shortenRetention);
      expect(text, path).toContain(evidenceLimits.exportMatch);
    }
  }, 60_000);
});

describe('scoped read limits', () => {
  const text = (html: string) =>
    html
      .replace(/<[^>]+>/g, '')
      .replaceAll('&#x27;', "'")
      .replaceAll('&quot;', '"');
  const shown = (value: string) => value.replaceAll('`', '');

  // The approved wording, pinned here rather than read from the module under test (maintainer, #270 and #286), so an
  // edit to scoped-read-limits.ts fails this test until the copy is re-approved.
  const APPROVED = {
    scope: 'One customer account per scope, matched on the id Logbird stored.',
    layers:
      "Logbird's query builders always apply the scope. ClickHouse checks the customer account as well once the restricted query user has its tenant row policy: the Compose and Coolify stacks install it on upgrade, and a source installation runs create-query-user once.",
    origins: 'A web page on another origin can read with a token only if that origin is listed on the key.',
  };

  it('the module holds the approved wording', () => {
    expect(shown(scopedReadLimits.scope)).toBe(APPROVED.scope);
    expect(shown(scopedReadLimits.layers)).toBe(APPROVED.layers);
    expect(shown(scopedReadLimits.origins)).toBe(APPROVED.origins);
    expect(shown(scopedReadLimitText)).toBe(`${APPROVED.scope} ${APPROVED.layers} ${APPROVED.origins}`);
    expect(scopedReadLimits.enforced).toEqual({ label: 'How it is enforced', to: '/security', hash: 'scoped-reads' });
  });

  it('with scoped read access on, the landing page shows the first sentence and the link; /security § Scoped reads shows all three', async () => {
    const scoped = homeContent({ ...SITE, scopedReadLive: true }).customers.scoped;
    expect(scoped.limit).toBe(APPROVED.scope);
    expect(homeContent({ ...SITE, scopedReadLive: false }).customers.access.limitLink).toBeUndefined();
    expect(SITE.scopedReadLive).toBe(true);
    const pages = await renderPages(['/', '/security', '/use-cases/customer-audit-logs']);
    const page = (path: string) => pages.find((entry) => entry.path === path)?.html ?? '';
    // Landing: exactly the scope sentence and the link in the limit box, not the layers or origins sentences.
    const box = /<strong[^>]*>The limit<\/strong>([\s\S]*?)<\/p>/.exec(page('/'))?.[1] ?? '';
    expect(text(box).replace(/\s+/g, ' ').trim()).toBe(`: ${APPROVED.scope} How it is enforced`);
    expect(box).toMatch(/<a[^>]*href="\/security#scoped-reads"[^>]*>How it is enforced<\/a>/);
    expect(text(page('/'))).not.toContain(APPROVED.layers);
    // /security: the anchored block holds exactly the three sentences, under their titles.
    const block = /<section[^>]*id="scoped-reads"[^>]*>([\s\S]*?)<\/section>/.exec(page('/security'))?.[1] ?? '';
    for (const sentence of Object.values(APPROVED)) expect(text(block)).toContain(sentence);
    // The customer page: the whole limit, in order.
    expect(text(page('/use-cases/customer-audit-logs'))).toContain(`${APPROVED.scope} ${APPROVED.layers} ${APPROVED.origins}`);
  }, 60_000);

  it('each code block that scrolls sideways is a titled keyboard stop, with its own copy button before the scroll area', async () => {
    const [page] = await renderPages(['/use-cases/compliance-evidence']);
    const html = page?.html ?? '';
    // One match per block: its title bar (with the copy button) and then its <pre>.
    const blocks = [...html.matchAll(/<div class="site-code[^"]*">([\s\S]*?)<\/pre>/g)].map(([, inner]) => inner ?? '');
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      const copyAt = block.indexOf('aria-label="Copy code"');
      const preAt = block.indexOf('<pre');
      expect(copyAt, 'copy button in this block').toBeGreaterThan(-1);
      expect(preAt).toBeGreaterThan(copyAt);
      const pre = /<pre([^>]*)>/.exec(block)?.[1] ?? '';
      expect(pre).toMatch(/tabindex="0"/i);
      expect(pre).toMatch(/title="[^"]+ code"/);
      expect(pre).toContain('overflow-x-auto');
      expect(pre).not.toContain('whitespace-pre-wrap');
    }
  }, 60_000);
});
