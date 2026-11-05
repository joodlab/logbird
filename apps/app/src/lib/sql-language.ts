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
  /**
   * Column, function or keyword. Replace [from, to). `after` says what precedes the word: a column (comparison
   * operators come next) or a complete operand (AND / OR come next).
   */
  | { kind: 'ident'; prefix: string; from: number; to: number; after?: 'column' | 'operand'; column?: string }
  /** Inside `attributes['…`. Replace [from, to) with `key` + the closers that are missing. */
  | { kind: 'attrKey'; prefix: string; from: number; to: number; closeQuote: boolean; closeBracket: boolean }
  /**
   * A string value compared with a column (`actor_name = 'Ra…`, `outcome IN ('…`, `has(target_types, '…`).
   * `field` is the query-language key for /suggest (`actor.name`, `attr.metadata.plan`). `openQuote`: no quote
   * typed yet (`actor_name = |`), so the value is inserted as a whole literal.
   */
  | { kind: 'value'; field: string; column: string; prefix: string; from: number; to: number; closeQuote: boolean; openQuote?: boolean }
  /** After a comparison on a column without value suggestions (`job_attempt > |`): the hint row explains. */
  | { kind: 'operand'; column: string }
  | { kind: 'none' };

function unquoteSql(raw: string): string {
  return raw.replace(/\\(.)/g, '$1').replaceAll("''", "'");
}

/** A column reference ending at solid index `k`: an allowed identifier or `attributes['key']`. */
function columnEndingAt(solid: SqlToken[], k: number): { column: string; attr?: string } | undefined {
  const t = solid[k];
  if (t?.kind === 'ident' && t.allowed) return { column: t.raw };
  if (t?.raw === ']' && solid[k - 1]?.kind === 'string' && solid[k - 2]?.raw === '[' && solid[k - 3]?.raw === 'attributes') {
    return { column: 'attributes', attr: unquoteSql((solid[k - 1]?.raw ?? '').slice(1, -1)) };
  }
  return undefined;
}

const columnLabel = (c: { column: string; attr?: string }) => (c.attr !== undefined ? `attributes['${c.attr}']` : c.column);

/** The column (or `attributes['k']`) a string literal at solid index `i` is compared with, if any. */
function comparedColumn(solid: SqlToken[], i: number): { column: string; attr?: string } | undefined {
  const at = (k: number) => solid[k];
  const prev = at(i - 1);
  if (!prev) return undefined;
  const p = prev.raw.toUpperCase();
  if (COMPARISONS.has(p) || p === 'LIKE' || p === 'ILIKE') {
    const before = at(i - 2)?.raw.toUpperCase() === 'NOT' ? i - 3 : i - 2;
    return columnEndingAt(solid, before);
  }
  // has(col, '…') / startsWith(col, '…') / endsWith(col, '…')
  if (p === ',' && at(i - 3)?.raw === '(' && ['has', 'startsWith', 'endsWith'].includes(at(i - 4)?.raw ?? '')) return columnEndingAt(solid, i - 2);
  // col IN ('a', '…')
  if (p === '(' || p === ',') {
    let k = i - 1;
    while (k >= 0 && at(k)?.raw !== '(') k -= 1;
    const kw = at(k - 1)?.raw.toUpperCase();
    if (kw === 'IN') return columnEndingAt(solid, at(k - 2)?.raw.toUpperCase() === 'NOT' ? k - 3 : k - 2);
  }
  return undefined;
}

/** After these a value (not a column) usually follows, so the column list stays closed. */
const COMPARISONS = new Set(['=', '==', '!=', '<>', '<', '>', '<=', '>=']);

/** What the caret is completing in SQL mode. Pure; drives the suggestion list and the hint row. */
export function sqlCompletionAt(q: string, caret: number, suggestFieldFor: (column: string) => string | undefined): SqlCompletion {
  const tokens = tokenizeSql(q);
  const solid = tokens.filter((t) => t.kind !== 'space');
  // A token *ending* at the caret is still being typed, except closed strings and punctuation/operators (`IN (|`).
  const typing = (t: SqlToken) => !(t.kind === 'string' && t.closed) && t.kind !== 'punct' && t.kind !== 'operator';
  const index = solid.findIndex((t) => caret > t.start && (caret < t.end || (caret === t.end && typing(t))));
  const t = index >= 0 ? solid[index] : undefined;
  const fieldFor = (target: { column: string; attr?: string }) =>
    target.attr !== undefined ? `attr.${target.attr}` : suggestFieldFor(target.column);
  /** What precedes solid index `i`: a column, or a finished operand (literal, `)`, NULL/TRUE/FALSE). */
  const afterAt = (i: number): { after?: 'column' | 'operand'; column?: string } => {
    const prev = solid[i - 1];
    if (!prev) return {};
    const column = columnEndingAt(solid, i - 1);
    if (column) return { after: 'column', column: columnLabel(column) };
    // Literals, and keywords that end an operand (`IS NULL`, `INTERVAL 7 DAY`).
    const literal =
      prev.kind === 'number' ||
      (prev.kind === 'string' && prev.closed) ||
      (prev.kind === 'keyword' && /^(NULL|TRUE|FALSE|SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)$/i.test(prev.raw));
    if (literal || prev.raw === ')') return { after: 'operand' };
    return {};
  };
  if (!t) {
    // Right after a word: keep completing it.
    const before = solid.find((x) => x.end === caret);
    if (before && (before.kind === 'ident' || before.kind === 'function' || before.kind === 'keyword')) {
      return { kind: 'ident', prefix: before.raw, from: before.start, to: before.end, ...afterAt(solid.indexOf(before)) };
    }
    const next = solid.filter((x) => x.end <= caret).length;
    const last = solid[next - 1];
    if (last && (last.kind === 'comment' || (last.kind === 'string' && !last.closed))) return { kind: 'none' };
    // A value is expected next (`actor_name = |`, `outcome IN (|`, `has(target_types, |`): offer whole literals.
    const expectsValue = last && (COMPARISONS.has(last.raw) || /^(LIKE|ILIKE)$/i.test(last.raw) || last.raw === '(' || last.raw === ',');
    const target = expectsValue ? comparedColumn(solid, next) : undefined;
    if (target) {
      const field = fieldFor(target);
      if (field) return { kind: 'value', field, column: target.column, prefix: '', from: caret, to: caret, closeQuote: true, openQuote: true };
    }
    if (last && COMPARISONS.has(last.raw)) {
      const column = columnEndingAt(solid, next - 2);
      return column ? { kind: 'operand', column: columnLabel(column) } : { kind: 'none' };
    }
    // Directly after a literal (no space yet), wait: `2` may become `25`, and `'x'` is followed by a space.
    if (last && last.end === caret && (last.kind === 'number' || last.kind === 'string')) return { kind: 'none' };
    return { kind: 'ident', prefix: '', from: caret, to: caret, ...afterAt(next) };
  }
  if (t.kind === 'ident' || t.kind === 'function' || t.kind === 'keyword') {
    const prefix = q.slice(t.start, caret);
    // A bare word where a value belongs (`actor_name = rawd|`): search values, insert a quoted literal.
    if (t.kind === 'ident' && !t.allowed) {
      const target = comparedColumn(solid, index);
      const field = target ? fieldFor(target) : undefined;
      if (target && field)
        return { kind: 'value', field, column: target.column, prefix, from: t.start, to: t.end, closeQuote: true, openQuote: true };
    }
    return { kind: 'ident', prefix, from: t.start, to: t.end, ...afterAt(index) };
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
      const field = fieldFor(target);
      if (field) return { kind: 'value', field, column: target.column, prefix, from, to, closeQuote: !t.closed };
    }
    return { kind: 'none' };
  }
  if ((t.kind === 'operator' && !COMPARISONS.has(t.raw)) || t.kind === 'punct') return { kind: 'ident', prefix: '', from: caret, to: caret };
  return { kind: 'none' };
}

/**
 * The innermost function call around the caret and which argument the caret is in (signature help):
 * `has(target_types, '|` → { name: 'has', arg: 1 }. Brackets that are not calls (`[…]`, `IN (…)`) are skipped.
 */
export function sqlCallAt(q: string, caret: number): { name: string; arg: number } | null {
  const frames: { name: string | null; arg: number }[] = [];
  let prev: SqlToken | undefined;
  for (const t of tokenizeSql(q)) {
    if (t.start >= caret) break;
    if (t.kind === 'space') continue;
    if (t.raw === '(' || t.raw === '[') frames.push({ name: t.raw === '(' && prev?.kind === 'function' ? prev.raw : null, arg: 0 });
    else if (t.raw === ')' || t.raw === ']') frames.pop();
    else if (t.raw === ',' && frames.length) (frames.at(-1) as { arg: number }).arg += 1;
    prev = t;
  }
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const f = frames[i];
    if (f?.name) return { name: f.name, arg: f.arg };
  }
  return null;
}

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

/** `(…)` around the whole expression, with the outer parentheses matching each other. */
function isWrapped(q: string): boolean {
  const solid = tokenizeSql(q.trim()).filter((t) => t.kind !== 'space');
  if (solid[0]?.raw !== '(' || solid.at(-1)?.raw !== ')') return false;
  let depth = 0;
  for (const [i, t] of solid.entries()) {
    if (t.raw === '(') depth += 1;
    else if (t.raw === ')') depth -= 1;
    if (depth === 0 && i < solid.length - 1) return false;
  }
  return true;
}

function hasTopLevelOr(q: string): boolean {
  let depth = 0;
  for (const t of tokenizeSql(q)) {
    if (t.raw === '(' || t.raw === '[') depth += 1;
    else if (t.raw === ')' || t.raw === ']') depth -= 1;
    else if (depth === 0 && t.kind === 'keyword' && t.raw.toUpperCase() === 'OR') return true;
  }
  return false;
}

/** Join conjuncts with AND, parenthesising a part with a top-level OR so precedence stays intact. */
function joinConjuncts(parts: string[]): string {
  if (parts.length === 1) {
    const only = parts[0] ?? '';
    return isWrapped(only) ? only.trim().slice(1, -1).trim() : only;
  }
  return parts.map((p) => (hasTopLevelOr(p) && !isWrapped(p) ? `(${p})` : p)).join(' AND ');
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
  return joinConjuncts([...sqlConjuncts(q), predicate]);
}

/** Remove conjuncts matching `test`. */
export function removeSqlConjuncts(q: string, test: (conjunct: string) => boolean): string {
  const parts = sqlConjuncts(q);
  const kept = parts.filter((c) => !test(normalize(c)));
  return kept.length === parts.length ? q.trim() : joinConjuncts(kept);
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
