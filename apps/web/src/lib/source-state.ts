/**
 * Wording that depends on whether the repository is public (WEB_GITHUB_PUBLIC). scripts/check-source-state.ts scans
 * every prerendered page with these lists after a build, and the tests check the data modules in both states.
 *
 * Matching is case-insensitive, ignores markup and line breaks between words (`Source on <b>GitHub</b>`), and decodes
 * HTML entities first, so a reworded, lowercase or qualified variant can't slip past an exact-phrase check. A phrase
 * directly inside quotation marks is a citation, not our claim (the Retraced comparison quotes its Kubernetes docs page:
 * "Coming soon"), so it doesn't count.
 */
export interface SourcePhrase {
  /** What the build report prints. */
  label: string;
  pattern: RegExp;
}

// Whitespace, a tag, or both, between two words of a phrase.
const GAP = String.raw`(?:\s|<[^>]*>)+`;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OPEN_QUOTE = `["“‘]`;
const CLOSE_QUOTE = `["”’]`;
/**
 * One phrase, matched case-insensitively on word boundaries and not as a quotation. `unless` is a legitimate
 * continuation that doesn't count.
 */
function phrase(text: string, unless?: string): SourcePhrase {
  const words = (value: string) => value.split(/\s+/).map(escapeRegExp).join(GAP);
  const body = String.raw`${words(text)}(?![\w-])`;
  const tail = unless ? `(?!${GAP.replace('+', '*')}${words(unless)})` : '';
  // Counts unless it is both opened and closed by a quotation mark: not preceded by one, or not followed by one.
  return { label: text, pattern: new RegExp(String.raw`(?<![\w-])(?:(?<!${OPEN_QUOTE})${body}|${body}(?!${CLOSE_QUOTE}))${tail}`, 'gi') };
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
      /\bwe(?:'ve| have)?(?:\s+(?:now|just))?\s+released\b|\breleased\s+(?:it|logbird|the\s+(?:source|code|repository|project))\b|\b(?:it|logbird|the\s+(?:source|code|repository|project))\s+(?:is|was|has\s+been)(?:\s+now)?\s+released\b(?!\s+yet)/gi,
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

/** Every phrase from `phrases` that occurs in `html` (markup or plain text), with its count. */
export function findSourcePhrases(html: string, phrases: readonly SourcePhrase[]): { label: string; count: number }[] {
  const text = decodeEntities(html);
  return phrases.flatMap(({ label, pattern }) => {
    const count = [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
    return count ? [{ label, count }] : [];
  });
}
