/**
 * Parser for the interim copy drift check (copy-sync.test.ts). INTERIM, to be deleted when the typed content modules land (#250): it catches common drift between the copy files and the pages, and does not make each claim single-source.
 *
 * The marketing copy files (marketing/copy/*.md) describe the words of each page; the check compares the claims parsed
 * here with the pages as rendered, so many corrections made on one side only fail a test instead of shipping.
 *
 * Parsing follows marketing/copy/README.md: one `##` block per section, fields written as `- **name:** text`, continued
 * on indented lines, lists as indented `-` or `1.` items, tables as Markdown rows. Every field name is classified
 * below; an unknown name fails, so a misspelt field can't drop out of the check. HTML comments (sources, notes,
 * private-build variants) are dropped. A field or item whose first line carries `<!-- copy-sync: skip (reason) -->`
 * isn't checked; the reason is required.
 */

export type ClaimKind = 'text' | 'heading' | 'item' | 'row' | 'link';
export interface CopyClaim {
  /** `file#section`, e.g. `developers.md#delivery`. */
  where: string;
  field: string;
  kind: ClaimKind;
  /** Comparison form (normalize()); for a row, its cells joined by ` | `. */
  text: string;
  cells?: string[];
  /** For a link: the href path it must point to. */
  target?: string;
  /** List items of one field share a group, in order. */
  group?: string;
  /** `cloud-open`: checked against the page rendered with Logbird Cloud open (WEB_APP_URL set). */
  variant: 'default' | 'cloud-open';
}

type FieldKind = 'text' | 'heading' | 'list' | 'table' | 'cta' | 'dots' | 'quoted' | 'not-text' | 'state';

/** How each field (by name, before any parenthesis) is checked. */
const FIELD_KINDS: Record<string, FieldKind> = {
  heading: 'heading',
  eyebrow: 'text',
  body: 'text',
  'limit line': 'text',
  'small print': 'text',
  'small print under the CTAs': 'text',
  'empty state': 'text',
  unverified: 'text',
  'status note': 'text',
  'category note': 'text',
  'side note': 'text',
  'privacy note': 'text',
  'submit button': 'text',
  'placeholder for email': 'text',
  bullets: 'list',
  steps: 'list',
  'steps after the code': 'list',
  list: 'list',
  items: 'list',
  rules: 'list',
  cards: 'list',
  annotations: 'list',
  'topic options': 'list',
  'volume options': 'list',
  'needs options': 'list',
  fields: 'list',
  'facts panel': 'dots',
  checklist: 'dots',
  'card status labels': 'quoted',
  table: 'table',
  cta: 'cta',
  // Not page text, or checked elsewhere:
  id: 'not-text', // the section anchor
  visual: 'not-text', // a capture, clip or diagram
  'code sample': 'not-text', // code copied from the source; the build type-checks it
  tabs: 'not-text', // code samples
  install: 'not-text', // a code sample
  'worked example': 'not-text', // a code sample
  site: 'not-text', // a publication note for the engineer
  contact: 'not-text', // an instruction: where the address comes from
  'front matter for the post page': 'not-text',
  'shared page furniture': 'not-text', // comparison-page chrome, rendered from comparisons.ts and checked there
  data: 'not-text', // the page renders this part from a data module, which is its only source
  'while the repository is private': 'not-text', // the private-build variant
  messages: 'not-text', // the heading of the form's state messages below
  // The form's messages: in the page from the start, shown when they apply.
  Success: 'text',
  Error: 'text',
  Unavailable: 'text',
  'Too many attempts': 'text',
  // Rendered only while a submission is in flight, so a static render can't show it:
  Sending: 'state',
};
/** Field names whose parenthesis changes how they're checked. */
const SPECIAL: Record<string, FieldKind> = {
  'empty state (only when the release list is empty)': 'state',
};

const SKIP = /<!--\s*copy-sync:\s*skip\s*\(([^)]*)\)\s*-->/;
const ANY_MARKER = /<!--[^>]*copy-sync/;

/** Comparison form: Unicode NFC, typographic quotes and spacing unified, sentence-boundary `.:;` dropped. Case,
 *  digits, signs, operators and units are kept. */
export function normalize(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,:;!?)\]%])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .replace(/[.:;](?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `[S1–S4]` → `[S1, S2, S3, S4]`: a citation range written out the way the page renders it, one link per source. */
function expandCitations(text: string): string {
  return text.replace(/\s*\[([A-Z]\d+(?:\s*[–,-]\s*[A-Z]?\d+)*)\]/g, (_match, list: string) => {
    const ids: string[] = [];
    for (const part of list.split(',')) {
      const range = /^\s*([A-Z])(\d+)\s*[–-]\s*[A-Z]?(\d+)\s*$/.exec(part);
      if (range) {
        const [, prefix, from, to] = range;
        for (let n = Number(from); n <= Number(to); n += 1) ids.push(`${prefix}${n}`);
      } else {
        ids.push(part.trim());
      }
    }
    return ` [${ids.join(', ')}]`;
  });
}

/** Visible text of a copy fragment: inline marks and link targets removed, citations expanded, code kept verbatim. */
export function visible(text: string, placeholders: Record<string, string> = {}): string {
  const code: string[] = [];
  const kept = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/`([^`]+)`/g, (_match, inner: string) => `\uE000${code.push(inner) - 1}\uE000`)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const plain = expandCitations(kept)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s("])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/\uE000(\d+)\uE000/g, (_match, index: string) => code[Number(index)] ?? '');
  // Named placeholders (`<latest release>`) take their value; any other angle bracket is literal text.
  return plain.replace(/<([a-z][A-Za-z .-]*)>/g, (match, name: string) => placeholders[name] ?? match);
}

function fieldKind(name: string): FieldKind | undefined {
  if (name in SPECIAL) return SPECIAL[name];
  const base = name.replace(/\s*\(.*$/, '').trim();
  return FIELD_KINDS[base];
}

/** Every claim of one copy file, in order. Throws on an unknown field name or a malformed skip marker. */
export function copyClaims(markdown: string, file: string, placeholders: Record<string, string> = {}): CopyClaim[] {
  const claims: CopyClaim[] = [];
  const raw = markdown.split(/\r?\n/);
  // Comments blanked in place (multi-line ones too), so line numbers still match `raw`.
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' ')).split(/\r?\n/);
  let section = '';
  let field: { name: string; kind: FieldKind; variant: CopyClaim['variant']; indent: number; skipAll: boolean } | undefined;
  let item: { parts: string[]; skip: boolean; indent: number } | undefined;
  let items = 0;
  const where = () => `${file}#${section}`;
  const add = (claim: Omit<CopyClaim, 'where' | 'variant'>) => {
    if (!field?.skipAll) claims.push({ where: where(), variant: field?.variant ?? 'default', ...claim });
  };
  const addLinks = (text: string) => {
    for (const part of text.split(/\s+·\s+/)) {
      const link = /^\s*(?:CTA:\s*)?(.*?)\s*[→↓]\s*`([^`]+)`/.exec(part);
      const label = link?.[1] ? normalize(visible(link[1], placeholders)) : '';
      const target = (link?.[2] ?? '').replace(/<([a-z][A-Za-z .-]*)>/g, (match, name: string) => placeholders[name] ?? match);
      if (link && label) add({ field: field?.name ?? '', kind: 'link', text: label, target });
    }
  };
  const flushItem = () => {
    if (!field || !item) return;
    const { parts, skip } = item;
    item = undefined;
    if (skip) return;
    const prose: string[] = [];
    for (const part of parts) {
      if (/^\s*(?:CTA:[^→↓]*[→↓]|[→↓])\s*`[^`]+`/.test(part)) addLinks(part);
      else prose.push(part);
    }
    const text = normalize(visible(prose.join(' '), placeholders));
    if (text) add({ field: field.name, kind: 'item', text, group: `${where()}/${field.name}/${items}` });
  };
  const flushText = (parts: string[]) => {
    if (!field) return;
    const body = parts.join(' ');
    if (field.kind === 'cta') return addLinks(body);
    if (field.kind === 'dots') {
      for (const part of body.split(/\s+·\s+/)) {
        const text = normalize(visible(part.replace(/\s+—\s+/, ' '), placeholders));
        if (text) add({ field: field.name, kind: 'item', text, group: `${where()}/${field.name}/${items}` });
      }
      return;
    }
    if (field.kind === 'quoted') {
      for (const [, quoted = ''] of body.matchAll(/"([^"]+)"/g)) add({ field: field.name, kind: 'text', text: normalize(quoted) });
      return;
    }
    const text = normalize(visible(body, placeholders));
    if (text) add({ field: field.name, kind: field.kind === 'heading' ? 'heading' : 'text', text });
  };
  let textParts: string[] | undefined;
  let textSkip = false;
  const endField = () => {
    flushItem();
    if (textParts && !textSkip) flushText(textParts);
    textParts = undefined;
    field = undefined;
  };
  let fence = false;
  for (const [index, line] of lines.entries()) {
    const rawLine = raw[index] ?? '';
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue; // code inside a field is a sample, not a claim
    if (ANY_MARKER.test(rawLine) && !SKIP.test(rawLine)) {
      throw new Error(`${file}:${index + 1}: write the marker as <!-- copy-sync: skip (reason) -->`);
    }
    const skipReason = SKIP.exec(rawLine)?.[1]?.trim();
    if (skipReason === '') throw new Error(`${file}:${index + 1}: a copy-sync skip needs a reason`);
    const skip = skipReason !== undefined;
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading?.[1]) {
      endField();
      section = heading[1].trim();
      continue;
    }
    const fieldLine = /^(\s*)- \*\*([^*]+):\*\*\s?(.*)$/.exec(line);
    const listItem = /^(\s+)(?:-|\d+\.)\s+(.*)$/.exec(line);
    const inList = field?.kind === 'list' && listItem !== null && (listItem[1] ?? '').length > field.indent;
    if (fieldLine && !inList) {
      endField();
      const [, indent = '', name = '', rest = ''] = fieldLine;
      if (!section) continue; // front matter notes above the first section
      const kind = fieldKind(name);
      if (!kind) throw new Error(`${file}:${index + 1}: unknown copy field "${name}" (classify it in copy-claims.ts)`);
      if (kind === 'not-text' || kind === 'state') continue;
      field = { name, kind, variant: /\(when Cloud is open\)/.test(name) ? 'cloud-open' : 'default', indent: indent.length, skipAll: skip };
      items = 0;
      if (kind === 'list' || kind === 'table') continue;
      textParts = [rest];
      textSkip = skip;
      continue;
    }
    if (!field) continue;
    if (field.kind === 'list' && listItem && (listItem[1] ?? '').length > field.indent) {
      const indent = (listItem[1] ?? '').length;
      if (!item || indent <= item.indent) {
        flushItem();
        items += 1;
        item = { parts: [listItem[2] ?? ''], skip, indent };
        continue;
      }
    }
    if (field.kind === 'table' && /^\s*\|/.test(line)) {
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => normalize(visible(cell, placeholders)));
      if (!cells.every((cell) => /^:?-+:?$/.test(cell)))
        add({ field: field.name, kind: 'row', text: cells.join(' | '), cells, group: `${where()}/${field.name}` });
      continue;
    }
    if (/^\s+\S/.test(line)) {
      if (item) item.parts.push(line);
      else if (textParts) textParts.push(line);
      continue;
    }
    if (line.trim() && !/^\s*```/.test(line)) endField();
  }
  endField();
  return claims;
}
