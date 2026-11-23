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

/** The server's number grammar for comparisons (`packages/clickhouse/src/query.ts`): `+200`, `1e2` and `.5` are numbers. */
const SERVER_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** On an attribute, the server compares a value that starts like a date as a date, anything else as a number. */
const DATE_START = /^(?:\d{4}-\d{2}-\d{2}|now(?:$|[-+/]))/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/;
/** The server's relative dates (`now`, `now-7d`, `now/d`): resolved when the query runs, in either mode. */
const RELATIVE = /^now(?:([+-])(\d+)([smhdw]))?(\/d)?$/;
/** Units as elapsed time, as the server counts them: a day is 86,400 s even across a daylight-saving change. */
const RELATIVE_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 } as const;
const DAY_MS = 86_400_000;
/** Instants SQL mode computes exactly as the server does (`toStartOfDay` and DateTime64 stop short of 1970 and 2299). */
const SQL_INSTANTS = { from: Date.UTC(1970, 0, 2), to: Date.UTC(2200, 0, 1) };

/**
 * The SQL instant for a date bound, or null when the two modes could disagree on it: a value the server rejects, or a
 * relative instant outside what SQL mode computes identically. Only allowed SQL-mode functions are emitted.
 */
export function dateSql(value: string, now = Date.now()): string | null {
  const m = RELATIVE.exec(value);
  if (m) {
    const seconds = Number(m[2] ?? 0) * RELATIVE_SECONDS[(m[3] ?? 's') as keyof typeof RELATIVE_SECONDS];
    const instant = now + (m[1] === '-' ? -1 : 1) * seconds * 1000;
    const rounded = m[4] ? Math.floor(instant / DAY_MS) * DAY_MS : instant;
    if (!Number.isFinite(rounded) || rounded < SQL_INSTANTS.from || rounded > SQL_INSTANTS.to) return null;
    const shifted = m[1] ? `now64(3) ${m[1]} INTERVAL ${seconds} SECOND` : 'now64(3)';
    return m[4] ? `toStartOfDay(${shifted}, 'UTC')` : shifted;
  }
  if (value.startsWith('now')) return null;
  // Validated as the server validates it, then sent as the same normalised instant.
  const calendar = value.slice(0, 10);
  const midnight = new Date(`${calendar}T00:00:00Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== calendar || !ISO_DATE.test(value)) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(d.getTime()) || (value.length === 10 && d.toISOString().slice(0, 10) !== value)) return null;
  return `parseDateTime64BestEffortOrNull(${sqlString(d.toISOString())}, 3, 'UTC')`;
}

/**
 * `field <op> value` as the server compiles a comparison (`predicate()`'s numeric path): each value decides on its own
 * whether it is a date or a number, so `attr.v:[2 TO now]` compares the lower bound as a number and the upper as a date.
 */
function comparison(t: Target, op: string, value: string): string | null {
  if (t.type === 'string' || t.type === 'array') return null;
  if (t.type === 'date' || (t.type === 'attr' && DATE_START.test(value))) {
    const bound = dateSql(value);
    return bound && `${t.type === 'attr' ? `parseDateTime64BestEffortOrNull(${t.ref}, 3, 'UTC')` : t.ref} ${op} ${bound}`;
  }
  const n = Number(value);
  if (!SERVER_NUMBER.test(value) || !Number.isFinite(n)) return null;
  return `${t.type === 'attr' ? `toFloat64OrNull(${t.ref})` : t.ref} ${op} ${String(n)}`;
}

/** A range bound as the server reads it: open for an unescaped star (quoted or not), else its decoded value. */
function rangeBound(raw: string): { open: boolean; value: string } | null {
  if (raw.startsWith('"') && !QUOTED_VALUE.test(raw)) return null;
  const { value, wildcard } = readQueryValue(raw);
  return { open: wildcard && value === '*', value };
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
    // A prefix on a number or date field is an error to the server, never a text match.
    if (t.type === 'number' || t.type === 'date') return null;
    const prefix = sqlString(value.slice(0, -1));
    return t.type === 'array' ? `arrayExists(x -> startsWith(x, ${prefix}), ${t.ref})` : `startsWith(${t.ref}, ${prefix})`;
  }
  // Number and date fields compare as the server compares them; strings and attributes match the text exactly.
  if (t.type === 'number' || t.type === 'date') return comparison(t, '=', value);
  if (t.type === 'array') return `has(${t.ref}, ${sqlString(value)})`;
  return `${t.ref} = ${sqlString(value)}`;
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
      if (/^\s+-/.test(operand)) return null;
      return comparison(t, SQL_OPS[token.op ?? '>'] ?? '>', value);
    }
    case 'range': {
      const m = /^([[{])\s*(\S+)\s+TO\s+(\S+)\s*([\]}])$/.exec(value);
      if (!m || t.type === 'string' || t.type === 'array') return null;
      const [, open, rawLo = '*', rawHi = '*', close] = m;
      // Bounds read as the server reads them, each compared on its own (a number and a date can share a range).
      const lo = rangeBound(rawLo);
      const hi = rangeBound(rawHi);
      if (lo === null || hi === null) return null;
      const parts = [
        lo.open ? '' : comparison(t, open === '[' ? '>=' : '>', lo.value),
        hi.open ? '' : comparison(t, close === ']' ? '<=' : '<', hi.value),
      ];
      if (parts.includes(null)) return null;
      return parts.filter(Boolean).join(' AND ') || null;
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
      if (t.type === 'number' || t.type === 'date') {
        // The server ORs one comparison per member for these fields.
        const each = values.map(({ value: member }) => comparison(t, '=', member));
        return each.every(Boolean) ? `(${each.join(' OR ')})` : null;
      }
      return attributePredicate(t, `${t.ref} IN (${values.map(({ value: member }) => sqlString(member)).join(', ')})`);
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
