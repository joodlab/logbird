/**
 * Wording that depends on whether the repository is public (WEB_GITHUB_PUBLIC). scripts/check-source-state.ts scans
 * every prerendered page with these lists after a build, and the tests check the data modules in both states.
 *
 * Phrases are matched case-insensitively on the page's visible text (visibleText(): tags dropped, entities decoded,
 * whitespace collapsed, plus the text-bearing attributes such as meta descriptions and alt text), so a claim split by
 * markup (`We have <b>released</b> Logbird`), a lowercase or qualified variant can't slip past an exact-phrase check.
 *
 * Quotation marks don't exempt anything: a quoted first-party claim still counts. The only exemption is text a
 * component explicitly marks as a third-party quotation with `data-third-party-quote`: comparison pages mark what they
 * quote from another product's docs (the Retraced comparison quotes its Kubernetes page: "Coming soon").
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–' };
/** HTML entities decoded (React escapes `'` as `&#x27;`), so phrases match what a reader sees. */
export const decodeEntities = (html: string) =>
  html.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });

// An element carrying the third-party marker, with its content (comparison quotes are flat text).
const THIRD_PARTY_QUOTE = new RegExp(String.raw`<([a-z][\w-]*)\b[^>]*\s${THIRD_PARTY_QUOTE_ATTRIBUTE}\b[^>]*>[\s\S]*?<\/\1\s*>`, 'gi');
// Attributes whose values readers (or search results) see: meta descriptions, alt text, titles, labels.
const TEXT_ATTRIBUTES = /\s(?:content|alt|title|aria-label|placeholder)\s*=\s*"([^"]*)"/gi;
const collapse = (text: string) => decodeEntities(text).replace(/\s+/g, ' ').trim();

/**
 * What a reader sees of `html`: marked third-party quotations removed, tags (and comments) replaced by spaces,
 * entities decoded and whitespace collapsed; then the text-bearing attribute values, one per line, so a phrase can't
 * run from one into another. Script contents (JSON-LD) stay, as text. Plain text passes through unchanged.
 */
export function visibleText(html: string) {
  const unquoted = html.replace(THIRD_PARTY_QUOTE, ' ');
  const attributes = [...unquoted.matchAll(TEXT_ATTRIBUTES)].map((match) => collapse(match[1] ?? ''));
  const text = collapse(unquoted.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' '));
  return [text, ...attributes].filter(Boolean).join('\n');
}

/** Every phrase from `phrases` that occurs in the visible text of `html` (markup or plain text), with its count. */
export function findSourcePhrases(html: string, phrases: readonly SourcePhrase[]): { label: string; count: number }[] {
  // One segment per line (the text, then each attribute value), so no match spans two of them.
  const segments = visibleText(html).split('\n');
  return phrases.flatMap(({ label, pattern }) => {
    const count = segments.reduce((sum, segment) => sum + [...segment.matchAll(new RegExp(pattern.source, pattern.flags))].length, 0);
    return count ? [{ label, count }] : [];
  });
}
