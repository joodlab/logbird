import type { QueryLang } from '@logbird/contracts';
import { coreField } from '@/lib/query-catalog';
import { canonicalField, fieldTerms, formatTerm, removeTerm } from '@/lib/query-language';
import { appendSqlPredicate, removeSqlConjuncts, sqlConjuncts, sqlString } from '@/lib/sql-language';

/**
 * Filters on a field that is often empty (the support agent behind an impersonated event). `*` means "has any
 * value", so `field:*` and the specific values form ONE group with the hidden-empty state `-field:*`:
 *
 * - including any value (`*` or one agent) drops `-field:*`; including a specific value also drops `field:*` (the
 *   same "positive terms for one field are replaced" rule as every facet);
 * - excluding `*` drops every other term for the field (positive and negative), since nothing else can match;
 * - excluding one value drops `-field:*` and that value's positive term.
 *
 * So no click can leave a contradiction such as `-impersonator:* impersonator:support_1` that matches nothing.
 */
export interface PresenceTerm {
  /** `*` for "any value", else one value. */
  value: string;
  negated: boolean;
}

interface Adapter {
  terms: (q: string) => PresenceTerm[];
  remove: (q: string, test: (t: PresenceTerm) => boolean) => string;
  add: (q: string, t: PresenceTerm) => string;
}

function queryAdapter(field: string): Adapter {
  const f = canonicalField(field);
  const own = (q: string) =>
    fieldTerms(q).filter((t) => (t.valueKind === 'plain' || t.valueKind === 'quoted') && canonicalField(t.field ?? '') === f);
  return {
    terms: (q) => own(q).map((t) => ({ value: t.value ?? '', negated: Boolean(t.negated) })),
    remove: (q, test) =>
      own(q).reduce((acc, t) => (test({ value: t.value ?? '', negated: Boolean(t.negated) }) ? removeTerm(acc, field, t.value, t.negated) : acc), q),
    add: (q, t) => `${q} ${formatTerm(field, t.value, t.negated)}`.trim(),
  };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** SQL mode for a String column: `col != ''` is "any value", `col = ''` hides them all. */
export function presenceSqlPredicate(column: string, t: PresenceTerm): string {
  if (t.value === '*') return t.negated ? `${column} = ''` : `${column} != ''`;
  return `${column} ${t.negated ? '!=' : '='} ${sqlString(t.value)}`;
}

/** Reads one top-level `col = '…'` / `col != '…'` conjunct back as a presence term. */
export function parsePresenceSql(conjunct: string, column: string): PresenceTerm | null {
  const m = new RegExp(`^${escapeRegExp(column)}\\s*(!=|<>|=)\\s*'((?:[^'\\\\]|\\\\.)*)'$`).exec(conjunct.trim());
  if (!m) return null;
  const notEqual = m[1] !== '=';
  const value = (m[2] ?? '').replace(/\\(.)/g, '$1');
  if (value === '') return { value: '*', negated: !notEqual };
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

const same = (a: PresenceTerm, b: PresenceTerm) => a.value === b.value && a.negated === b.negated;

export function hasPresenceTerm(q: string, field: string, t: PresenceTerm, lang: QueryLang = 'query'): boolean {
  return adapter(field, lang)
    .terms(q)
    .some((x) => same(x, t));
}

/** Facet-row toggle (click → include / un-include, ⌥/Alt-click → exclude / un-exclude) keeping the group consistent. */
export function togglePresenceTerm(q: string, field: string, value: string, mode: 'include' | 'exclude', lang: QueryLang = 'query'): string {
  const a = adapter(field, lang);
  const t: PresenceTerm = { value, negated: mode === 'exclude' };
  if (a.terms(q).some((x) => same(x, t))) return a.remove(q, (x) => same(x, t));
  if (!t.negated)
    return a.add(
      a.remove(q, (x) => !x.negated || x.value === '*' || x.value === value),
      t,
    );
  if (value === '*')
    return a.add(
      a.remove(q, () => true),
      t,
    );
  return a.add(
    a.remove(q, (x) => x.value === value || (x.negated && x.value === '*')),
    t,
  );
}

/** Narrow a query to events that have the field (`field:*`), e.g. to count support without the empty bucket. */
export function withPresence(q: string, field: string, lang: QueryLang = 'query'): string {
  const a = adapter(field, lang);
  return a.terms(q).some((x) => same(x, { value: '*', negated: false })) ? q.trim() : a.add(q, { value: '*', negated: false });
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
