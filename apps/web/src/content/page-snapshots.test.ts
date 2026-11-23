import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { elements, isBlock, type PageElement, parsePage } from '../lib/page-dom';
import { prerenderPaths } from '../lib/site-map';
import { quietHrefWarnings, renderPages } from '../test/render-pages';

/**
 * Rendered-page snapshots: every prerendered page and the 404, in each repository × Cloud state, as one readable text
 * file under __snapshots__/pages/<state>/<page>.txt. Each file lists the page's <title> and description, its headings,
 * its visible text one block per line (header, main and footer, screen-reader-only and hidden text marked), its links
 * with their targets and its form controls. So ANY rendered change (a dropped or reordered list item, a changed link
 * target, a renamed form option, two values swapped, a changed table cell or sentence) shows up as a snapshot diff that
 * a reviewer reads in the pull request. content-modules.test.ts keeps the wording in the modules; this file pins what
 * the pages show.
 *
 * Changing a page on purpose: run
 * `pnpm --filter @logbird/web exec vitest run src/content/page-snapshots.test.ts --update` (`-u` before the path takes
 * the path as its value), review the git diff of the .txt files (only the changes you meant, in every state they apply
 * to) and commit them with the change. In CI (CI=true) a missing snapshot fails, and the last test fails on a snapshot
 * file no page writes any more. Asset cache versions (`?v=`) are masked; nothing depends on the clock or the machine.
 */

const GITHUB = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
const OPEN = { WEB_APP_URL: 'https://app.example.test' };
/** The four states content-modules.test.ts renders; every other key keeps its vitest.config.ts value. */
const STATES = [
  { name: 'private-cloud-closed', env: GITHUB },
  { name: 'private-cloud-open', env: { ...GITHUB, ...OPEN } },
  { name: 'public-cloud-closed', env: { ...GITHUB, WEB_GITHUB_PUBLIC: 'true' } },
  { name: 'public-cloud-open', env: { ...GITHUB, WEB_GITHUB_PUBLIC: 'true', ...OPEN } },
];
const PATHS = [...prerenderPaths, '/404'];
const slug = (path: string) => (path === '/' ? 'home' : path.slice(1).replaceAll('/', '--'));
const SNAPSHOTS = fileURLToPath(new URL('./__snapshots__/pages/', import.meta.url));

/** Never page text: the document head, scripts, styles, templates and drawings. */
const SKIP = new Set(['head', 'script', 'style', 'template', 'svg']);
const CONTROLS = new Set(['form', 'input', 'select', 'option', 'textarea', 'button']);
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const maskUrl = (url: string) => url.replace(/\?v=[\w-]+/g, '?v=*');

/** Why a reader may not see an element's text as written, or undefined when they do. */
function markOf(element: PageElement): string | undefined {
  if (element.tag === 'noscript') return 'noscript';
  if (element.attrs['aria-hidden'] === 'true') return 'aria-hidden';
  if ('hidden' in element.attrs) return 'hidden';
  if ((element.attrs.class ?? '').split(/\s+/).includes('sr-only')) return 'sr-only';
  return undefined;
}

const ancestors = (element: PageElement) => {
  const list: PageElement[] = [];
  for (let node = element.parent; node; node = node.parent) list.unshift(node);
  return list;
};
const skipped = (element: PageElement) => [element, ...ancestors(element)].some((node) => SKIP.has(node.tag));
const marksAbove = (element: PageElement) => ancestors(element).flatMap((node) => markOf(node) ?? []);
const prefix = (marks: string[]) => (marks.length ? `[${marks.join(', ')}] ` : '');

/** A flex or grid container (at any breakpoint): its element children are laid out apart, so each starts a line. */
const layoutContainer = (element: PageElement) =>
  (element.attrs.class ?? '').split(/\s+/).some((token) => /^(?:[\w-]+:)*(?:inline-)?(?:flex|grid)$/.test(token));

/** Elements whose position carries meaning even when empty: list items, table cells and definition parts. */
const STRUCTURAL = new Set(['li', 'td', 'th', 'dt', 'dd']);

/** Raw text of a <pre>, its lines kept. */
const rawText = (node: PageElement | string): string => (typeof node === 'string' ? node : node.children.map(rawText).join(''));

/**
 * The visible text below `root`, one line per run of inline text, in document order. A block element starts a new
 * line, and so does each item of a flex or grid container. Marked inline text reads `[sr-only: …]`, and a line inside a
 * marked block starts with `[sr-only]`. An image with alt text reads `[img: …]`; a <pre> keeps its own lines.
 */
function textLines(root: PageElement, rootMarks: string[] = []): string[] {
  const out: string[] = [];
  let run = '';
  const flush = (marks: string[]) => {
    const text = squash(run);
    if (text) out.push(`${prefix(marks)}${text}`);
    run = '';
  };
  const walk = (node: PageElement, marks: string[]) => {
    const items = layoutContainer(node);
    for (const child of node.children) {
      if (typeof child === 'string') {
        run += child;
        continue;
      }
      if (SKIP.has(child.tag)) continue;
      const mark = markOf(child);
      const inner = mark ? [...marks, mark] : marks;
      if (child.tag === 'br') {
        flush(marks);
      } else if (child.tag === 'img') {
        if (child.attrs.alt) run += ` [img: ${child.attrs.alt}] `;
      } else if (child.tag === 'pre') {
        flush(marks);
        const lines = rawText(child).split('\n');
        while (lines.length && !lines[0]?.trim()) lines.shift();
        while (lines.length && !lines.at(-1)?.trim()) lines.pop();
        for (const line of lines) out.push(`${prefix(inner)}pre|${line.trimEnd() ? ` ${line.trimEnd()}` : ''}`);
      } else if (items || isBlock(child)) {
        flush(marks);
        const before = out.length;
        walk(child, inner);
        flush(inner);
        // A list item, table cell or definition with no text still counts: an added empty item or a cell that shifts
        // the others one column along must show in the snapshot, not disappear.
        if (out.length === before && STRUCTURAL.has(child.tag)) out.push(`${prefix(inner)}∅ ${child.tag}`);
      } else if (mark) {
        run += ` [${mark}: `;
        walk(child, inner);
        run += '] ';
      } else {
        walk(child, marks);
      }
    }
  };
  walk(root, rootMarks);
  flush(rootMarks);
  return out;
}

/** An element's text on one line; its blocks joined by " | ". */
const flat = (element: PageElement) => textLines(element).join(' | ');

function controlLine(element: PageElement, labels: Map<string, PageElement>): string {
  const { attrs, tag } = element;
  const parts: string[] = [tag];
  const quoted = (name: string, value: string) => parts.push(`${name}=${JSON.stringify(squash(value))}`);
  if (tag === 'form') {
    for (const name of ['action', 'method']) if (name in attrs) quoted(name, attrs[name] ?? '');
    return `${prefix(marksAbove(element))}${parts.join(' ')}`;
  }
  for (const name of ['type', 'name', 'value', 'placeholder']) if (name in attrs) quoted(name, maskUrl(attrs[name] ?? ''));
  for (const name of ['required', 'checked', 'selected', 'disabled', 'readonly', 'multiple']) if (name in attrs) parts.push(name);
  if (attrs['aria-label']) quoted('aria-label', attrs['aria-label']);
  if ((tag === 'option' || tag === 'button') && flat(element)) quoted('text', flat(element));
  if (tag === 'textarea') quoted('value', rawText(element));
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const label = (attrs.id && labels.get(attrs.id)) || ancestors(element).findLast((node) => node.tag === 'label');
    if (label) quoted('label', flat(label));
  }
  return `${prefix(marksAbove(element))}${parts.join(' ')}`;
}

/** The snapshot text of one rendered page. */
function pageSnapshot(html: string): string {
  const root = parsePage(html);
  const all = [...elements(root)];
  const shown = all.filter((element) => !skipped(element));
  const title = all.find((element) => element.tag === 'title');
  const description = all.find((element) => element.tag === 'meta' && element.attrs.name === 'description');
  const body = all.find((element) => element.tag === 'body') ?? root;
  const labels = new Map(
    shown.filter((element) => element.tag === 'label' && element.attrs.for).map((element) => [element.attrs.for as string, element]),
  );
  const headings = shown
    .filter((element) => /^h[1-6]$/.test(element.tag))
    .map((element) => `${prefix(marksAbove(element))}${element.tag} ${flat(element)}`);
  const links = shown
    .filter((element) => element.tag === 'a')
    .map((element) => {
      const label = element.attrs['aria-label'] ? ` [aria-label: ${squash(element.attrs['aria-label'])}]` : '';
      return `${prefix(marksAbove(element))}${flat(element) || '(no text)'}${label} → ${maskUrl(element.attrs.href ?? '(no href)')}`;
    });
  const controls = shown.filter((element) => CONTROLS.has(element.tag)).map((element) => controlLine(element, labels));
  return [
    `title: ${title ? squash(rawText(title)) : '(none)'}`,
    `description: ${squash(description?.attrs.content ?? '(none)')}`,
    '',
    'headings:',
    ...headings,
    '',
    'text:',
    ...textLines(body),
    '',
    'links:',
    ...links,
    '',
    'controls:',
    ...controls,
    '',
  ].join('\n');
}

describe.each(STATES)('rendered pages, $name', ({ name, env }) => {
  const rendered = new Map<string, string>();
  beforeAll(async () => {
    quietHrefWarnings();
    // The page list comes from this state's own module graph, so a page that only one state publishes can't be missed.
    await renderPages([], env);
    const stateMap = await import('../lib/site-map');
    expect([...stateMap.prerenderPaths, '/404'], 'the page list differs in this state; derive PATHS per state').toEqual(PATHS);
    for (const { path, html } of await renderPages(PATHS, env)) rendered.set(path, html);
  }, 180_000);
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(PATHS)('%s', async (path) => {
    const html = rendered.get(path);
    if (!html) throw new Error(`${path} did not render`);
    await expect(pageSnapshot(html)).toMatchFileSnapshot(`./__snapshots__/pages/${name}/${slug(path)}.txt`);
  });
});

// Vitest writes new file snapshots after the run and never reports one that no test reads, so this catches the stale
// ones (a missing one fails the page's own test in CI).
it('every snapshot file belongs to a rendered page and state', () => {
  const expected = new Set(STATES.flatMap(({ name }) => PATHS.map((path) => `${name}/${slug(path)}.txt`)));
  const onDisk = (existsSync(SNAPSHOTS) ? readdirSync(SNAPSHOTS, { recursive: true, encoding: 'utf8' }) : [])
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.txt'));
  expect(
    onDisk.filter((file) => !expected.has(file)),
    'snapshot files no page writes any more: delete them',
  ).toEqual([]);
});
