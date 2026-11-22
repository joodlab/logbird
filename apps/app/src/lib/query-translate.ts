/**
 * Best-effort translation of simple query-language filters to SQL mode expressions. Used when switching
 * Query → SQL and when facets / "filter by this value" add a term while SQL mode is on.
 *
 * Only constructs with an unambiguous SQL equivalent are translated; anything else (free text, phrases,
 * the `description` text field) returns null so the caller can ask instead of guessing.
 */
import { decodeRecordPair, QUERY_DIALECT_PREFIX, queryFieldName, readQueryValue, scanBareRecordValue } from '@logbird/contracts';
import { attributeKey, coreField } from './query-catalog';
import { type QueryToken, tokenize } from './query-language';
import { sqlString } from './sql-language';

const NUMBER = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T.+)?$/;
const SQL_OPS: Record<string, string> = { '>': '>', '>=': '>=', '<': '<', '<=': '<=' };
const QUOTED_VALUE = /^"(?:[^"\\]|\\[\s\S])*"$/;
const BARE_VALUE = /^[^\s()"<>[\]{}]+$/;

type Target = { ref: string; type: 'string' | 'number' | 'date' | 'array' } | { ref: string; type: 'attr'; key: string };

function targetFor(field: string): Target | null {
  const core = /^(attr|attributes)\./.test(field) ? undefined : coreField(field);
  if (core) return core.type === 'text' || core.type === 'record' || !core.column ? null : { ref: core.column, type: core.type };
  const key = sqlString(attributeKey(field));
  return { ref: `attributes[${key}]`, type: 'attr', key };
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

function presence(t: Target): string {
  if (t.type === 'array') return `arrayExists(x -> x != '', ${t.ref})`;
  if (t.type === 'number' || t.type === 'date') return '1 = 1';
  return `${t.ref} != ''`;
}

function attributePredicate(t: Target, sql: string | null): string | null {
  return sql && t.type === 'attr' ? `(mapContains(attributes, ${t.key}) AND ${sql})` : sql;
}

function equals(t: Target, value: string, wildcard: boolean | undefined): string | null {
  if (wildcard && value === '*') return presence(t);
  if (wildcard) {
    const prefix = sqlString(value.slice(0, -1));
    return t.type === 'array' ? `arrayExists(x -> startsWith(x, ${prefix}), ${t.ref})` : `startsWith(${t.ref}, ${prefix})`;
  }
  if (t.type === 'number' && !NUMBER.test(value)) return null;
  if (t.type === 'array') return `has(${t.ref}, ${sqlString(value)})`;
  return `${t.ref} = ${literal(value, t)}`;
}

function recordValueToSql(raw: string): string | null {
  const quoted = raw.startsWith('"');
  if (quoted ? !QUOTED_VALUE.test(raw) : raw.startsWith('/') || QUERY_DIALECT_PREFIX.test(raw) || scanBareRecordValue(raw, 0) !== raw.length)
    return null;
  const { value, wildcard } = readQueryValue(raw);
  if (!quoted && wildcard && value === '*') return 'notEmpty(target_ids)';
  const pair = decodeRecordPair(value);
  if (!pair) return null;
  const id = sqlString(pair.id);
  return `(has(target_ids, ${id}) AND arrayExists((t, i) -> t = ${sqlString(pair.type)} AND i = ${id}, target_types, target_ids))`;
}

function groupMembers(value: string): string[] | null {
  if (!value.endsWith(')')) return null;
  const inner = value.slice(1, -1).trim();
  const member = /("(?:[^"\\]|\\[\s\S])*"|[^\s()"<>[\]{}]+)(?:\s+OR\s+|$)/gy;
  const parts: string[] = [];
  let end = 0;
  for (const match of inner.matchAll(member)) {
    parts.push(match[1] ?? '');
    end = match.index + match[0].length;
  }
  return parts.length && end === inner.length ? parts : null;
}

function recordTermToSql(token: QueryToken, raw: string): string | null {
  if (token.valueKind === 'plain' || token.valueKind === 'quoted') return recordValueToSql(raw);
  if (token.valueKind !== 'group') return null;
  const parts = groupMembers(raw)?.map(recordValueToSql);
  return parts?.every(Boolean) ? `(${parts.join(' OR ')})` : null;
}

function isBareValue(raw: string): boolean {
  return BARE_VALUE.test(raw) && !/^(?:AND|OR|NOT|TO)(?=:|$)|&&|\|\|/.test(raw) && !QUERY_DIALECT_PREFIX.test(raw);
}

function isSimpleOperand(token: QueryToken, raw: string, start: number): boolean {
  if (token.valueKind === 'quoted') return QUOTED_VALUE.test(raw);
  return token.valueKind === 'plain' && isBareValue(raw) && !(raw.startsWith('-') && /\s/.test(token.raw[start - 1] ?? ''));
}

function termToSql(token: QueryToken): string | null {
  const start = (token.valueStart ?? token.start) - token.start;
  const raw = token.raw.slice(start);
  const value = token.value ?? '';
  if (token.field === 'record') return recordTermToSql(token, raw);
  if (token.field === '_exists_') {
    if (!isSimpleOperand(token, raw, start) || (token.valueKind === 'plain' && raw.includes(':'))) return null;
    const field = queryFieldName(raw);
    if (field === 'record') return 'notEmpty(target_ids)';
    const target = targetFor(field);
    return target ? attributePredicate(target, presence(target)) : null;
  }
  const t = targetFor(token.field ?? '');
  if (!t) return null;
  switch (token.valueKind) {
    case 'plain':
    case 'quoted':
      return isSimpleOperand(token, raw, start) ? attributePredicate(t, equals(t, value, token.wildcard)) : null;
    case 'compare': {
      const operand = raw.slice(token.op?.length ?? 0);
      if (t.type === 'string' || t.type === 'array' || (!NUMBER.test(value) && !DATE.test(value)) || /^\s+-/.test(operand)) return null;
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
      if (!/^\/(?:[^/\\]|\\[\s\S])*\/$/.test(value)) return null;
      const body = value.slice(1, -1).replaceAll('\\/', '/');
      const re = sqlString(`^(?:${body})$`);
      return t.type === 'array' ? `arrayExists(x -> match(x, ${re}), ${t.ref})` : attributePredicate(t, `match(${t.ref}, ${re})`);
    }
    case 'group': {
      const members = groupMembers(value);
      if (!members || members.some((m) => !QUOTED_VALUE.test(m) && (/^[-/]/.test(m) || !isBareValue(m)))) return null;
      const values = members.map(readQueryValue);
      if (values.some((v) => v.wildcard)) {
        const each = values.map((v) => equals(t, v.value, v.wildcard));
        return each.every(Boolean) ? attributePredicate(t, `(${each.join(' OR ')})`) : null;
      }
      if (t.type === 'array') return `hasAny(${t.ref}, [${values.map(({ value: member }) => sqlString(member)).join(', ')}])`;
      return attributePredicate(t, `${t.ref} IN (${values.map(({ value: member }) => literal(member, t)).join(', ')})`);
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
  if (!q.trim()) return '';
  const out: string[] = [];
  let needsAnd = false;
  let pendingNot = false;
  let depth = 0;
  for (const tok of tokenize(q)) {
    if (tok.kind === 'space') continue;
    if (tok.kind === 'operator') {
      if (tok.raw === 'NOT') {
        if (needsAnd) out.push('AND');
        needsAnd = false;
        pendingNot = !pendingNot;
        continue;
      }
      if (!needsAnd) return null;
      out.push(tok.raw);
      needsAnd = false;
      continue;
    }
    if (tok.kind === 'paren') {
      if (tok.raw === ')') {
        if (!needsAnd || depth === 0) return null;
        depth -= 1;
        out.push(')');
        needsAnd = true;
        continue;
      }
      depth += 1;
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
  if (!needsAnd || depth !== 0) return null;
  return out.map((part, i) => (i === 0 || part === ')' || out[i - 1]?.endsWith('(') ? part : ` ${part}`)).join('');
}
