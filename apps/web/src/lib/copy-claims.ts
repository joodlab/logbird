/**
 * The marketing copy files (marketing/copy/*.md) are the source for each page's words. copy-sync.test.ts checks that
 * every claim they state for a page (headings, bodies, bullets, steps, limit lines) appears on that page as rendered,
 * so a correction made on one side and not the other fails a test instead of shipping.
 *
 * Parsing follows the layout in marketing/copy/README.md: one `##` block per section, with fields written as
 * `- **name:** text`, continued on indented lines, and lists as indented `-` or `1.` items under `- **bullets:**` or
 * `- **steps:**`. HTML comments (sources, notes) are dropped. Inline marks (`code`, **bold**, *emphasis*) and Markdown
 * links compare by their visible text. A field or list item whose first line carries `<!-- copy-sync: skip (reason) -->`
 * isn't checked: internal notes, and variants the checked build doesn't render.
 */
export interface CopyClaim {
  /** The copy file and section the claim comes from, e.g. `developers.md#delivery`. */
  where: string;
  field: string;
  text: string;
}

const FIELDS = new Set(['heading', 'heading (H1)', 'body', 'limit line']);
const LISTS = new Set(['bullets', 'steps']);
const SKIP = /<!--\s*copy-sync:\s*skip/;

/** Visible text: comments, inline marks and link targets removed, quotes and whitespace normalized. */
export function visible(text: string): string {
  return (
    text
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Source citations such as [S1–S4] or [W2, W7]: the page renders them as separate links.
      .replace(/\s*\[[A-Z]\d+(?:\s*(?:[–,-]\s*[A-Z]?\d+))*\]/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1$2')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The form two texts are compared in: case, punctuation and spacing ignored, so a title rendered in its own element
 * ("Retried" + "Rate limits…") matches the copy's "**Retried.** Rate limits…", and markup boundaries don't matter.
 * Words, numbers and their order still have to match.
 */
export const loose = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** loose() leaves only letters, digits and spaces, so a part can go into a pattern as it is. */
const WORDS = String.raw`\s?(?:[\p{L}\p{N}]+\s?){1,6}`;

/**
 * Whether `claim` appears in `page` (a loose() text). A `<placeholder>` in the claim (`<latest release>`) stands for
 * one to six words; any other angle bracket is ordinary punctuation.
 */
export function appearsIn(claim: string, page: string): boolean {
  const parts = claim.split(/<[a-z][^<>]*>/i).map(loose);
  if (parts.length === 1) {
    return page.includes(parts[0] as string);
  }
  const pattern = parts.join(WORDS);
  return new RegExp(pattern, 'u').test(page);
}

/** The claims of one copy file, in order. */
export function copyClaims(markdown: string, file: string): CopyClaim[] {
  const claims: CopyClaim[] = [];
  const raw = markdown.split(/\r?\n/);
  // Comments blanked in place, so line numbers still match `raw` (where the skip markers are).
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' ')).split(/\r?\n/);
  let section = '';
  let current: { field: string; parts: string[]; skip: boolean } | undefined;
  let list: { field: string; indent: number } | undefined;
  const flush = () => {
    if (current && !current.skip) {
      const text = visible(current.parts.join(' '));
      if (text) {
        claims.push({ where: `${file}#${section}`, field: current.field, text });
      }
    }
    current = undefined;
  };
  for (const [index, line] of lines.entries()) {
    const skip = SKIP.test(raw[index] ?? '');
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading?.[1]) {
      flush();
      list = undefined;
      section = heading[1].trim();
      continue;
    }
    const field = /^(\s*)- \*\*([^*]+):\*\*\s?(.*)$/.exec(line);
    // Inside a list, an indented item is an item even when it starts with a bold label (`- **Starting size:** …`).
    const inList = list !== undefined && (field?.[1] ?? '').length > list.indent;
    if (field && !inList) {
      flush();
      const [, indent = '', name = '', rest = ''] = field;
      list = LISTS.has(name) ? { field: name, indent: indent.length } : undefined;
      current = FIELDS.has(name) ? { field: name, parts: [rest], skip } : undefined;
      continue;
    }
    const item = /^(\s+)(?:-|\d+\.)\s+(.*)$/.exec(line);
    if (list && item && (item[1] ?? '').length > list.indent) {
      flush();
      current = { field: list.field, parts: [item[2] ?? ''], skip };
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      current.parts.push(line);
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    flush();
    list = undefined;
  }
  flush();
  return claims;
}
