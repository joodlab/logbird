import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CopyClaim, normalize } from './copy-claims';
import { elementChildren, elements, inlineRuns, type PageElement, parsePage, textOf } from './page-dom';
import { firstRelease, latestRelease, supportedLine } from './releases';

/**
 * One source per claim (copy-sync.test.ts): every claim a copy file states for a page must be on that page, as the
 * public build renders it, bound to an element: a heading to a heading, a text to one element's whole text (or a run
 * of up to three adjacent sibling elements, for a title and its body), a list to sibling elements in the same order
 * and number, a table to a table row by row and cell by cell, a call to action to a link with the same label and
 * target. The map of files to routes is marketing/copy/README.md; every copy file is either mapped or listed in
 * NOT_CHECKED with its reason.
 */
export const COPY_DIR = fileURLToPath(new URL('../../../../marketing/copy/', import.meta.url));
export const copy = (file: string) => readFileSync(join(COPY_DIR, file), 'utf8');

export const NOT_CHECKED: Record<string, string> = {
  'README.md': 'the copy guide, not a page',
  'legal-privacy.md':
    'a placeholder brief: the legal pages are their own wording source (owner-approved TSX); legal-pages.test.ts checks selected facts',
  'legal-terms.md':
    'a placeholder brief: the legal pages are their own wording source (owner-approved TSX); legal-pages.test.ts checks selected facts',
  'arabic-notes.md': 'reference strings for a future localization, not a page',
};

const releaseDate = (iso: string) => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${months[(month ?? 1) - 1]} ${year}`;
};
/** Values the copy writes as placeholders, from the release list and the test's configuration (vitest.config.ts). */
export const PLACEHOLDERS: Record<string, string> = {
  'latest release': latestRelease?.version ?? '',
  'latest release date': latestRelease ? releaseDate(latestRelease.date) : '',
  'first release': firstRelease?.version ?? '',
  'first release date': firstRelease ? releaseDate(firstRelease.date) : '',
  'supported line': supportedLine ?? '',
  'security contact': 'security@example.test',
  'sign-in URL': 'https://app.example.test/login',
  'contact email': 'hello@example.test',
};
export const PUBLIC = { WEB_GITHUB_PUBLIC: 'true', WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
export const CLOUD_OPEN = { ...PUBLIC, WEB_APP_URL: 'https://app.example.test' };

/** Every copy file, relative to marketing/copy. */
export function copyFiles(dir = COPY_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return copyFiles(path);
    return name.endsWith('.md') ? [relative(COPY_DIR, path).replaceAll('\\', '/')] : [];
  });
}

/** File → route, from the table in marketing/copy/README.md. Malformed or duplicate rows fail. */
export function routeMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of copy('README.md')
    .split('\n')
    .filter((row) => row.startsWith('| [`'))) {
    const row = /^\| \[`([^`]+)`\]\(([^)]+)\) \| [^|]+ \| (.+?) \|$/.exec(line.trim());
    if (!row) throw new Error(`Malformed map row in marketing/copy/README.md: ${line}`);
    const [, file = '', link, routes = ''] = row;
    if (link !== file) throw new Error(`Map row links ${link} for ${file}`);
    if (file in map) throw new Error(`Duplicate map row for ${file}`);
    if (file in NOT_CHECKED) continue;
    const first = /`([^`]+)`/.exec(routes)?.[1];
    if (!first) throw new Error(`Map row for ${file} names no route: ${routes}`);
    map[file] = first === '*' ? '/404' : first;
  }
  return map;
}

interface Candidate {
  anchor: PageElement;
  parent?: PageElement;
  index: number;
}
export interface Page {
  texts: Map<string, Candidate[]>;
  headings: Set<string>;
  /** h1 and h2 texts inside <main>: the page's own sections, which the copy must name. */
  sections: string[];
  links: { text: string; href: string }[];
  tables: string[][][];
}

// <noscript> stays: the form's no-JavaScript messages are page text too.
const SKIPPED = new Set(['head', 'script', 'style', 'svg', 'template']);
export function readPage(html: string): Page {
  const root = parsePage(html);
  const page: Page = { texts: new Map(), headings: new Set(), sections: [], links: [], tables: [] };
  const add = (text: string, candidate: Candidate) => {
    const key = normalize(text);
    if (key) page.texts.set(key, [...(page.texts.get(key) ?? []), candidate]);
  };
  const visibleElements = [...elements(root)].filter((element) => {
    for (let node: PageElement | undefined = element; node; node = node.parent) if (SKIPPED.has(node.tag)) return false;
    return true;
  });
  for (const element of visibleElements) {
    const parent = element.parent;
    const index = parent ? elementChildren(parent).indexOf(element) : 0;
    add(textOf(element), { anchor: element, parent, index });
    for (const name of ['placeholder', 'aria-label']) {
      if (element.attrs[name]) add(element.attrs[name] as string, { anchor: element, parent, index });
    }
    for (const run of inlineRuns(element)) add(run, { anchor: element, parent, index });
    const kids = elementChildren(element);
    for (let size = 2; size <= 3; size += 1) {
      for (let at = 0; at + size <= kids.length; at += 1) {
        add(
          kids
            .slice(at, at + size)
            .map(textOf)
            .join(' '),
          { anchor: element, parent, index },
        );
      }
    }
    if (/^h[1-6]$/.test(element.tag)) page.headings.add(normalize(textOf(element)));
    if (/^h[12]$/.test(element.tag)) {
      let inMain = false;
      for (let node: PageElement | undefined = element.parent; node; node = node.parent) if (node.tag === 'main') inMain = true;
      // The closing band (CtaBand, id cta-title) is shared by every page; its words are checked on home (home.md#final-cta).
      const text = normalize(textOf(element));
      if (inMain && text && element.attrs.id !== 'cta-title') page.sections.push(text);
    }
    if (element.tag === 'a') page.links.push({ text: normalize(textOf(element)), href: element.attrs.href ?? '' });
    if (element.tag === 'table') {
      page.tables.push(
        [...elements(element)].filter((row) => row.tag === 'tr').map((row) => elementChildren(row).map((cell) => normalize(textOf(cell)))),
      );
    }
  }
  return page;
}

const path = (href: string) => href.replace(/^https?:\/\/[^/]+/, '').replace(/(.)\/(?=$|[?#])/, '$1');

/** The page text that shares the longest start with `text`, as a hint for whoever fixes the difference. */
function closest(text: string, page: Page): string {
  let best = '';
  let length = 0;
  for (const key of page.texts.keys()) {
    let shared = 0;
    while (shared < key.length && key[shared] === text[shared]) shared += 1;
    if (shared > length || (shared === length && key.length < best.length)) {
      best = key;
      length = shared;
    }
  }
  return length >= 12 ? ` (closest on the page: "${best.slice(0, 240)}")` : '';
}

/** What's wrong with `claims` on `page`, one line per problem (empty when everything matches). */
export function problems(claims: CopyClaim[], page: Page): string[] {
  const found: string[] = [];
  const at = (claim: CopyClaim) => `${claim.where} (${claim.field})`;
  const groups = new Map<string, CopyClaim[]>();
  const tables = new Map<string, CopyClaim[]>();
  for (const claim of claims) {
    if (claim.kind === 'heading' && !page.headings.has(claim.text)) found.push(`${at(claim)}: no heading reads "${claim.text}"`);
    if (claim.kind === 'text' && !page.texts.has(claim.text))
      found.push(`${at(claim)}: no element reads "${claim.text}"${closest(claim.text, page)}`);
    if (claim.kind === 'link' && !page.links.some((link) => link.text === claim.text && path(link.href) === path(claim.target ?? ''))) {
      found.push(`${at(claim)}: no link "${claim.text}" → ${claim.target}`);
    }
    if (claim.kind === 'item') {
      const key = (claim.group ?? '').replace(/\/\d+$/, '');
      groups.set(key, [...(groups.get(key) ?? []), claim]);
    }
    if (claim.kind === 'row') tables.set(claim.group ?? '', [...(tables.get(claim.group ?? '') ?? []), claim]);
  }
  for (const items of groups.values()) {
    const options = items.map((item) => page.texts.get(item.text) ?? []);
    const missing = items.filter((_item, index) => (options[index] ?? []).length === 0);
    for (const item of missing) found.push(`${at(item)}: no element reads "${item.text}"${closest(item.text, page)}`);
    if (missing.length) continue;
    // One list: every item a child of the same parent, in order, and that parent has exactly as many such children.
    // An item's element can sit up to two levels below the list's own item (a numbered step wraps its text).
    const members = options.map((candidates) =>
      candidates.flatMap((candidate) => {
        const chain: Candidate[] = [];
        for (let node: PageElement | undefined = candidate.anchor, depth = 0; node?.parent && depth < 3; node = node.parent, depth += 1) {
          chain.push({ anchor: node, parent: node.parent, index: elementChildren(node.parent).indexOf(node) });
        }
        return chain;
      }),
    );
    // The nearest parent (fewest levels above the first item) that holds every item, in order.
    const fitsIn = (parent: PageElement | undefined) => {
      let previous = -1;
      for (const candidates of members) {
        const next = candidates.filter((candidate) => candidate.parent === parent && candidate.index > previous).map((c) => c.index);
        if (!next.length) return false;
        previous = Math.min(...next);
      }
      return true;
    };
    const nearest = (members[0] ?? []).find((candidate) => fitsIn(candidate.parent));
    if (!nearest?.parent) {
      found.push(`${at(items[0] as CopyClaim)}: the ${items.length} items aren't one list in this order on the page`);
      continue;
    }
    const counts = [elementChildren(nearest.parent).filter((child) => child.tag === nearest.anchor.tag).length];
    if (!counts.includes(items.length)) {
      found.push(`${at(items[0] as CopyClaim)}: the copy lists ${items.length} items, the page ${counts.join(' or ')}`);
    }
  }
  for (const rows of tables.values()) {
    const [header] = rows;
    const table = page.tables.find((candidate) => candidate.some((row) => row.join(' | ') === header?.text));
    if (!table) {
      found.push(`${at(header as CopyClaim)}: no table has the header "${header?.text}"`);
      continue;
    }
    const start = table.findIndex((row) => row.join(' | ') === header?.text);
    const pageRows = table.slice(start);
    rows.forEach((row, index) => {
      const actual = pageRows[index]?.join(' | ');
      if (actual !== row.text) found.push(`${at(row)}: row ${index + 1} reads "${actual ?? '(none)'}", the copy "${row.text}"`);
    });
    if (pageRows.length !== rows.length) found.push(`${at(header as CopyClaim)}: the copy has ${rows.length} rows, the page ${pageRows.length}`);
  }
  return found;
}
