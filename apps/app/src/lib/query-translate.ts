/**
 * Best-effort translation of simple query-language filters to SQL mode expressions. Used when switching
 * Query → SQL and when facets / "filter by this value" add a term while SQL mode is on.
 *
 * Only constructs with an unambiguous SQL equivalent are translated; anything else (free text, phrases,
 * the `description` text field) returns null so the caller can ask instead of guessing.
 */
import { attributeKey, coreField } from './query-catalog';
import { type QueryToken, tokenize } from './query-language';
import { sqlString } from './sql-language';

const NUMBER = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T.+)?$/;
const SQL_OPS: Record<string, string> = { '>': '>', '>=': '>=', '<': '<', '<=': '<=' };

interface Target {
  /** SQL reference: column or `attributes['k']`. */
  ref: string;
  type: 'string' | 'number' | 'date' | 'array' | 'attr';
}

function targetFor(field: string): Target | null {
  const core = /^(attr|attributes)\./.test(field) ? undefined : coreField(field);
  if (core) return core.type === 'text' ? null : { ref: core.column, type: core.type };
  return { ref: `attributes[${sqlString(attributeKey(field))}]`, type: 'attr' };
}

function literal(value: string, t: Target, forceNumber = false): string {
  if ((t.type === 'number' || forceNumber) && NUMBER.test(value)) return value;
  if (t.type === 'date' || (forceNumber && DATE.test(value))) return `parseDateTime64BestEffort(${sqlString(value)}, 3, 'UTC')`;
  return sqlString(value);
}

/** Numeric/date view of a target for comparisons (attributes are strings). */
function ordered(t: Target, sample: string): string {
  if (t.type !== 'attr') return t.ref;
  return DATE.test(sample) ? `parseDateTime64BestEffortOrNull(${t.ref}, 3, 'UTC')` : `toFloat64OrNull(${t.ref})`;
}

function equals(t: Target, value: string): string | null {
  if (value === '*')
    return t.type === 'array' ? `notEmpty(${t.ref})` : t.type === 'number' || t.type === 'date' ? `isNotNull(${t.ref})` : `${t.ref} != ''`;
  if (value.endsWith('*') && !value.slice(0, -1).includes('*')) {
    const prefix = sqlString(value.slice(0, -1));
    return t.type === 'array' ? `arrayExists(x -> startsWith(x, ${prefix}), ${t.ref})` : `startsWith(${t.ref}, ${prefix})`;
  }
  if (t.type === 'number' && !NUMBER.test(value)) return null;
  if (t.type === 'array') return `has(${t.ref}, ${sqlString(value)})`;
  return `${t.ref} = ${literal(value, t)}`;
}

function termToSql(token: QueryToken): string | null {
  const t = targetFor(token.field ?? '');
  if (!t) return null;
  const value = token.value ?? '';
  switch (token.valueKind) {
    case 'plain':
    case 'quoted':
      if (token.valueKind === 'quoted') {
        if (t.type === 'array') return `has(${t.ref}, ${sqlString(value)})`;
        return `${t.ref} = ${literal(value, t)}`;
      }
      return equals(t, value);
    case 'compare': {
      if (t.type === 'string' || t.type === 'array' || !value) return null;
      return `${ordered(t, value)} ${SQL_OPS[token.op ?? '>']} ${literal(value, t, t.type === 'attr')}`;
    }
    case 'range': {
      const m = /^([[{])\s*(\S+)\s+TO\s+(\S+)\s*([\]}])$/.exec(value);
      if (!m || t.type === 'string' || t.type === 'array') return null;
      const [, open, lo = '*', hi = '*', close] = m;
      const ref = ordered(t, lo === '*' ? hi : lo);
      const parts = [
        lo === '*' ? null : `${ref} ${open === '[' ? '>=' : '>'} ${literal(lo, t, t.type === 'attr')}`,
        hi === '*' ? null : `${ref} ${close === ']' ? '<=' : '<'} ${literal(hi, t, t.type === 'attr')}`,
      ].filter(Boolean);
      return parts.length ? parts.join(' AND ') : null;
    }
    case 'regex': {
      const body = value.slice(1, value.endsWith('/') && value.length > 1 ? -1 : undefined).replaceAll('\\/', '/');
      const re = sqlString(`^(?:${body})$`);
      return t.type === 'array' ? `arrayExists(x -> match(x, ${re}), ${t.ref})` : `match(${t.ref}, ${re})`;
    }
    case 'group': {
      const inner = value.replace(/^\(|\)$/g, '');
      const members = inner
        .split(/\s+OR\s+/)
        .map((m) => m.trim())
        .filter(Boolean);
      if (members.length === 0 || members.some((m) => /[\s()]/.test(m.replace(/^"(.*)"$/, '')) && !/^".*"$/.test(m))) return null;
      const values = members.map((m) => (m.startsWith('"') ? m.slice(1, -1).replace(/\\(.)/g, '$1') : m));
      if (values.some((v) => v.includes('*'))) {
        const each = values.map((v) => equals(t, v));
        return each.every(Boolean) ? `(${each.join(' OR ')})` : null;
      }
      if (t.type === 'array') return `hasAny(${t.ref}, [${values.map(sqlString).join(', ')}])`;
      return `${t.ref} IN (${values.map((v) => literal(v, t)).join(', ')})`;
    }
    default:
      return null;
  }
}

/**
 * Translate a query-language filter to a SQL WHERE expression, or null when it contains anything
 * without a faithful equivalent. Empty input translates to ''.
 */
export function translateQueryToSql(q: string): string | null {
  const out: string[] = [];
  let needsAnd = false;
  let pendingNot = false;
  for (const tok of tokenize(q)) {
    if (tok.kind === 'space') continue;
    if (tok.kind === 'operator') {
      if (tok.raw === 'NOT') {
        if (needsAnd) out.push('AND');
        needsAnd = false;
        pendingNot = !pendingNot;
        continue;
      }
      out.push(tok.raw);
      needsAnd = false;
      continue;
    }
    if (tok.kind === 'paren') {
      if (tok.raw === ')') {
        out.push(')');
        needsAnd = true;
        continue;
      }
      if (needsAnd) out.push('AND');
      out.push(`${pendingNot !== tok.negated ? 'NOT ' : ''}(`);
      pendingNot = false;
      needsAnd = false;
      continue;
    }
    if (tok.kind !== 'field') return null;
    const sql = termToSql(tok);
    if (!sql) return null;
    if (needsAnd) out.push('AND');
    const negate = pendingNot !== tok.negated;
    const grouped = sql.includes(' AND ') || sql.includes(' OR ');
    out.push(
      negate
        ? `NOT ${grouped || sql.startsWith('(') ? (sql.startsWith('(') ? sql : `(${sql})`) : sql}`
        : grouped && !sql.startsWith('(')
          ? `(${sql})`
          : sql,
    );
    pendingNot = false;
    needsAnd = true;
  }
  return out.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')');
}
