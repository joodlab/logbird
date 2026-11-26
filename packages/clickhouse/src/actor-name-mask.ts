/**
 * The `actor_email` mask also hides an actor name that carries an address (#333): a producer that used the address as
 * the display name, put it inside the name ("Ada <ada@example.org>"), or sent an address only as the name. The same
 * rule covers the impersonator (the support person acting as the actor): their name, judged against the impersonator's
 * email, which ingest keeps as the attribute `impersonator.email`. One rule everywhere, in TypeScript for events
 * (`maskEvent`) and in SQL for facets and filters. Normalised (lower-cased, every whitespace character removed), the
 * name is sensitive when it:
 * - contains `@` or a compatibility form of it (fullwidth U+FF20, small U+FE6B: NFKC maps both to `@`); or
 * - equals the email; or
 * - was cut at its 512-unit storage cap (511 or more UTF-16 units stored): the cut can fall inside an address, leaving
 *   its local part without the `@` (and with no email to compare against), so a capped name always counts.
 * A sensitive name shows as a pseudonym: of the stored email whenever there is one (any non-empty text), so it always equals the email's own
 * pseudonym and the pair says nothing about how the name relates to the email; with no email, of the normalised name
 * (or of the name as stored, when normalising leaves nothing). It masks more than strictly needed; never less.
 */
import { createHmac } from 'node:crypto';

/** Whose address a pseudonym stands for. */
export type MaskedRole = 'actor' | 'impersonator';
/**
 * A stable per-project pseudonym, so scoped readers can still group by person. The impersonator's are keyed by role
 * (a NUL-led tag, which no actor input can start with: project ids are never empty), so the two roles hash disjoint
 * inputs and an impersonator's pseudonym cannot be compared directly with an actor's.
 */
export function maskedEmail(projectId: string, email: string, secret: Buffer, role: MaskedRole = 'actor') {
  if (!email) return '';
  const input = `${role === 'impersonator' ? '\0impersonator\0' : ''}${projectId}\0${email.toLowerCase()}`;
  return `masked:${createHmac('sha256', secret).update(input).digest('hex').slice(0, 24)}`;
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
/** `@` and its compatibility forms, in JavaScript and (bound as a parameter) RE2 syntax. */
const AT_JS = /[@\uFF20\uFE6B]/u;
const AT_RE2 = '[@\\x{FF20}\\x{FE6B}]';

const normalized = (value: string) => value.replace(SPACES, '').toLowerCase();
const capped = (name: string) => name.length >= NAME_CAP_REACHED;
/** Whether an actor name carries an address under the mask rule. */
export function actorNameIsSensitive(name: string, email: string) {
  const n = normalized(name);
  const e = normalized(email);
  return AT_JS.test(n) || (e !== '' && n === e) || capped(name);
}
/** What a sensitive name's pseudonym hashes: the stored email if any, else the normalised name, else the name. */
export function actorNamePseudonymInput(name: string, email: string) {
  if (email !== '') return email;
  const n = normalized(name);
  return n !== '' ? n : name;
}

/** Query parameters every masked expression below needs; merge them into the query's params. */
export const ACTOR_NAME_MASK_PARAMS = { actorMaskSpaces: SPACES_RE2, actorMaskAstral: ASTRAL_RE2, actorMaskAt: AT_RE2 } as const;

const sqlNormalized = (column: string) => `lowerUTF8(replaceRegexpAll(${column},{actorMaskSpaces:String},''))`;
const sqlUtf16Length = (column: string) => `(lengthUTF8(${column})+countMatches(${column},{actorMaskAstral:String}))`;

/** A party whose name the actor_email mask judges against an email: SQL for the stored name and the stored email. */
type Party = { name: string; email: string };
/** The actor's columns. */
const ACTOR: Party = { name: 'actor_name', email: 'actor_email' };
/** The impersonator's name column and the attribute ingest keeps their email in (`impersonator` stores id and name only). */
export const IMPERSONATOR_EMAIL_ATTRIBUTE = 'impersonator.email';
/**
 * The impersonator's email in SQL: the attribute `impersonator.email` when it is non-empty, else the first non-empty
 * attribute whose key is that path in another ASCII case (`impersonator.Email`), like `impersonatorEmailOf`. An empty
 * key never shadows a populated variant, so the name rule always judges against an address when there is one.
 */
const IMPERSONATOR_EMAIL_SQL = `if(attributes['${IMPERSONATOR_EMAIL_ATTRIBUTE}']!='',attributes['${IMPERSONATOR_EMAIL_ATTRIBUTE}'],arrayFirst(v -> v != '',arrayFilter((v, k) -> lower(k) = '${IMPERSONATOR_EMAIL_ATTRIBUTE}',mapValues(attributes),mapKeys(attributes))))`;
const IMPERSONATOR: Party = { name: 'impersonator_name', email: IMPERSONATOR_EMAIL_SQL };
/** The impersonator's email in an event's attributes: the exact key if non-empty, else the first non-empty ASCII-case variant. */
export function impersonatorEmailOf(attributes: Record<string, string>) {
  const exact = attributes[IMPERSONATOR_EMAIL_ATTRIBUTE];
  if (exact) return exact;
  for (const [key, value] of Object.entries(attributes))
    if (value && key.replace(/[A-Z]/g, (c) => c.toLowerCase()) === IMPERSONATOR_EMAIL_ATTRIBUTE) return value;
  return '';
}

function partySql({ name, email }: Party) {
  const N = sqlNormalized(name);
  const E = sqlNormalized(email);
  const capped = `${sqlUtf16Length(name)}>=${NAME_CAP_REACHED}`;
  /** SQL form of `actorNameIsSensitive` over the stored columns (UInt8). */
  const sensitive = `(match(${N},{actorMaskAt:String}) OR (${E}!='' AND ${N}=${E}) OR ${capped})`;
  /** SQL form of `actorNamePseudonymInput`, lower-cased as `maskedEmail` lower-cases its input. */
  const pseudonymInput = `if(${email}!='',lowerUTF8(${email}),if(${N}!='',${N},${name}))`;
  return { sensitive, text: `if(${sensitive},${pseudonymInput},${name})` };
}
const actorSql = partySql(ACTOR);
const impersonatorSql = partySql(IMPERSONATOR);
/** SQL form of `actorNameIsSensitive` over the stored actor columns (UInt8). */
export const ACTOR_NAME_IS_SENSITIVE_SQL = actorSql.sensitive;
/**
 * The actor name's facet text under the mask: a sensitive name becomes its pseudonym's input, and the separate flag
 * column (`ACTOR_NAME_IS_SENSITIVE_SQL`) says so. facets() turns flagged text into the address's pseudonym
 * before returning; text is never interpreted by its content, so no producer string can pass for a masked address.
 */
export const MASKED_ACTOR_NAME_TEXT_SQL = actorSql.text;
/** The same rule for the impersonator's name, judged against `attributes['impersonator.email']` (UInt8). */
export const IMPERSONATOR_NAME_IS_SENSITIVE_SQL = impersonatorSql.sensitive;
/** The impersonator name's facet text under the mask, flagged by `IMPERSONATOR_NAME_IS_SENSITIVE_SQL`. */
export const MASKED_IMPERSONATOR_NAME_TEXT_SQL = impersonatorSql.text;
/** Facet flag values: 0 shows the text, 1 the actor's pseudonym of it, 2 the impersonator's (`maskedFacetText`). */
export const FACET_FLAG_ROLE: Record<number, MaskedRole> = { 1: 'actor', 2: 'impersonator' };
/** Masked facet text and flag (`FACET_FLAG_ROLE`) for each stored name column the mask judges. */
export const MASKED_NAME_COLUMNS: Record<string, { text: string; flag: string }> = {
  actor_name: { text: MASKED_ACTOR_NAME_TEXT_SQL, flag: ACTOR_NAME_IS_SENSITIVE_SQL },
  impersonator_name: { text: MASKED_IMPERSONATOR_NAME_TEXT_SQL, flag: `(${IMPERSONATOR_NAME_IS_SENSITIVE_SQL}*2)` },
};
/** The literal flag values a facet row may carry, as numbers or their exact digit strings. */
const FACET_FLAGS = new Map<unknown, number>([
  [0, 0],
  [1, 1],
  [2, 2],
  ['0', 0],
  ['1', 1],
  ['2', 2],
]);
/**
 * A facet row's flag as 0, 1 or 2. Only the exact literals pass (a number, or its digit as JSON may carry it); anything
 * else, '' or [0] included, throws: text under a flag this code does not know may be the address.
 */
export function facetFlag(flag: unknown): 0 | 1 | 2 {
  const value = FACET_FLAGS.get(flag);
  if (value === undefined) throw new Error(`Unknown masked facet flag ${String(flag)}`);
  return value as 0 | 1 | 2;
}
/** A facet value or label under the mask: flagged text becomes the pseudonym of the flag's role. */
export function maskedFacetText(projectId: string, flag: number | string, text: string, secret: Buffer) {
  const value = facetFlag(flag);
  const role = FACET_FLAG_ROLE[value];
  return role ? maskedEmail(projectId, text, secret, role) : text;
}

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
/** Aliases the rewrite defines once per filter, so a query of many terms stays far below the scoped key's 64 KiB SQL limit. */
const NAME_CARRIES_ADDRESS = '__lb_name_carries_address';
const IMPERSONATOR_NAME_CARRIES_ADDRESS = '__lb_impersonator_name_carries_address';
const MASKED_HAYSTACK = '__lb_masked_haystack';

/**
 * Rewrites a compiled query-language filter so it cannot probe a masked address (#333):
 * - every `actor_name` reference reads an empty string where the name carries an address, so `actor.name:"a@b"` (or
 *   a prefix or wildcard) never matches those rows; every `impersonator_name` reference likewise, judged against the
 *   impersonator's email;
 * - free text matches against a sanitised haystack: the stored `search_text`, or on such a row the text it would have
 *   with an empty name. The match function only ever sees the sanitised text, so neither the result nor the work of
 *   the match depends on the hidden name. (Masked free text cannot use the text index; it scans the project and range.)
 * `search_text` holds the actor's name but not the impersonator's, so only the actor's test changes the haystack.
 * The sensitivity tests and the haystack are each written once, as a ClickHouse alias, and referenced from every term.
 * Fails closed: a `search_text` use this rewrite does not recognise throws instead of passing through unmasked.
 */
export function maskActorNameInFilter(sql: string): string {
  const defined = new Set<string>();
  const once = (alias: string, expr: () => string) => {
    if (defined.has(alias)) return alias;
    defined.add(alias);
    return `(${expr()} AS ${alias})`;
  };
  const carries = () => once(NAME_CARRIES_ADDRESS, () => ACTOR_NAME_IS_SENSITIVE_SQL);
  const impersonatorCarries = () => once(IMPERSONATOR_NAME_CARRIES_ADDRESS, () => IMPERSONATOR_NAME_IS_SENSITIVE_SQL);
  // Names first, in one pass: the definitions below add references that must stay as they are (replace never rescans).
  const named = sql.replace(/\b(actor_name|impersonator_name)\b/g, (column: string) =>
    column === 'actor_name' ? `if(${carries()},'',actor_name)` : `if(${impersonatorCarries()},'',impersonator_name)`,
  );
  const uses = (named.match(/\bsearch_text\b/g) ?? []).length;
  let rewritten = 0;
  const out = named.replace(FREE_TEXT, (_match: string, fn: string, arg: string, gt: string | undefined) => {
    rewritten++;
    const haystack = once(MASKED_HAYSTACK, () => `if(${carries()},${SEARCH_TEXT_WITHOUT_NAME},search_text)`);
    return `(${fn}(${haystack}, ${arg})${gt ?? ''})`;
  });
  if (rewritten !== uses) throw new Error('Free-text filter cannot be masked for this scope.');
  return out;
}
