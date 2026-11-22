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
