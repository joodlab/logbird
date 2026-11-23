/**
 * Best-effort translation of simple query-language filters to SQL mode expressions. Used when switching
 * Query → SQL and when facets / "filter by this value" add a term while SQL mode is on.
 *
 * Only constructs with an unambiguous SQL equivalent are translated; anything else (free text, phrases,
 * the `description` text field) returns null so the caller can ask instead of guessing.
 */
import {
  decodeRecordPair,
  parseQueryExpression,
  QUERY_DIALECT_PREFIX,
  type QueryAtom,
  QueryError,
  type QueryExpression,
  type QuerySyntaxToken,
  readQueryValue,
  scanBareRecordValue,
} from '@logbird/contracts';
import { attributeKey, coreField } from './query-catalog';
import { type QueryToken, tokenize } from './query-language';
import { sqlString } from './sql-language';

const SQL_OPS: Record<string, string> = { '>': '>', '>=': '>=', '<': '<', '<=': '<=' };
const QUOTED_VALUE = /^"(?:[^"\\]|\\[\s\S])*"$/;

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
/**
 * Instants SQL mode computes exactly as the server does. `toStartOfDay` returns a DateTime, which clamps outside
 * 1970-01-01 … 2106-02-07, so relative dates are only translated well inside that window.
 */
const SQL_INSTANTS = { from: Date.UTC(1970, 0, 2), to: Date.UTC(2106, 0, 1) };

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
  // The server binds every number as Float64. An integer literal is read as an integer type, which keeps digits a Float64
  // drops, so integers beyond 2^53 are written in exponent form (a Float64 literal) to compare the same way.
  const literal = Number.isInteger(n) && !Number.isSafeInteger(n) ? n.toExponential() : String(n);
  return `${t.type === 'attr' ? `toFloat64OrNull(${t.ref})` : t.ref} ${op} ${literal}`;
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

/** A regex match, only where the server compiles one the same way (text fields) and only for a regex it accepts. */
function regexMatch(t: Target, source: string): string | null {
  // On number and date fields the server reads a regex's text as a number or date, not as a pattern.
  if (t.type === 'number' || t.type === 'date') return null;
  try {
    const pattern = new RegExp(source);
    if ([...pattern.source.matchAll(/(?<!\\)\{(\d+)(?:,(\d*))?\}/g)].some((m) => Number(m[1]) > 1000 || Number(m[2] ?? 0) > 1000)) return null;
    if (/\(\?[=!<]|\\[1-9]|\(\?>/.test(source)) return null;
  } catch {
    return null;
  }
  const re = sqlString(`^(?:${source})$`);
  return t.type === 'array' ? `arrayExists(x -> match(x, ${re}), ${t.ref})` : `match(${t.ref}, ${re})`;
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

type FieldAtom = Extract<QueryAtom, { kind: 'field' }>;

/** One value as the server compiles it with `=`: a regex token matches, anything else is `equals`. */
function memberSql(t: Target, token: QuerySyntaxToken): string | null {
  return token.kind === 'regex' ? regexMatch(t, token.value) : equals(t, token.value, token.wildcard);
}

/**
 * One field term, with every value taken from the server's own parse (`atom`): what it joined, decoded and treated as
 * a wildcard is what is translated, so the console's lexer can never change a value's meaning on the way to SQL.
 */
function termToSql(token: QueryToken, atom: FieldAtom): string | null {
  if (atom.value.kind === 'presence') {
    if (atom.field === 'record') return 'notEmpty(target_ids)';
    const target = targetFor(atom.field);
    return target ? attributePredicate(target, presence(target)) : null;
  }
  if (atom.field === 'record') return recordTermToSql(token, token.raw.slice((token.valueStart ?? token.start) - token.start));
  const t = targetFor(atom.field);
  if (!t) return null;
  const { value } = atom;
  switch (value.kind) {
    case 'value':
      return attributePredicate(t, memberSql(t, value.token));
    case 'compare':
      if (value.token.kind === 'regex' || value.token.wildcard) return null;
      return comparison(t, SQL_OPS[value.op] ?? '>', value.token.value);
    case 'range': {
      const { lower, upper } = value;
      if (lower.kind === 'regex' || upper.kind === 'regex') return null;
      // Each bound as the server compiles it: open for an unescaped star, otherwise compared on its own.
      const openLower = lower.wildcard && lower.value === '*';
      const openUpper = upper.wildcard && upper.value === '*';
      if (openLower && openUpper) return attributePredicate(t, presence(t));
      const parts = [
        openLower ? '' : comparison(t, value.open === '[' ? '>=' : '>', lower.value),
        openUpper ? '' : comparison(t, value.close === ']' ? '<=' : '<', upper.value),
      ];
      if (parts.includes(null)) return null;
      return parts.filter(Boolean).join(' AND ');
    }
    case 'group': {
      const { members } = value;
      const plain = members.every((m) => m.kind === 'value' && !m.wildcard);
      if (plain && t.type === 'array') return `hasAny(${t.ref}, [${members.map((m) => sqlString(m.value)).join(', ')}])`;
      if (plain && (t.type === 'string' || t.type === 'attr'))
        return attributePredicate(t, `${t.ref} IN (${members.map((m) => sqlString(m.value)).join(', ')})`);
      // Otherwise the server ORs one predicate per member.
      const each = members.map((m) => memberSql(t, m));
      return each.every(Boolean) ? attributePredicate(t, `(${each.join(' OR ')})`) : null;
    }
    default:
      return null;
  }
}

/**
 * The server's parse of `q` as field atoms keyed by where each ends, or null when the server would refuse the query, it
 * holds free text (never translated), or it exceeds the compiler's 64-term limit.
 */
function serverFieldAtoms(q: string): Map<number, FieldAtom> | null {
  let expression: QueryExpression;
  try {
    expression = parseQueryExpression(q);
  } catch (error) {
    if (error instanceof QueryError) return null;
    throw error;
  }
  const atoms = new Map<number, FieldAtom>();
  let terms = 0;
  let text = false;
  const visit = (node: QueryAtom) => {
    if (node.kind === 'not') visit(node.operand);
    else if (node.kind === 'group') for (const branch of node.expression) for (const part of branch) visit(part.atom);
    else if (node.kind === 'text') text = true;
    else {
      atoms.set(node.end, node);
      terms += node.value.kind === 'group' ? node.value.members.length : 1;
    }
  };
  for (const branch of expression) for (const part of branch) visit(part.atom);
  return text || terms > 64 ? null : atoms;
}

/**
 * Translate a query-language filter to a SQL WHERE expression, or null when it contains anything
 * without a faithful equivalent. Empty input translates to ''.
 */
export function translateQueryToSql(q: string): string | null {
  if (!q.trim()) return '';
  // The server's parse decides what each field term is; the console's tokens only carry the Boolean structure, and they
  // must name exactly the same field terms over exactly the same text, or nothing is translated.
  const atoms = serverFieldAtoms(q);
  if (!atoms) return null;
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
    const atom = atoms.get(tok.end);
    if (!atom || (atom.value.kind === 'presence' ? tok.field !== '_exists_' : atom.field !== tok.field)) return null;
    atoms.delete(tok.end);
    const sql = termToSql(tok, atom);
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
  if (!needsAnd || depth !== 0 || atoms.size > 0) return null;
  return out.map((part, i) => (i === 0 || part === ')' || out[i - 1]?.endsWith('(') ? part : ` ${part}`)).join('');
}
