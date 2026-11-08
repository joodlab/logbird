/**
 * Wording that depends on whether the repository is public (WEB_GITHUB_PUBLIC). scripts/check-source-state.ts scans
 * every prerendered page with these lists after a build, and the tests check the data modules in both states.
 *
 * Phrases are matched case-insensitively on the page's visible text, one text unit at a time (textSegments()): a
 * paragraph, list item, heading, cell, link, button or attribute value is its own unit, so a match can't run from one
 * into the next, while inline markup within a sentence (`We have <b>released</b> Logbird`) doesn't split it. Entities
 * are decoded and typographic apostrophes and quotes normalized first.
 *
 * Quotation marks don't exempt anything: a quoted first-party claim still counts. The only exemption is text a
 * component explicitly marks as a third-party quotation with `data-third-party-quote`: comparison pages mark what they
 * quote from another product's docs (the Retraced comparison quotes its Kubernetes page: "Coming soon").
 *
 * Labels aren't the only way a repository link leaks: repositoryReferences() finds any reference to WEB_GITHUB_URL (a link
 * with any label, src, action, JSON-LD, code or text, in any URL form), which a private build must not contain.
 */
export interface SourcePhrase {
  /** What the build report prints. */
  label: string;
  pattern: RegExp;
}

/** Marks a quotation from another product's page (Rich `thirdPartyQuotes`). Its text is left out of the check. */
export const THIRD_PARTY_QUOTE_ATTRIBUTE = 'data-third-party-quote';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** One phrase, matched case-insensitively on word boundaries. `unless` is a legitimate continuation that doesn't count. */
function phrase(text: string, unless?: string): SourcePhrase {
  const words = (value: string) => value.split(/\s+/).map(escapeRegExp).join(String.raw`\s+`);
  const tail = unless ? String.raw`(?!\s*${words(unless)})` : '';
  return { label: text, pattern: new RegExp(String.raw`(?<![\w-])${words(text)}(?![\w-])${tail}`, 'gi') };
}

/**
 * Says the source isn't public yet. Every one must sit behind a GITHUB_PUBLIC gate: a public build that renders any of
 * them fails.
 */
export const SOURCE_STATE_PHRASES: readonly SourcePhrase[] = [
  phrase('coming soon'),
  phrase('opens publicly soon'),
  phrase('source opens soon'),
  phrase('when the source opens'),
  phrase('once the source opens'),
  phrase('repository opens'),
  phrase('repository is public'),
  phrase("isn't public"),
  phrase("you'll be able to self-host"),
];

/**
 * Says the source is already open. The mirror of the list above: a private build that renders any of them fails.
 *
 * "Source on GitHub" is also the start of the private placeholder, "Source on GitHub — coming soon", so it only counts
 * when that continuation doesn't follow: the bare label is the public link (footer, /open-source button).
 */
export const SOURCE_OPEN_PHRASES: readonly SourcePhrase[] = [
  phrase('Source on GitHub', '— coming soon'),
  phrase('repository on GitHub'),
  phrase('Self-host Logbird today'),
  phrase('Self-host it'),
  phrase('today, self-host Logbird'),
  phrase('codebase you can self-host'),
  // "We released it under the MIT licence" and rewordings of it. A bare "released" can't be used: the private site
  // says "Nothing has been released yet" and "Not released".
  {
    label: 'released (the source)',
    pattern:
      /\bwe(?:'ve| have)?(?:\s+(?:now|just))?\s+released\b|\breleased\s+(?:it|logbird|the\s+(?:source|code|repository|project))\b|(?<!\bnot\s)\breleased\s+under\b|\b(?:it|logbird|the\s+(?:source|code|repository|project))\s+(?:is|was|has\s+been)(?:\s+now)?\s+released\b(?!\s+yet)/gi,
  },
];

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};
/** HTML entities decoded (React escapes `'` as `&#x27;`), so phrases match what a reader sees. */
export const decodeEntities = (html: string) =>
  html.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });

/** Entities decoded, typographic apostrophes and quotes made plain (`isn’t` → `isn't`), whitespace collapsed. */
const normalize = (text: string) =>
  decodeEntities(text)
    .replace(/[‘’‚‛ʼ′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

// An element carrying the third-party marker, with its content (comparison quotes are flat text).
const THIRD_PARTY_QUOTE = new RegExp(String.raw`<([a-z][\w-]*)\b[^>]*\s${THIRD_PARTY_QUOTE_ATTRIBUTE}\b[^>]*>[\s\S]*?<\/\1\s*>`, 'gi');
// Attributes whose values readers (or search results) see: meta descriptions, alt text, titles, labels.
const TEXT_ATTRIBUTES = /\s(?:content|alt|title|aria-label|placeholder)\s*=\s*"([^"]*)"/gi;
/**
 * Phrasing elements that stay inside a sentence. Every other tag (block elements, links, buttons, list items, cells,
 * scripts, line breaks) ends a text unit: a link label or a placeholder is its own unit.
 */
const INLINE = new Set([
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'i',
  'kbd',
  'mark',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
]);
const BREAK = '\u001F';

/** Interactive elements that may sit inside a sentence: separate units in the bounded pass, joined in the joined pass. */
const LINKS = new Set(['a', 'button']);

/**
 * The text units a reader sees in `html`: marked third-party quotations removed; each run of text between non-inline
 * tags, then each text-bearing attribute value. Script contents (JSON-LD) are units of their own. Plain text is one unit.
 *
 * `joinLinks: false` (default) ends a unit at every link or button, so a link label is its own unit. `joinLinks: true`
 * keeps an inline link inside its sentence (`<a>Self-host</a> it`). Blocks, list items, cells and attributes are
 * separate units either way.
 */
export function textSegments(html: string, { joinLinks = false }: { joinLinks?: boolean } = {}): string[] {
  const unquoted = html.replace(THIRD_PARTY_QUOTE, BREAK);
  const attributes = [...unquoted.matchAll(TEXT_ATTRIBUTES)].map((match) => normalize(match[1] ?? ''));
  const text = unquoted
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<![^>]*>/g, BREAK)
    .replace(/<\/?([a-z][\w-]*)\b[^>]*>/gi, (_tag, name: string) => {
      const tag = name.toLowerCase();
      return INLINE.has(tag) || (joinLinks && LINKS.has(tag)) ? ' ' : BREAK;
    });
  return [...text.split(BREAK).map(normalize), ...attributes].filter(Boolean);
}

/**
 * Every phrase from `phrases` that occurs in `html` (markup or plain text), with its count. The text is matched twice
 * and a phrase counts if either pass finds it (the higher count is reported):
 *
 * - links and buttons as unit boundaries: a leaked "Source on GitHub" link label is caught even when unrelated text
 *   after the link happens to read "— coming soon";
 * - inline links joined into their sentence: a claim whose key word is a link (`<a>Self-host</a> it`,
 *   `We have <a>released</a> the source`, `coming <a>soon</a>`) is caught.
 *
 * Paragraphs, list items, cells and attributes stay separate in both passes, so neither creates a match across them.
 */
export function findSourcePhrases(html: string, phrases: readonly SourcePhrase[]): { label: string; count: number }[] {
  const passes = [textSegments(html), textSegments(html, { joinLinks: true })];
  return phrases.flatMap(({ label, pattern }) => {
    const count = Math.max(
      ...passes.map((segments) =>
        segments.reduce((sum, segment) => sum + [...segment.matchAll(new RegExp(pattern.source, pattern.flags))].length, 0),
      ),
    );
    return count ? [{ label, count }] : [];
  });
}

const escapeForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * A pattern for every way a page can reference the repository: any scheme (`https:`, `http:`) or none (`//host`, a bare
 * `host/owner/repo`), with or without `www.`, any case, optionally `.git`, followed by nothing or a path, query or
 * fragment, but not a longer repository name (`…/logbird-other`).
 */
function repositoryPattern(repositoryUrl: string) {
  const url = new URL(repositoryUrl.trim());
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\.git$/i, '').replace(/\/+$/, '');
  return new RegExp(
    String.raw`(?<![\w.-])(?:(?:https?:)?\/\/)?(?:www\.)?${escapeForRegExp(host)}${escapeForRegExp(path)}(?:\.git)?(?=$|[\/?#"'\s<>)\]&,;:]|\\)`,
    'gi',
  );
}

/**
 * Every reference to the repository in `html`, whatever form or place: link `href`s with any label, `src`, `action`,
 * meta and JSON-LD values (`sameAs`), code blocks (`git clone …`) and plain text. A private build must have none
 * (scripts/check-source-state.ts). Entities are decoded first, and JSON's `\/` is read as `/`.
 */
export function repositoryReferences(html: string, repositoryUrl: string): string[] {
  const text = decodeEntities(html).replaceAll('\\/', '/');
  return [...text.matchAll(repositoryPattern(repositoryUrl))].map((match) => match[0]);
}
