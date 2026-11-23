import type { QueryLang } from '@logbird/contracts';
import { coreField } from '@/lib/query-catalog';
import { andQuery, canonicalField, fieldTerms, formatTerm, hasTopLevelOr, type QueryToken, removeTokens } from '@/lib/query-language';
import { appendSqlPredicate, removeSqlConjuncts, sqlConjuncts, sqlString, unquoteSql } from '@/lib/sql-language';

/**
 * Filters on a field that is often empty (the support agent behind an impersonated event). `*` means "has any
 * value", so `field:*` and the specific values form ONE group with the hidden-empty state `-field:*`:
 *
 * - including any value (`*` or one agent) drops `-field:*`; including a specific value also drops `field:*` (the
 *   same "positive terms for one field are replaced" rule as every facet);
 * - excluding `*` drops every other term for the field (positive and negative), since nothing else can match;
 * - excluding one value drops `-field:*` and that value's positive term.
 *
 * So no click from the sidebar can leave a contradiction such as `-impersonator:* impersonator:support_1`. Hand-written
 * value groups (`impersonator:(a OR b)`, or a parenthesised `(impersonator_id = 'a')` in SQL) belong to the group too and
 * are replaced with it; other hand-written forms (`impersonator_id IN (…)`, `impersonator:/re/`) are left as typed.
 *
 * Every predicate is ANDed with `andQuery` / `appendSqlPredicate`, so a query with a top-level OR is parenthesised and
 * the presence filter constrains all of it.
 */
export interface PresenceTerm {
  /** Null represents any value. */
  value: string | null;
  negated: boolean;
  prefix?: boolean;
}

interface Adapter {
  terms: (q: string) => PresenceTerm[];
  remove: (q: string, test: (t: PresenceTerm) => boolean) => string;
  add: (q: string, t: PresenceTerm) => string;
}

const OWN_KINDS = new Set(['plain', 'quoted', 'group']);
const isPresence = (t: QueryToken) => t.value === '*' && t.wildcard;
const presenceTerm = (field: string, negated = false) => `${negated ? '-' : ''}${field}:*`;

function queryAdapter(field: string): Adapter {
  const f = canonicalField(field);
  const isOwn = (t: { valueKind?: string; field?: string }) => OWN_KINDS.has(t.valueKind ?? '') && canonicalField(t.field ?? '') === f;
  // Polarity counts a unary NOT (`NOT impersonator:(a OR b)` is an exclusion), and removal takes that NOT with it.
  const own = (q: string) => fieldTerms(q).filter(isOwn);
  const term = (token: QueryToken): PresenceTerm => ({
    value: isPresence(token) ? null : (token.value ?? ''),
    negated: token.negated,
    prefix: token.wildcard && token.value !== '*',
  });
  return {
    terms: (q) => own(q).map(term),
    remove: (q, test) => removeTokens(q, (t) => isOwn(t) && test(term(t))),
    add: (q, t) => andQuery(q, t.value === null ? presenceTerm(field, t.negated) : formatTerm(field, t.value, t.negated)),
  };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** SQL mode for a String column: `col != ''` is "any value", `col = ''` hides them all. */
export function presenceSqlPredicate(column: string, t: PresenceTerm): string {
  if (t.value === null) return t.negated ? `${column} = ''` : `${column} != ''`;
  return `${column} ${t.negated ? '!=' : '='} ${sqlString(t.value)}`;
}

/** `(x)` → `x` while the outer parentheses enclose the whole conjunct (quotes respected). */
function unwrapParens(conjunct: string): string {
  let c = conjunct.trim();
  for (;;) {
    if (!(c.startsWith('(') && c.endsWith(')'))) return c;
    let depth = 0;
    let quoted = false;
    let whole = true;
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (quoted) {
        if (ch === '\\') i += 1;
        else if (ch === "'") quoted = false;
      } else if (ch === "'") quoted = true;
      else if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0 && i < c.length - 1) whole = false;
      }
    }
    if (!whole) return c;
    c = c.slice(1, -1).trim();
  }
}

/** Reads one top-level `col = '…'` / `col != '…'` conjunct (redundant parentheses allowed) back as a presence term. */
export function parsePresenceSql(conjunct: string, column: string): PresenceTerm | null {
  // The literal as ClickHouse reads it: backslash escapes (newlines included) and doubled apostrophes.
  const m = new RegExp(`^${escapeRegExp(column)}\\s*(!=|<>|=)\\s*'((?:[^'\\\\]|\\\\[\\s\\S]|'')*)'$`).exec(unwrapParens(conjunct));
  if (!m) return null;
  const notEqual = m[1] !== '=';
  const value = unquoteSql(m[2] ?? '');
  if (value === '') return { value: null, negated: !notEqual };
  return { value, negated: notEqual };
}

function sqlAdapter(column: string): Adapter {
  return {
    terms: (q) => sqlConjuncts(q).flatMap((c) => parsePresenceSql(c, column) ?? []),
    remove: (q, test) =>
      removeSqlConjuncts(q, (c) => {
        const t = parsePresenceSql(c, column);
        return t !== null && test(t);
      }),
    add: (q, t) => appendSqlPredicate(q, presenceSqlPredicate(column, t)),
  };
}

function adapter(field: string, lang: QueryLang): Adapter {
  return lang === 'sql' ? sqlAdapter(coreField(field)?.column ?? field) : queryAdapter(field);
}

const same = (a: PresenceTerm, b: PresenceTerm) => !a.prefix && a.value === b.value && a.negated === b.negated;

export function hasPresenceTerm(q: string, field: string, t: PresenceTerm, lang: QueryLang = 'query'): boolean {
  return adapter(field, lang)
    .terms(q)
    .some((x) => same(x, t));
}

/** Facet-row toggle (click → include / un-include, ⌥/Alt-click → exclude / un-exclude) keeping the group consistent. */
export function togglePresenceTerm(q: string, field: string, value: string | null, mode: 'include' | 'exclude', lang: QueryLang = 'query'): string {
  const a = adapter(field, lang);
  const t: PresenceTerm = { value, negated: mode === 'exclude' };
  if (a.terms(q).some((x) => same(x, t))) return a.remove(q, (x) => same(x, t));
  if (!t.negated)
    return a.add(
      a.remove(q, (x) => !x.negated || x.value === null || (!x.prefix && x.value === value)),
      t,
    );
  if (value === null)
    return a.add(
      a.remove(q, () => true),
      t,
    );
  return a.add(
    a.remove(q, (x) => (!x.prefix && x.value === value) || (x.negated && x.value === null)),
    t,
  );
}

/**
 * Narrow a query to events that have the field (`field:*`), e.g. to count support without the empty bucket. An
 * existing `field:*` only counts when it constrains the whole query (outside every group, no top-level OR).
 */
export function withPresence(q: string, field: string, lang: QueryLang = 'query'): string {
  const any: PresenceTerm = { value: null, negated: false };
  if (lang === 'sql') {
    const a = adapter(field, lang);
    return a.terms(q).some((x) => same(x, any)) ? q.trim() : a.add(q, any);
  }
  const f = canonicalField(field);
  const constrained = !hasTopLevelOr(q) && fieldTerms(q, true).some((t) => !t.negated && isPresence(t) && canonicalField(t.field ?? '') === f);
  return constrained ? q.trim() : andQuery(q, presenceTerm(field));
}

/** Every simple term for the field, for whole-group rewrites ("who did it"). */
export function presenceTerms(q: string, field: string, lang: QueryLang = 'query'): PresenceTerm[] {
  return adapter(field, lang).terms(q);
}

/** Replace the field's group: `null` clears it, otherwise exactly `t` (keeping terms `keep` accepts). */
export function setPresence(
  q: string,
  field: string,
  t: PresenceTerm | null,
  lang: QueryLang = 'query',
  keep: (x: PresenceTerm) => boolean = () => false,
): string {
  const a = adapter(field, lang);
  const cleared = a.remove(q, (x) => !keep(x));
  return t ? a.add(cleared, t) : cleared;
}
