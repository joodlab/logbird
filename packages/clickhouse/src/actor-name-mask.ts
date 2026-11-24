/**
 * The `actor_email` mask also hides an actor name that is the address (#333): a producer that used the address as the
 * display name too. One rule everywhere, in TypeScript for events (`maskEvent`) and in SQL for facets and filters:
 * lower-cased, with every whitespace character removed, the name equals the email. Removing all whitespace masks a
 * little more than plain equality would; it never shows more.
 */

import { createHmac } from 'node:crypto';

/** A stable per-project pseudonym, so scoped readers can still group by person. */
export function maskedEmail(projectId: string, email: string, secret: Buffer) {
  return email ? `masked:${createHmac('sha256', secret).update(`${projectId}\0${email.toLowerCase()}`).digest('hex').slice(0, 24)}` : '';
}

/** Whitespace removed before comparing: JavaScript's `\s`, plus U+0085 and U+200B, on both sides of the rule. */
const SPACES_JS = '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200B\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';
const SPACES = new RegExp(`[${SPACES_JS}]`, 'gu');
/** The same class in RE2 syntax, bound as a query parameter (never spliced into SQL text). */
const SPACES_RE2 = '[\\t\\n\\x{0B}\\f\\r \\x{85}\\x{A0}\\x{1680}\\x{2000}-\\x{200B}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]';

const normalized = (value: string) => value.replace(SPACES, '').toLowerCase();
/** Whether a name is the actor's address under the mask rule. An empty email never matches. */
export function actorNameIsEmail(name: string, email: string) {
  return Boolean(email) && normalized(name) === normalized(email);
}

/**
 * Marker the facet SQL returns in place of a name that is the address: `facets()` replaces it with the address's
 * pseudonym (`maskedEmail`) before returning, so the address itself never leaves the package. The NUL byte keeps it
 * apart from any name a producer can send in practice; a producer that sends one anyway only gets a pseudonym label.
 */
export const ACTOR_NAME_MARKER = '\u0000logbird-masked-email:';

/** Query parameters every masked expression below needs; merge them into the query's params. */
export const ACTOR_NAME_MASK_PARAMS = { actorMaskSpaces: SPACES_RE2, actorMaskMarker: ACTOR_NAME_MARKER } as const;

const sqlNormalized = (column: string) => `lowerUTF8(replaceRegexpAll(${column},{actorMaskSpaces:String},''))`;
/** SQL form of `actorNameIsEmail` over the stored columns. */
export const ACTOR_NAME_IS_EMAIL_SQL = `(actor_email!='' AND ${sqlNormalized('actor_name')}=${sqlNormalized('actor_email')})`;
/**
 * The actor name as a facet value or label under the mask: a name that is the address becomes the marker followed by
 * the lower-cased address (so case variants of one address group together, as `maskedEmail` lower-cases too).
 */
export const MASKED_ACTOR_NAME_SQL = `if(${ACTOR_NAME_IS_EMAIL_SQL},concat({actorMaskMarker:String},lowerUTF8(actor_email)),actor_name)`;
/** Free text without the actor name (migration 003's `search_text`, minus `actor_name`). */
const SEARCH_TEXT_WITHOUT_NAME = "lowerUTF8(concat(description,' ',tenant_name,' ',arrayStringConcat(target_names,' ')))";
const FREE_TEXT = /\((hasToken|position)\(search_text, (lowerUTF8\(\{q\d+:String\}\))\)( > 0)?\)/g;

/**
 * Rewrites a compiled query-language filter so it cannot probe a masked address (#333):
 * - every `actor_name` reference reads an empty string where the name is the address, so `actor.name:"a@b"` (or a
 *   prefix or wildcard) never matches those rows;
 * - a free-text term matches such a row only through its other text (description, tenant, targets), never its name.
 * Fails closed: a `search_text` use this rewrite does not recognise throws instead of passing through unmasked.
 */
export function maskActorNameInFilter(sql: string): string {
  // actor_name first: the free-text wrapper below adds references that must stay as they are (replace never rescans).
  const named = sql.replace(/\bactor_name\b/g, `if(${ACTOR_NAME_IS_EMAIL_SQL},'',actor_name)`);
  const uses = (named.match(/\bsearch_text\b/g) ?? []).length;
  let wrapped = 0;
  const out = named.replace(FREE_TEXT, (match: string, fn: string, arg: string, gt: string | undefined) => {
    wrapped++;
    return `(${match} AND (NOT ${ACTOR_NAME_IS_EMAIL_SQL} OR ${fn}(${SEARCH_TEXT_WITHOUT_NAME}, ${arg})${gt ?? ''}))`;
  });
  if (wrapped !== uses) throw new Error('Free-text filter cannot be masked for this scope.');
  return out;
}
