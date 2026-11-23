import { elements, isBlock, type PageElement, parsePage } from '../lib/page-dom';

/**
 * The text serializer behind the page snapshots (src/content/page-snapshots.test.ts). One walk over the whole <body>
 * yields the page's headings, visible text, links and form controls in document order, each line tagged with the
 * region of <body> it came from: the skip link, the site header, <main>, the site footer, or "other" (anything else
 * under <body>, its direct text included). The page file keeps every line in place and replaces each contiguous run of
 * shell lines (skip link, header, footer) with one marker line; the shell file holds the shell lines once.
 */

export type Region = 'skip link' | 'header' | 'main' | 'footer' | 'other';
const SHELL_REGIONS = new Set<Region>(['skip link', 'header', 'footer']);
export const isShellRegion = (region: Region) => SHELL_REGIONS.has(region);
export const SECTIONS = ['headings', 'text', 'links', 'controls'] as const;
export type Section = (typeof SECTIONS)[number];
export interface Tagged {
  region: Region;
  line: string;
}
export interface PageText {
  title: string;
  description: string;
  sections: Record<Section, Tagged[]>;
  /** The element children of <body> that belong to the shell, in document order. */
  shellElements: PageElement[];
}

/** Never page text: the document head, scripts, styles, templates and drawings. */
const SKIP = new Set(['head', 'script', 'style', 'template', 'svg']);
const CONTROLS = new Set(['form', 'input', 'select', 'option', 'textarea', 'button']);
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const maskUrl = (url: string) => url.replace(/\?v=[\w-]+/g, '?v=*');
const classes = (element: PageElement) => (element.attrs.class ?? '').split(/\s+/);

/** Why a reader may not see an element's text as written, or undefined when they do. */
function markOf(element: PageElement): string | undefined {
  if (element.tag === 'noscript') return 'noscript';
  if (element.attrs['aria-hidden'] === 'true') return 'aria-hidden';
  if ('hidden' in element.attrs) return 'hidden';
  if (classes(element).includes('sr-only')) return 'sr-only';
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
const layoutContainer = (element: PageElement) => classes(element).some((token) => /^(?:[\w-]+:)*(?:inline-)?(?:flex|grid)$/.test(token));

/** Elements whose position carries meaning even when empty: list items, table cells and definition parts. */
const STRUCTURAL = new Set(['li', 'td', 'th', 'dt', 'dd']);

/** Raw text of a <pre>, its lines kept. */
const rawText = (node: PageElement | string): string => (typeof node === 'string' ? node : node.children.map(rawText).join(''));

/** The region of <body> a node belongs to; <body> itself (its direct text) and anything outside it are "other". */
function regionOf(node: PageElement): Region {
  let top = node;
  while (top.parent && top.parent.tag !== 'body') top = top.parent;
  if (!top.parent) return 'other';
  if (top.tag === 'main') return 'main';
  if (top.tag === 'header') return 'header';
  if (top.tag === 'footer') return 'footer';
  if (top.tag === 'a' && classes(top).includes('skip-link')) return 'skip link';
  return 'other';
}

/**
 * The visible text below `root`, one line per run of inline text, in document order. A block element starts a new
 * line, and so does each item of a flex or grid container. Marked inline text reads `[sr-only: …]`, and a line inside a
 * marked block starts with `[sr-only]`. An image with alt text reads `[img: …]`; a <pre> keeps its own lines; an empty
 * list item, table cell or definition part reads `∅ <tag>`. Each line carries the region its text came from; a line
 * whose text comes from more than one region is "other", so it never passes as shell.
 */
function textEntries(root: PageElement, rootMarks: string[] = []): Tagged[] {
  const out: Tagged[] = [];
  let run = '';
  let runRegions = new Set<Region>();
  const add = (text: string, node: PageElement) => {
    run += text;
    if (text.trim()) runRegions.add(regionOf(node));
  };
  const flush = (marks: string[]) => {
    const text = squash(run);
    if (text) out.push({ line: `${prefix(marks)}${text}`, region: runRegions.size === 1 ? ([...runRegions][0] as Region) : 'other' });
    run = '';
    runRegions = new Set();
  };
  const walk = (node: PageElement, marks: string[]) => {
    const items = layoutContainer(node);
    for (const child of node.children) {
      if (typeof child === 'string') {
        add(child, node);
        continue;
      }
      if (SKIP.has(child.tag)) continue;
      const mark = markOf(child);
      const inner = mark ? [...marks, mark] : marks;
      if (child.tag === 'br') {
        flush(marks);
      } else if (child.tag === 'img') {
        if (child.attrs.alt) add(` [img: ${child.attrs.alt}] `, child);
      } else if (child.tag === 'pre') {
        flush(marks);
        const lines = rawText(child).split('\n');
        while (lines.length && !lines[0]?.trim()) lines.shift();
        while (lines.length && !lines.at(-1)?.trim()) lines.pop();
        for (const line of lines) out.push({ line: `${prefix(inner)}pre|${line.trimEnd() ? ` ${line.trimEnd()}` : ''}`, region: regionOf(child) });
      } else if (items || isBlock(child)) {
        flush(marks);
        const before = out.length;
        walk(child, inner);
        flush(inner);
        // A list item, table cell or definition with no text still counts: an added empty item or a cell that shifts
        // the others one column along must show in the snapshot, not disappear.
        if (out.length === before && STRUCTURAL.has(child.tag)) out.push({ line: `${prefix(inner)}∅ ${child.tag}`, region: regionOf(child) });
      } else if (mark) {
        add(` [${mark}: `, child);
        walk(child, inner);
        add('] ', child);
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
const flat = (element: PageElement) =>
  textEntries(element)
    .map((entry) => entry.line)
    .join(' | ');

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

/** Serializes a rendered page: one walk over the document, every line tagged with its region. */
export function pageText(html: string): PageText {
  const root = parsePage(html);
  const all = [...elements(root)];
  const shown = all.filter((element) => !skipped(element));
  const title = all.find((element) => element.tag === 'title');
  const description = all.find((element) => element.tag === 'meta' && element.attrs.name === 'description');
  const body = all.find((element) => element.tag === 'body') ?? root;
  const labels = new Map(
    shown.filter((element) => element.tag === 'label' && element.attrs.for).map((element) => [element.attrs.for as string, element]),
  );
  const tag = (element: PageElement, line: string): Tagged => ({ line, region: regionOf(element) });
  return {
    title: title ? squash(rawText(title)) : '(none)',
    description: squash(description?.attrs.content ?? '(none)'),
    sections: {
      headings: shown
        .filter((element) => /^h[1-6]$/.test(element.tag))
        .map((element) => tag(element, `${prefix(marksAbove(element))}${element.tag} ${flat(element)}`)),
      text: textEntries(body),
      links: shown
        .filter((element) => element.tag === 'a')
        .map((element) => {
          const label = element.attrs['aria-label'] ? ` [aria-label: ${squash(element.attrs['aria-label'])}]` : '';
          return tag(
            element,
            `${prefix(marksAbove(element))}${flat(element) || '(no text)'}${label} → ${maskUrl(element.attrs.href ?? '(no href)')}`,
          );
        }),
      controls: shown.filter((element) => CONTROLS.has(element.tag)).map((element) => tag(element, controlLine(element, labels))),
    },
    shellElements: body.children.filter((child): child is PageElement => typeof child !== 'string' && isShellRegion(regionOf(child))),
  };
}

/** The marker that stands in a page file for a contiguous run of shell lines from the given regions. */
export const shellMarker = (regions: Region[]) => `[shell: ${regions.join(', ')} — see _shell.txt]`;

/**
 * The page file: title, description, then every section with all its lines in document order, each contiguous run of
 * shell lines replaced in place by one marker naming the shell regions in it.
 */
export function pageFile(page: PageText): string {
  const sections = SECTIONS.flatMap((section) => {
    const lines: string[] = [];
    let run: Region[] | undefined;
    for (const { region, line } of page.sections[section]) {
      if (!isShellRegion(region)) {
        if (run) lines.push(shellMarker(run));
        run = undefined;
        lines.push(line);
      } else if (!run) {
        run = [region];
      } else if (run.at(-1) !== region) {
        run.push(region);
      }
    }
    if (run) lines.push(shellMarker(run));
    return [`${section}:`, ...lines, ''];
  });
  return [`title: ${page.title}`, `description: ${page.description}`, '', ...sections].join('\n');
}

/** The shell file: each section's shell lines, in document order, under a `[region: …]` line wherever the region changes. */
export function shellFile(page: PageText): string {
  const sections = SECTIONS.flatMap((section) => {
    const lines: string[] = [];
    let current: Region | undefined;
    for (const { region, line } of page.sections[section]) {
      if (!isShellRegion(region)) continue;
      if (region !== current) lines.push(`[region: ${region}]`);
      current = region;
      lines.push(line);
    }
    return [`${section}:`, ...lines, ''];
  });
  return sections.join('\n');
}
