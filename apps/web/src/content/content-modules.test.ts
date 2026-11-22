import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import { renderPages } from '../test/render-pages';
import { homeContent } from './home';
import type { SiteState } from './site';

/**
 * Pages render the typed content modules in this folder, so each claim has one source (#250). A file that has moved holds
 * layout only, and this test fails on a prose literal in it: visible JSX text with a letter, a string of two or more
 * words, a template's text, or any string given to a wording prop (title, label, caption…). Class names, `sizes` and `cn`/`cx` arguments
 * are layout. Files join MOVED as their pages move; the last step lists every route file and marketing component.
 */
const MOVED = [
  'routes/index.tsx',
  'components/marketing/cta-band.tsx',
  'components/marketing/envelope.tsx',
  'components/marketing/log-stack.tsx',
  'components/marketing/self-host-cta.tsx',
  'components/marketing/steps.tsx',
];

/** Props and keys whose string value is always wording, even one word. */
const WORDING = new Set(['alt', 'aria-label', 'body', 'caption', 'description', 'eyebrow', 'label', 'lead', 'note', 'placeholder', 'title']);
/** Attributes whose value is layout, whatever it looks like. */
const LAYOUT_ATTRIBUTES = new Set(['className', 'sizes']);
const LAYOUT_CALLS = new Set(['cn', 'cx']);
const TWO_WORDS = /\p{L}{2,}[^\S\n]+\p{L}{2,}/u;

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
    const layout = ancestors.some(
      (up) =>
        (up.type === 'JSXAttribute' && LAYOUT_ATTRIBUTES.has(nameOf(up.name) ?? '')) ||
        (up.type === 'CallExpression' && LAYOUT_CALLS.has(nameOf(up.callee) ?? '')) ||
        (up.type === 'VariableDeclarator' && /Class$/.test(nameOf(up.id) ?? '')),
    );
    // A module specifier is a path, not words.
    const specifier = ancestors.at(-1)?.source === node;
    const parent = ancestors.at(-1);
    const owner =
      parent?.type === 'JSXAttribute' || (parent?.type === 'JSXExpressionContainer' && ancestors.at(-2)?.type === 'JSXAttribute')
        ? nameOf((parent.type === 'JSXAttribute' ? parent : ancestors.at(-2))?.name)
        : parent?.type === 'Property' && parent.value === node
          ? nameOf(parent.key)
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
      if (TWO_WORDS.test(text) || (letters && node.type === 'TemplateElement') || (letters && owner && WORDING.has(owner))) report(text);
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
      '  </section>',
      ');',
    ].join('\n');
    expect(proseLiterals(sample)).toEqual([
      'file.tsx:4: "The explorer"',
      'file.tsx:5: "Retrace every step."',
      'file.tsx:6: "Explorer"',
      'file.tsx:7: "Route"',
      'file.tsx:8: "Self-host"',
      'file.tsx:8: "from source"',
    ]);
  });

  it('moved route files and components hold layout, not prose', () => {
    const src = fileURLToPath(new URL('../', import.meta.url));
    const found = MOVED.flatMap((file) => proseLiterals(readFileSync(`${src}${file}`, 'utf8'), file));
    expect(found, 'move these words into a module under src/content/').toEqual([]);
  });

  it('home has every state variant, and data-derived values come from the state', () => {
    const state = (overrides: Partial<SiteState>): SiteState => ({ repoPublic: true, cloudOpen: false, ...overrides });
    const closedPrivate = homeContent(state({ repoPublic: false }));
    const openPublic = homeContent(state({ cloudOpen: true, signInUrl: 'https://app.example.test/login', selfHostVersion: '9.9.9' }));
    expect(closedPrivate.hero.primaryCta.label).toBe('Join the waitlist');
    expect(closedPrivate.hero.status).toBe('Source on GitHub — coming soon. Logbird Cloud is not open yet.');
    expect(closedPrivate.hero.signIn).toBeUndefined();
    expect(closedPrivate.openSource.quickstart.kind).toBe('private');
    expect(openPublic.hero.primaryCta.label).toBe('Request access');
    expect(openPublic.hero.signIn?.href).toBe('https://app.example.test/login');
    expect(openPublic.openSource.quickstart).toMatchObject({ kind: 'public', title: 'Self-host 9.9.9' });
  });

  it('home renders its module', async () => {
    const [page] = await renderPages(['/'], { WEB_GITHUB_PUBLIC: 'true', WEB_GITHUB_URL: 'https://github.com/example-org/logbird' });
    const html = page?.html ?? '';
    const home = homeContent({ repoPublic: true, cloudOpen: false });
    for (const text of [home.hero.title, home.developers.title, home.operators.features.retention.body, home.guarantees.cta.label]) {
      expect(html).toContain(text.replaceAll('"', '&quot;').replaceAll("'", '&#x27;'));
    }
  }, 60_000);
});
