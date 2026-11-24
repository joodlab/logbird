/**
 * The `actor_email` mask also hides an actor name that carries an address (#333): a producer that used the address as
 * the display name, put it inside the name ("Ada <ada@example.org>"), or sent an address only as the name. One rule
 * everywhere, in TypeScript for events (`maskEvent`) and in SQL for facets and filters. Normalised (lower-cased, every
 * whitespace character removed), the name is sensitive when it:
 * - contains `@`; or
 * - equals the email; or
 * - was cut at its 512-unit storage cap (511 or more UTF-16 units stored) and is a non-empty prefix of the email.
 * A sensitive name shows as a pseudonym: of the stored email when the name contains it (or is that capped prefix), so
 * it matches the email's own pseudonym; otherwise of the normalised name. It masks more than strictly needed; never less.
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
/** Characters outside the BMP: each is two UTF-16 units, so SQL counts UTF-16 units as code points plus these. */
const ASTRAL_RE2 = '[\\x{10000}-\\x{10FFFF}]';
/** normalize.ts stores an actor name in at most 512 UTF-16 units (511 when a surrogate pair straddles the cap). */
const NAME_CAP_REACHED = 511;

const normalized = (value: string) => value.replace(SPACES, '').toLowerCase();
const cappedPrefix = (name: string, n: string, e: string) => name.length >= NAME_CAP_REACHED && n !== '' && e.startsWith(n);
/** Whether an actor name carries an address under the mask rule. */
export function actorNameIsSensitive(name: string, email: string) {
  const n = normalized(name);
  const e = normalized(email);
  return n.includes('@') || (e !== '' && (n === e || cappedPrefix(name, n, e)));
}
/** What a sensitive name's pseudonym hashes: the stored email when the name contains it, else the normalised name. */
export function actorNamePseudonymInput(name: string, email: string) {
  const n = normalized(name);
  const e = normalized(email);
  return e !== '' && (n.includes(e) || cappedPrefix(name, n, e)) ? email : n;
}

/** Query parameters every masked expression below needs; merge them into the query's params. */
export const ACTOR_NAME_MASK_PARAMS = { actorMaskSpaces: SPACES_RE2, actorMaskAstral: ASTRAL_RE2 } as const;

const sqlNormalized = (column: string) => `lowerUTF8(replaceRegexpAll(${column},{actorMaskSpaces:String},''))`;
const sqlUtf16Length = (column: string) => `(lengthUTF8(${column})+countMatches(${column},{actorMaskAstral:String}))`;
const N = sqlNormalized('actor_name');
const E = sqlNormalized('actor_email');
const SQL_CAPPED_PREFIX = `(${sqlUtf16Length('actor_name')}>=${NAME_CAP_REACHED} AND ${N}!='' AND startsWith(${E},${N}))`;
/** SQL form of `actorNameIsSensitive` over the stored columns (UInt8). */
export const ACTOR_NAME_IS_SENSITIVE_SQL = `(position(${N},'@')>0 OR (${E}!='' AND (${N}=${E} OR ${SQL_CAPPED_PREFIX})))`;
/** SQL form of `actorNamePseudonymInput`, lower-cased as `maskedEmail` lower-cases its input. */
const PSEUDONYM_INPUT_SQL = `if(${E}!='' AND (position(${N},${E})>0 OR ${SQL_CAPPED_PREFIX}),lowerUTF8(actor_email),${N})`;
/**
 * The actor name's facet text under the mask: a sensitive name becomes its pseudonym's input, and the separate flag
 * column (`ACTOR_NAME_IS_SENSITIVE_SQL`) says so. facets() turns flagged text into the address's pseudonym
 * before returning; text is never interpreted by its content, so no producer string can pass for a masked address.
 */
export const MASKED_ACTOR_NAME_TEXT_SQL = `if(${ACTOR_NAME_IS_SENSITIVE_SQL},${PSEUDONYM_INPUT_SQL},actor_name)`;

/**
 * Keys for ordering tied facet groups under the mask: a keyed hash of each group, so which of several equal counts is
 * kept by a limit cannot be related to any address. Derived from the field mask key, per project.
 */
export function facetOrderParams(secret: Buffer, projectId: string) {
  const digest = createHmac('sha256', secret).update(`logbird-facet-order\0${projectId}`).digest();
  return { orderKey0: digest.readBigUInt64BE(0).toString(), orderKey1: digest.readBigUInt64BE(8).toString() };
}
/** The tie-break for a group key `flag|text`, under facetOrderParams. */
export const facetOrderSql = (flag: string, text: string) =>
  `sipHash64Keyed(({orderKey0:UInt64},{orderKey1:UInt64}),concat(toString(${flag}),'|',${text}))`;

/** The text an empty name would leave in migration 003's `search_text` (the same expression, name replaced by ''). */
const SEARCH_TEXT_WITHOUT_NAME = "lowerUTF8(concat(description,' ','',' ',tenant_name,' ',arrayStringConcat(target_names,' ')))";
const FREE_TEXT = /\((hasToken|position)\(search_text, (lowerUTF8\(\{q\d+:String\}\))\)( > 0)?\)/g;

/**
 * Rewrites a compiled query-language filter so it cannot probe a masked address (#333):
 * - every `actor_name` reference reads an empty string where the name is the address, so `actor.name:"a@b"` (or a
 *   prefix or wildcard) never matches those rows;
 * - free text on such a row is evaluated only against the text it would have with an empty name, never the original
 *   `search_text`, so neither the result nor the work depends on the hidden name. (Masked free text cannot use the
 *   text index for those rows; it scans the project and range.)
 * Fails closed: a `search_text` use this rewrite does not recognise throws instead of passing through unmasked.
 */
export function maskActorNameInFilter(sql: string): string {
  // actor_name first: the free-text rewrite below adds references that must stay as they are (replace never rescans).
  const named = sql.replace(/\bactor_name\b/g, `if(${ACTOR_NAME_IS_SENSITIVE_SQL},'',actor_name)`);
  const uses = (named.match(/\bsearch_text\b/g) ?? []).length;
  let rewritten = 0;
  const out = named.replace(FREE_TEXT, (match: string, fn: string, arg: string, gt: string | undefined) => {
    rewritten++;
    return `((NOT ${ACTOR_NAME_IS_SENSITIVE_SQL} AND ${match}) OR (${ACTOR_NAME_IS_SENSITIVE_SQL} AND ${fn}(${SEARCH_TEXT_WITHOUT_NAME}, ${arg})${gt ?? ''}))`;
  });
  if (rewritten !== uses) throw new Error('Free-text filter cannot be masked for this scope.');
  return out;
}
