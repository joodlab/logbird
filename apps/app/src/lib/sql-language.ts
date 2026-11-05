/**
 * Client-side model of SQL mode (docs/SPEC.md §5.1.2): a ClickHouse boolean WHERE expression.
 *
 * The server validates the expression with EXPLAIN AST; the console only tokenizes it to highlight
 * allowed vs unknown identifiers/functions, drive autocomplete and append predicates from facets.
 */
import { isAllowedFunction, isSqlColumn } from './query-catalog';
import type { Segment } from './query-language';

export type SqlTokenKind =
  | 'space'
  | 'string'
  | 'number'
  | 'ident'
  | 'quotedIdent'
  | 'function'
  | 'keyword'
  | 'operator'
  | 'punct'
  | 'comment'
  | 'other';

export interface SqlToken {
  kind: SqlTokenKind;
  raw: string;
  start: number;
  end: number;
  /** Strings / comments / quoted identifiers: the closing delimiter is present. */
  closed?: boolean;
  /** Identifiers: allowed column or lambda parameter. Functions: in the allowlist. Keywords: not a forbidden clause. */
  allowed?: boolean;
}

const KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'TRUE',
  'FALSE',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'INTERVAL',
  'SECOND',
  'MINUTE',
  'HOUR',
  'DAY',
  'WEEK',
  'MONTH',
  'YEAR',
  'AS',
  'GLOBAL',
  'XOR',
]);
/** Clauses that can never appear in a WHERE expression here (the server rejects them too). */
const FORBIDDEN = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'UNION',
  'WITH',
  'SETTINGS',
  'FORMAT',
  'JOIN',
  'LIMIT',
  'INTO',
  'INSERT',
  'ARRAY',
  'PREWHERE',
  'HAVING',
  'GROUP',
  'ORDER',
]);

const OPERATORS = ['>=', '<=', '!=', '<>', '==', '->', '||', '=', '<', '>', '+', '-', '*', '/', '%', '?', ':'];

function scanQuoted(input: string, i: number, q: string): { end: number; closed: boolean } {
  let j = i + 1;
  while (j < input.length) {
    const ch = input[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === q) {
      if (input[j + 1] === q) {
        j += 2;
        continue;
      }
      return { end: j + 1, closed: true };
    }
    j += 1;
  }
  return { end: input.length, closed: false };
}

/** Tokenize a SQL expression losslessly and annotate identifiers / functions. */
export function tokenizeSql(input: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);
    const ch = rest[0] ?? '';
    const space = /^\s+/.exec(rest);
    if (space) {
      tokens.push({ kind: 'space', raw: space[0], start: i, end: i + space[0].length });
      i += space[0].length;
      continue;
    }
    if (rest.startsWith('--')) {
      const nl = rest.indexOf('\n');
      const end = nl === -1 ? input.length : i + nl;
      tokens.push({ kind: 'comment', raw: input.slice(i, end), start: i, end, closed: true });
      i = end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = rest.indexOf('*/', 2);
      const end = close === -1 ? input.length : i + close + 2;
      tokens.push({ kind: 'comment', raw: input.slice(i, end), start: i, end, closed: close !== -1 });
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const { end, closed } = scanQuoted(input, i, ch);
      tokens.push({ kind: ch === "'" ? 'string' : 'quotedIdent', raw: input.slice(i, end), start: i, end, closed });
      i = end;
      continue;
    }
    const num = /^(0x[\da-f]+|\d+(\.\d*)?([e][+-]?\d+)?|\.\d+)/i.exec(rest);
    if (num) {
      tokens.push({ kind: 'number', raw: num[0], start: i, end: i + num[0].length });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][\w$]*/.exec(rest);
    if (word) {
      const raw = word[0];
      const upper = raw.toUpperCase();
      const next = /^\s*(.)/.exec(input.slice(i + raw.length))?.[1];
      let kind: SqlTokenKind = 'ident';
      if (next === '(' && !KEYWORDS.has(upper)) kind = 'function';
      else if (KEYWORDS.has(upper) || FORBIDDEN.has(upper)) kind = 'keyword';
      tokens.push({ kind, raw, start: i, end: i + raw.length });
      i += raw.length;
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (op) {
      tokens.push({ kind: 'operator', raw: op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }
    tokens.push({ kind: '()[],.'.includes(ch) ? 'punct' : 'other', raw: ch, start: i, end: i + 1 });
    i += 1;
  }
  annotate(tokens);
  return tokens;
}

function annotate(tokens: SqlToken[]) {
  const solid = tokens.filter((t) => t.kind !== 'space');
  // Lambda parameters: `x -> …` and `(x, y) -> …`.
  const lambdaParams = new Set<string>();
  solid.forEach((t, i) => {
    if (t.raw !== '->') return;
    const prev = solid[i - 1];
    if (prev?.kind === 'ident') lambdaParams.add(prev.raw);
    if (prev?.raw === ')') {
      for (let j = i - 2; j >= 0 && solid[j]?.raw !== '('; j -= 1) {
        const p = solid[j];
        if (p?.kind === 'ident') lambdaParams.add(p.raw);
      }
    }
  });
  solid.forEach((t, i) => {
    if (t.kind === 'ident') {
      const prev = solid[i - 1];
      // `CAST(x AS String)` / `INTERVAL 1 DAY`: type names after AS are not columns.
      const typeName = prev?.kind === 'keyword' && prev.raw.toUpperCase() === 'AS';
      t.allowed = typeName || isSqlColumn(t.raw) || lambdaParams.has(t.raw);
    } else if (t.kind === 'function') {
      t.allowed = isAllowedFunction(t.raw);
    } else if (t.kind === 'keyword') {
      t.allowed = !FORBIDDEN.has(t.raw.toUpperCase());
    } else if (t.kind === 'comment' || t.kind === 'other' || t.kind === 'quotedIdent') {
      t.allowed = false;
    }
  });
}

/** Highlight segments for a SQL expression. Segments cover the input exactly, in order. */
export function highlightSql(input: string): Segment[] {
  return tokenizeSql(input).map((t): Segment => {
    switch (t.kind) {
      case 'string':
        return { start: t.start, end: t.end, cls: 'string' };
      case 'number':
        return { start: t.start, end: t.end, cls: 'number' };
      case 'ident':
        return { start: t.start, end: t.end, cls: t.allowed ? 'ident' : 'unknown' };
      case 'function':
        return { start: t.start, end: t.end, cls: t.allowed ? 'function' : 'unknown' };
      case 'keyword':
        return { start: t.start, end: t.end, cls: t.allowed ? 'keyword' : 'unknown' };
      case 'operator':
        return { start: t.start, end: t.end, cls: 'operator' };
      case 'punct':
        return { start: t.start, end: t.end, cls: 'punct' };
      case 'comment':
        return { start: t.start, end: t.end, cls: 'comment' };
      case 'quotedIdent':
      case 'other':
        return { start: t.start, end: t.end, cls: 'unknown' };
      default:
        return { start: t.start, end: t.end, cls: 'plain' };
    }
  });
}

/* ------------------------------------------------------------------ */
/* Autocomplete context                                                */
/* ------------------------------------------------------------------ */

export type SqlCompletion =
  /** Column, function or keyword. Replace [from, to). */
  | { kind: 'ident'; prefix: string; from: number; to: number }
  /** Inside `attributes['…`. Replace [from, to) with `key` + the closers that are missing. */
  | { kind: 'attrKey'; prefix: string; from: number; to: number; closeQuote: boolean; closeBracket: boolean }
  /**
   * Inside a string literal compared with a column (`actor_name = 'Ra…`, `outcome IN ('…`, `has(target_types, '…`).
   * `field` is the query-language key for /suggest (`actor.name`, `attr.metadata.plan`).
   */
  | { kind: 'value'; field: string; column: string; prefix: string; from: number; to: number; closeQuote: boolean }
  | { kind: 'none' };

function unquoteSql(raw: string): string {
  return raw.replace(/\\(.)/g, '$1').replaceAll("''", "'");
}

/** The column (or `attributes['k']`) a string literal at solid index `i` is compared with, if any. */
function comparedColumn(solid: SqlToken[], i: number): { column: string; attr?: string } | undefined {
  const at = (k: number) => solid[k];
  const columnEndingAt = (k: number): { column: string; attr?: string } | undefined => {
    const t = at(k);
    if (t?.kind === 'ident' && t.allowed) return { column: t.raw };
    // attributes['key']
    if (t?.raw === ']' && at(k - 1)?.kind === 'string' && at(k - 2)?.raw === '[' && at(k - 3)?.raw === 'attributes') {
      return { column: 'attributes', attr: unquoteSql((at(k - 1)?.raw ?? '').slice(1, -1)) };
    }
    return undefined;
  };
  const prev = at(i - 1);
  if (!prev) return undefined;
  const p = prev.raw.toUpperCase();
  if (['=', '==', '!=', '<>'].includes(p) || p === 'LIKE' || p === 'ILIKE') {
    const before = at(i - 2)?.raw.toUpperCase() === 'NOT' ? i - 3 : i - 2;
    return columnEndingAt(before);
  }
  // has(col, '…') / startsWith(col, '…') / endsWith(col, '…')
  if (p === ',' && at(i - 3)?.raw === '(' && ['has', 'startsWith', 'endsWith'].includes(at(i - 4)?.raw ?? '')) return columnEndingAt(i - 2);
  // col IN ('a', '…')
  if (p === '(' || p === ',') {
    let k = i - 1;
    while (k >= 0 && at(k)?.raw !== '(') k -= 1;
    const kw = at(k - 1)?.raw.toUpperCase();
    if (kw === 'IN') return columnEndingAt(at(k - 2)?.raw.toUpperCase() === 'NOT' ? k - 3 : k - 2);
  }
  return undefined;
}

/** What the caret is completing in SQL mode. Pure; drives the suggestion list. */
export function sqlCompletionAt(q: string, caret: number, suggestFieldFor: (column: string) => string | undefined): SqlCompletion {
  const tokens = tokenizeSql(q);
  const solid = tokens.filter((t) => t.kind !== 'space');
  const index = solid.findIndex((t) => caret > t.start && (caret < t.end || (caret === t.end && !(t.kind === 'string' && t.closed))));
  const t = index >= 0 ? solid[index] : undefined;
  if (!t) {
    // Right after a word: keep completing it.
    const before = solid.find((x) => x.end === caret);
    if (before && (before.kind === 'ident' || before.kind === 'function' || before.kind === 'keyword')) {
      return { kind: 'ident', prefix: before.raw, from: before.start, to: before.end };
    }
    const last = [...solid].reverse().find((x) => x.end <= caret);
    if (last && (last.kind === 'number' || last.kind === 'string' || last.kind === 'comment' || COMPARISONS.has(last.raw))) return { kind: 'none' };
    return { kind: 'ident', prefix: '', from: caret, to: caret };
  }
  if (t.kind === 'ident' || t.kind === 'function' || t.kind === 'keyword') {
    return { kind: 'ident', prefix: q.slice(t.start, caret), from: t.start, to: t.end };
  }
  if (t.kind === 'string') {
    const prefix = unquoteSql(q.slice(t.start + 1, caret));
    const from = t.start + 1;
    const to = t.closed ? t.end - 1 : t.end;
    const prev = solid[index - 1];
    if (prev?.raw === '[' && solid[index - 2]?.raw === 'attributes') {
      return { kind: 'attrKey', prefix, from, to, closeQuote: !t.closed, closeBracket: solid[index + 1]?.raw !== ']' };
    }
    const target = comparedColumn(solid, index);
    if (target) {
      const field = target.attr !== undefined ? `attr.${target.attr}` : suggestFieldFor(target.column);
      if (field) return { kind: 'value', field, column: target.column, prefix, from, to, closeQuote: !t.closed };
    }
    return { kind: 'none' };
  }
  if ((t.kind === 'operator' && !COMPARISONS.has(t.raw)) || t.kind === 'punct') return { kind: 'ident', prefix: '', from: caret, to: caret };
  return { kind: 'none' };
}

/** After these a value (not a column) usually follows, so the column list stays closed. */
const COMPARISONS = new Set(['=', '==', '!=', '<>', '<', '>', '<=', '>=']);

/* ------------------------------------------------------------------ */
/* Predicates (facets, "filter by this value")                         */
/* ------------------------------------------------------------------ */

/** ClickHouse single-quoted string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/[\\']/g, '\\$&')}'`;
}

/**
 * Top-level `AND` conjuncts of an expression. An expression with a top-level `OR` (or a single
 * predicate) is one conjunct; parenthesised groups stay whole.
 */
export function sqlConjuncts(q: string): string[] {
  const tokens = tokenizeSql(q);
  let depth = 0;
  const cuts: { start: number; end: number }[] = [];
  let hasOr = false;
  let between = false;
  for (const t of tokens) {
    if (t.raw === '(' || t.raw === '[') depth += 1;
    else if (t.raw === ')' || t.raw === ']') depth -= 1;
    else if (depth === 0 && t.kind === 'keyword') {
      const kw = t.raw.toUpperCase();
      if (kw === 'BETWEEN') between = true;
      else if (kw === 'OR') hasOr = true;
      else if (kw === 'AND') {
        if (between) between = false;
        else cuts.push({ start: t.start, end: t.end });
      }
    }
  }
  if (!q.trim()) return [];
  if (hasOr || cuts.length === 0) return [q.trim()];
  const parts: string[] = [];
  let from = 0;
  for (const c of cuts) {
    parts.push(q.slice(from, c.start).trim());
    from = c.end;
  }
  parts.push(q.slice(from).trim());
  return parts.filter(Boolean);
}

function joinConjuncts(original: string, parts: string[]): string {
  const hasTopLevelOr =
    sqlConjuncts(original).length === 1 && tokenizeSql(original).some((t) => t.kind === 'keyword' && t.raw.toUpperCase() === 'OR');
  if (hasTopLevelOr && parts.length > 1 && parts[0] === original.trim()) parts[0] = `(${parts[0]})`;
  return parts.join(' AND ');
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

export function hasSqlPredicate(q: string, predicate: string): boolean {
  const p = normalize(predicate);
  return sqlConjuncts(q).some((c) => normalize(c) === p);
}

/** Append `predicate` with AND, parenthesising an existing top-level OR so precedence stays intact. */
export function appendSqlPredicate(q: string, predicate: string): string {
  if (!q.trim()) return predicate;
  if (hasSqlPredicate(q, predicate)) return q.trim();
  return joinConjuncts(q, [...sqlConjuncts(q), predicate]);
}

/** Remove conjuncts matching `test`. */
export function removeSqlConjuncts(q: string, test: (conjunct: string) => boolean): string {
  const parts = sqlConjuncts(q);
  const kept = parts.filter((c) => !test(normalize(c)));
  return kept.length === parts.length ? q.trim() : kept.join(' AND ');
}

/** Equality / membership predicates for one column, as facets write them. */
function columnPredicatePrefixes(column: string, attr?: string): string[] {
  const ref = attr !== undefined ? `attributes[${sqlString(attr)}]` : column;
  return [`${ref} = '`, `${ref} != '`, `has(${ref}, '`, `NOT has(${ref}, '`];
}

export function isColumnPredicate(conjunct: string, column: string, attr?: string): boolean {
  return columnPredicatePrefixes(column, attr).some((p) => conjunct.startsWith(p) && /'\)?$/.test(conjunct));
}

/** Facet toggle in SQL mode: include replaces this column's other equality predicates, exclude stacks. */
export function toggleSqlPredicate(q: string, predicate: string, column: string, mode: 'include' | 'exclude', attr?: string): string {
  if (hasSqlPredicate(q, predicate)) return removeSqlConjuncts(q, (c) => c === normalize(predicate));
  if (mode === 'include') {
    const ref = attr !== undefined ? `attributes[${sqlString(attr)}]` : column;
    const cleaned = removeSqlConjuncts(q, (c) => (c.startsWith(`${ref} = '`) || c.startsWith(`has(${ref}, '`)) && /'\)?$/.test(c));
    return appendSqlPredicate(cleaned, predicate);
  }
  return appendSqlPredicate(q, predicate);
}
