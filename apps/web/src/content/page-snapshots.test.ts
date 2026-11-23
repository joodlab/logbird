import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { elements, isBlock, type PageElement, parsePage } from '../lib/page-dom';
import { prerenderPaths } from '../lib/site-map';
import { quietHrefWarnings, renderPages } from '../test/render-pages';

/**
 * Rendered-page snapshots: every prerendered page and the 404, in each repository × Cloud state, as readable text files
 * under __snapshots__/pages/<state>/. A page's file (<page>.txt) lists its <title> and description, then the headings,
 * visible text (one block per line, screen-reader-only and hidden text marked), links with their targets and form
 * controls of its own content: <main>, plus anything <body> renders outside <main> and the shell (nothing today; it would
 * get its own section rather than be dropped). The shared shell (the skip link, the header and the footer) is in one file
 * per state, _shell.txt, and a test holds every page to it: the same text, and the same markup apart from the router's
 * active-link marks, which must sit exactly on the links to the current page and its section. So ANY rendered change (a
 * dropped or reordered list item, a changed link target, a renamed form option, two values swapped, a changed table cell
 * or sentence) is a snapshot diff a reviewer reads in the pull request, and a header or footer change is one diff per
 * state, not one per page. content-modules.test.ts keeps the wording in the modules; this file pins what the pages show.
 *
 * Changing a page on purpose: run
 * `pnpm --filter @logbird/web exec vitest run src/content/page-snapshots.test.ts --update` (`-u` before the path takes
 * the path as its value), review the git diff of the .txt files (only the changes you meant, in every state they apply
 * to) and commit them with the change (CONTRIBUTING.md, "Page snapshots"). In CI (CI=true) the snapshots are only
 * verified: a missing or different one fails, `--update` fails before anything is written, and the last test fails on a
 * snapshot file no page writes any more. Asset cache versions (`?v=`) are masked; nothing depends on the clock or the
 * machine.
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
/** The shared shell's snapshot in each state's folder; no page slug starts with an underscore. */
const SHELL = '_shell.txt';

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

/** The parts of a rendered page: the document head's title and description, the shared shell, <main> and the rest. */
interface PageParts {
  all: PageElement[];
  labels: Map<string, PageElement>;
  /** The skip link, the site header and the site footer: the same on every page of a state. */
  shell: PageElement[];
  main: PageElement[];
  /** Anything else <body> renders outside <main> and the shell (none today); kept in the page snapshot, never dropped. */
  outside: PageElement[];
}

const isShell = (element: PageElement) =>
  element.tag === 'header' || element.tag === 'footer' || (element.tag === 'a' && (element.attrs.class ?? '').split(/\s+/).includes('skip-link'));

function pageParts(html: string): PageParts {
  const root = parsePage(html);
  const all = [...elements(root)];
  const body = all.find((element) => element.tag === 'body');
  if (!body) throw new Error('The page has no <body>');
  const regions = body.children.filter((child): child is PageElement => typeof child !== 'string' && !SKIP.has(child.tag));
  return {
    all,
    labels: new Map(
      all
        .filter((element) => element.tag === 'label' && element.attrs.for && !skipped(element))
        .map((element) => [element.attrs.for as string, element]),
    ),
    shell: regions.filter(isShell),
    main: regions.filter((element) => element.tag === 'main'),
    outside: regions.filter((element) => !(isShell(element) || element.tag === 'main')),
  };
}

/** Headings, visible text, links and form controls of the given regions, in document order. */
function regionSections(regions: PageElement[], labels: Map<string, PageElement>): string[] {
  const shown = regions.flatMap((region) => [region, ...elements(region)]).filter((element) => !skipped(element));
  const headings = shown
    .filter((element) => /^h[1-6]$/.test(element.tag))
    .map((element) => `${prefix(marksAbove(element))}${element.tag} ${flat(element)}`);
  const text = regions.flatMap((region) => {
    const own = markOf(region);
    const marks = [...marksAbove(region), ...(own ? [own] : [])];
    const lines = textLines(region, marks);
    return lines.length ? lines : [`${prefix(marks)}∅ ${region.tag}`];
  });
  const links = shown
    .filter((element) => element.tag === 'a')
    .map((element) => {
      const label = element.attrs['aria-label'] ? ` [aria-label: ${squash(element.attrs['aria-label'])}]` : '';
      return `${prefix(marksAbove(element))}${flat(element) || '(no text)'}${label} → ${maskUrl(element.attrs.href ?? '(no href)')}`;
    });
  const controls = shown.filter((element) => CONTROLS.has(element.tag)).map((element) => controlLine(element, labels));
  return ['headings:', ...headings, '', 'text:', ...text, '', 'links:', ...links, '', 'controls:', ...controls, ''];
}

/** The page snapshot: the document title and description, then the page's own content (<main>, and anything outside the shell). */
function pageSnapshot(parts: PageParts): string {
  const title = parts.all.find((element) => element.tag === 'title');
  const description = parts.all.find((element) => element.tag === 'meta' && element.attrs.name === 'description');
  const outside = parts.outside.length ? ['outside <main> and the shell:', ...regionSections(parts.outside, parts.labels)] : [];
  return [
    `title: ${title ? squash(rawText(title)) : '(none)'}`,
    `description: ${squash(description?.attrs.content ?? '(none)')}`,
    '',
    ...regionSections(parts.main, parts.labels),
    ...outside,
  ].join('\n');
}

/** The shell snapshot: the skip link, header and footer, as the reader gets them. */
const shellSnapshot = (parts: PageParts) =>
  [`regions: ${parts.shell.map((element) => element.tag).join(', ')}`, '', ...regionSections(parts.shell, parts.labels)].join('\n');

/**
 * The only way the shell legitimately differs between pages: the router marks the links to the current page (and, for
 * the non-exact links, to its parent section) active with `aria-current="page"`, `data-status="active"` and an `active`
 * class. `shellMarkup` leaves exactly those three out and returns the marked hrefs, which the equality test checks on
 * their own; every other tag, attribute and text node of the shell must be identical on every page.
 */
function shellMarkup(parts: PageParts): { markup: string; active: string[] } {
  const active: string[] = [];
  const serialize = (node: PageElement | string): string => {
    if (typeof node === 'string') return JSON.stringify(node);
    const attrs = { ...node.attrs };
    if (node.tag === 'a') {
      const marked = [attrs['aria-current'] === 'page', attrs['data-status'] === 'active', (attrs.class ?? '').split(/\s+/).includes('active')];
      // All three or none: a link marked only partly is drift, not the router's active state, so it stays in the markup.
      if (marked.every(Boolean)) {
        active.push(attrs.href ?? '');
        delete attrs['aria-current'];
        delete attrs['data-status'];
        attrs.class = (attrs.class ?? '')
          .split(/\s+/)
          .filter((token) => token !== 'active')
          .join(' ');
      }
    }
    const attributes = Object.entries(attrs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
      .join('');
    return `<${node.tag}${attributes}>${node.children.map(serialize).join('')}</${node.tag}>`;
  };
  return { markup: parts.shell.map(serialize).join('\n'), active };
}

/** Links the router marks active on `path`: the page itself, and its parent section for a non-exact link. None on the 404. */
const expectedActive = (path: string, hrefs: string[]) =>
  path === '/404' ? [] : hrefs.filter((href) => href === path || (href !== '/' && path.startsWith(`${href}/`)));

const firstDifference = (a: string, b: string) => {
  const [left, right] = [a.split('\n'), b.split('\n')];
  const at = Array.from({ length: Math.max(left.length, right.length) }, (_, index) => index).find((index) => left[index] !== right[index]);
  return at === undefined
    ? undefined
    : `line ${at + 1}: ${JSON.stringify(left[at] ?? '(end)')}, the shell snapshot has ${JSON.stringify(right[at] ?? '(end)')}`;
};

/**
 * CI verifies the snapshots and never writes them, like the .NET defaults record (sdks/dotnet/tests/Shared/OptionDefaults.cs).
 * Vitest's CI default is update mode "none"; `--update` (mode "all") or `--update new` there must fail, and before any
 * snapshot is compared, so nothing is written. Vitest sets the snapshot state per test, not in hooks, so every test that
 * writes a snapshot calls this first, and the first test of the file reports why.
 */
function updateRefusal(): string | undefined {
  const inCi = Boolean(process.env.CI) && process.env.CI !== 'false' && process.env.CI !== '0';
  const update = expect.getState().snapshotState?.snapshotUpdateState;
  if (!inCi || update === 'none') return undefined;
  return `vitest --update must not run in CI (snapshot update mode "${update}"): the page and shell snapshots are verified there, never written. Update them locally and commit the files.`;
}
const refuseUpdateInCi = () => {
  if (updateRefusal()) throw new Error('Snapshot update refused in CI: see "snapshot updates never run in CI".');
};

it('snapshot updates never run in CI', () => {
  const refusal = updateRefusal();
  if (refusal) throw new Error(refusal);
});

describe.each(STATES)('rendered pages, $name', ({ name, env }) => {
  const rendered = new Map<string, PageParts>();
  beforeAll(async () => {
    quietHrefWarnings();
    // The page list comes from this state's own module graph, so a page that only one state publishes can't be missed.
    await renderPages([], env);
    const stateMap = await import('../lib/site-map');
    expect([...stateMap.prerenderPaths, '/404'], 'the page list differs in this state; derive PATHS per state').toEqual(PATHS);
    for (const { path, html } of await renderPages(PATHS, env)) rendered.set(path, pageParts(html));
  }, 180_000);
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const parts = (path: string) => {
    const page = rendered.get(path);
    if (!page) throw new Error(`${path} did not render`);
    return page;
  };

  // The home page's shell stands for every page; the next test holds each page to it.
  it('shell (skip link, header, footer)', async () => {
    refuseUpdateInCi();
    await expect(shellSnapshot(parts('/'))).toMatchFileSnapshot(`./__snapshots__/pages/${name}/${SHELL}`);
  });

  it('every page renders exactly the snapshotted shell', () => {
    const reference = parts('/');
    const text = shellSnapshot(reference);
    const { markup } = shellMarkup(reference);
    const drift: string[] = [];
    for (const path of PATHS) {
      const page = parts(path);
      const textDiff = firstDifference(shellSnapshot(page), text);
      if (textDiff) drift.push(`${path}: shell text differs at ${textDiff}`);
      const own = shellMarkup(page);
      if (own.markup !== markup) {
        // The markup is one long line per region: show where it starts to differ, not the whole region.
        let at = 0;
        while (own.markup[at] === markup[at]) at++;
        const around = (text: string) => JSON.stringify(text.slice(Math.max(0, at - 40), at + 80));
        drift.push(`${path}: shell markup differs (beyond the active-link marks) at ${around(own.markup)}, the home page has ${around(markup)}`);
      }
      const hrefs = page.shell
        .flatMap((region) => [region, ...elements(region)])
        .filter((element) => element.tag === 'a')
        .map((element) => element.attrs.href ?? '');
      const want = [...new Set(expectedActive(path, hrefs))].sort();
      const got = [...new Set(own.active)].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) drift.push(`${path}: active links ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
    expect(drift, 'pages whose shell differs from the shared one').toEqual([]);
  });

  it.each(PATHS)('%s', async (path) => {
    refuseUpdateInCi();
    await expect(pageSnapshot(parts(path))).toMatchFileSnapshot(`./__snapshots__/pages/${name}/${slug(path)}.txt`);
  });
});

// Vitest writes new file snapshots after the run and never reports one that no test reads, so this catches the stale
// ones (a missing one fails its own test in CI).
it('every snapshot file belongs to a rendered page and state', () => {
  const expected = new Set(STATES.flatMap(({ name }) => [SHELL, ...PATHS.map((path) => `${slug(path)}.txt`)].map((file) => `${name}/${file}`)));
  const onDisk = (existsSync(SNAPSHOTS) ? readdirSync(SNAPSHOTS, { recursive: true, encoding: 'utf8' }) : [])
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.txt'));
  expect(
    onDisk.filter((file) => !expected.has(file)),
    'snapshot files no page writes any more: delete them',
  ).toEqual([]);
});
