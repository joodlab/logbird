/**
 * Client-side model of the Logbird query language (docs/SPEC.md §5.1 + §5.1.1 v2).
 *
 * The server owns parsing → SQL. The console only needs a *lossless* tokenizer to highlight the
 * query bar, drive autocomplete, and add/remove filter terms from facets, charts and entity pages
 * without destroying what the user typed.
 */
import {
  parseQueryExpression,
  type QueryAtom,
  QueryError,
  type QueryExpression,
  quoteQueryValue,
  readQueryValue,
  scanBareRecordValue,
} from '@logbird/contracts';
import { attributeKey, coreField } from './query-catalog';

export type TokenKind = 'field' | 'text' | 'phrase' | 'regex' | 'operator' | 'paren' | 'space';
/** Shape of a field term's value (v2). */
export type ValueKind = 'plain' | 'quoted' | 'regex' | 'range' | 'compare' | 'group';

export interface QueryToken {
  kind: TokenKind;
  /** Raw source slice, including a leading `-` and quotes. */
  raw: string;
  start: number;
  end: number;
  negated: boolean;
  /** For `field` tokens. */
  field?: string;
  /** Unquoted value for `field` / `phrase` / `text` tokens (comparison values exclude the operator). */
  value?: string;
  /** The final star is a wildcard in this simple value. */
  wildcard?: boolean;
  valueKind?: ValueKind;
  /** Offset of the first value character (after `:`) for `field` tokens. */
  valueStart?: number;
  /** `>`, `>=`, `<`, `<=` for comparisons. */
  op?: string;
  /** End of the field name as written, after any quotes (`field` is the decoded name) and before the `:`. */
  keyEnd?: number;
  /**
   * Inside a negated group that ANDs terms (`NOT (a b)`): the term has no polarity of its own in the whole query, so
   * `negated` says nothing there. Removing every term of a field still takes it; asking for one polarity never does.
   */
  unpolarized?: boolean;
}

const KEY_RE = /^(-?)([A-Za-z_][\w.$@-]*)\s*:/;
/** A field name that needs no quotes: the keys `KEY_RE` reads. */
const BARE_KEY = /^[A-Za-z_][\w.$@-]*$/;
/** A quoted field name, as the server reads one: `"attr.ticket status":open`. */
const QUOTED_KEY_RE = /^(-?)("(?:[^"\\]|\\[\s\S])*")\s*:/;
/**
 * A dash that cannot negate (it follows `)`) starts a bare word, as the server reads it: everything up to whitespace,
 * a bracket or `:`, quotes and slashes included. Followed by `:` that word is a field name (`-/a"b"category`).
 */
const LITERAL_DASH_RUN = /^-(?:(?!&&|\|\|)[^\s():[\]{}<>])*/;
const LITERAL_DASH_KEY_RE = /^(-)((?:(?!&&|\|\|)[^\s():[\]{}<>])*)\s*:/;
/** A bare word. A quote inside it is part of it, as the server reads a bare run (`tail"` never opens a phrase). */
const WORD_RE = /^(-?)([^\s()"][^\s()]*)/;
const OPERATORS = new Set(['OR', 'AND', 'NOT']);

/** End offset (exclusive) of a delimited run starting at `i` (`"…"`, `/…/`), honouring backslash escapes. */
function scanDelimited(input: string, i: number, close: string): number {
  let j = i + 1;
  while (j < input.length) {
    const ch = input[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    j += 1;
    if (ch === close) return j;
  }
  return input.length;
}

/** End of a `( … )` value group, respecting quotes and nesting. Unclosed groups run to the end. */
function scanGroup(input: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < input.length) {
    const ch = input[j];
    if (ch === '"' || (ch === '/' && /[\s(]/.test(input[j - 1] ?? ''))) {
      j = scanDelimited(input, j, ch);
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return input.length;
}

function scanPlain(input: string, i: number): number {
  let j = i;
  if (input[j] === '"') return scanDelimited(input, j, '"');
  while (j < input.length && !/[\s()]/.test(input[j] ?? '')) j += 1;
  return j;
}

/** End of a bare group member starting at `i` (stops at whitespace or a bracket), never past `limit`. */
/** As the server does: an adjacent `:` after a value joins the value right after it, quoted or bare (never a regex). */
function joinColons(input: string, from: number, limit: number): number {
  let j = from;
  while (j < limit && input[j] === ':') {
    j += 1;
    if (input[j] === '"') j = Math.min(limit, scanDelimited(input, j, '"'));
    else while (j < limit && !/[\s():[\]{}<>"/]/.test(input[j] ?? '')) j += 1;
  }
  return j;
}

/**
 * The server's terms of `q` outside `[from, to)`, in order, as field, value and polarity (offsets left out), or null
 * when `q` does not parse. Two queries whose outside terms match differ only in the span between.
 */
export function termsOutside(q: string, from: number, to: number): string | null {
  const parts: string[] = [];
  const strip = (key: string, v: unknown) => (key === 'start' || key === 'end' || key === 'valueStart' || key === 'key' ? undefined : v);
  const visit = (node: QueryAtom, negated: boolean) => {
    if (node.kind === 'not') return visit(node.operand, !negated);
    if (node.kind === 'group') {
      for (const branch of node.expression) for (const part of branch) visit(part.atom, negated);
      return;
    }
    if (node.start < to && node.end > from) return;
    parts.push(JSON.stringify([node.kind, node.kind === 'field' ? node.field : '', node.kind === 'field' ? node.value : node.token, negated], strip));
  };
  const expression = editableExpression(q);
  if (!expression) return null;
  for (const branch of expression) for (const part of branch) visit(part.atom, false);
  return `${expression.length}|${parts.join('|')}`;
}

/**
 * The query after inserting `insert` over `[from, to)`, as the reader will finish it: when it does not parse yet (a key
 * awaiting its value, `action:`; an empty group, `()`), with a placeholder value typed at the caret. Returns the text to
 * check and the span the completed term occupies in it.
 */
export function completedForCheck(q: string, from: number, to: number, insert: string, caretOffset = insert.length) {
  const text = q.slice(0, from) + insert + q.slice(to);
  if (editableExpression(text)) return { text, from, to: from + insert.length };
  const at = from + Math.min(caretOffset, insert.length);
  return { text: `${text.slice(0, at)}x${text.slice(at)}`, from, to: from + insert.length + 1 };
}

/**
 * What to insert so that accepting a completion changes only the term it completes: the insertion as built, else
 * without its trailing space, else quoted, whichever first leaves every other term of the server's parse unchanged (a
 * space before `-tenant:west` would turn the attribute `-tenant` into NOT tenant). Null when none does: the completion
 * is not applied. A query that does not parse yet takes the insertion as built.
 */
export function neighbourSafeInsert(q: string, from: number, to: number, insert: string, caretOffset = insert.length): string | null {
  const before = termsOutside(q, from, to);
  if (before === null) return insert;
  const bare = insert.trimEnd();
  const candidates = [insert, bare];
  if (bare && !bare.endsWith(':') && !/^["/(]/.test(bare)) candidates.push(quoteQueryValue(readQueryValue(bare).value));
  for (const candidate of candidates) {
    const check = completedForCheck(q, from, to, candidate, Math.min(caretOffset, candidate.length));
    if (termsOutside(check.text, check.from, check.to) === before) return candidate;
  }
  return null;
}

/** Value completion for the server's term `atom` at `caret`; null for `_exists_` (the console's own path handles it). */
function serverValueCompletion(q: string, caret: number, atom: Extract<QueryAtom, { kind: 'field' }>): QueryCompletion | null {
  const field = atom.field;
  const value = (prefix: string, from: number, to: number, extra: Partial<Extract<QueryCompletion, { kind: 'value' }>> = {}): QueryCompletion => ({
    kind: 'value',
    field,
    prefix,
    from,
    to,
    inGroup: false,
    quoted: false,
    ...extra,
  });
  const v = atom.value;
  // `_exists_:field`: the whole presence term, as the server reads it (never part of a neighbouring group).
  if (v.kind === 'presence') return { kind: 'exists', prefix: q.slice(atom.valueStart, caret), from: atom.start, to: atom.end };
  if (v.kind === 'range') return caret <= atom.valueStart ? value('', atom.valueStart, atom.end) : { kind: 'range', field };
  if (v.kind === 'compare') {
    if (caret < atom.valueStart + v.op.length) return value('', atom.valueStart, atom.end);
    if (v.token.kind === 'regex') return { kind: 'regex', field };
    return value(q.slice(v.token.start, caret), v.token.start, v.token.end, { op: v.op });
  }
  const inGroup = v.kind === 'group';
  const members = v.kind === 'value' ? [v.token] : v.members;
  // Between the colon and the value (`action:| booked`): the whole value is what a completion replaces.
  if (caret <= atom.valueStart) return value('', atom.valueStart, atom.end);
  const member = members.find((m) => caret >= m.start && caret <= m.end);
  if (!member) {
    if (!inGroup) return { kind: 'none' };
    // On the group's own `OR`: nothing to complete.
    const around = (/\S*$/.exec(q.slice(atom.valueStart, caret))?.[0] ?? '') + (/^\S*/.exec(q.slice(caret))?.[0] ?? '');
    if (around === 'OR') return { kind: 'none' };
    const before = q.slice(atom.valueStart + 1, caret).trimEnd();
    return value('', caret, caret, { inGroup, afterMember: before.length > 0 && !/(^|\s)OR$/.test(before) });
  }
  if (member.kind === 'regex') return caret > member.start ? { kind: 'regex', field } : value('', member.start, member.end);
  const quoted = q[member.start] === '"';
  const prefix = readJoinedValue(q.slice(member.start, caret)).value;
  const before = q.slice(atom.valueStart + 1, member.start).trimEnd();
  const afterMember = inGroup && before.length > 0 && !/(^|\s)OR$/.test(before);
  return value(prefix, member.start, member.end, { quoted, ...(inGroup ? { inGroup, afterMember } : {}) });
}

/** The server's field term whose text holds `caret` (key or value), when the query parses. */
function serverFieldContaining(q: string, caret: number): Extract<QueryAtom, { kind: 'field' }> | undefined {
  let found: Extract<QueryAtom, { kind: 'field' }> | undefined;
  const visit = (node: QueryAtom) => {
    if (found) return;
    if (node.kind === 'not') visit(node.operand);
    else if (node.kind === 'group') for (const branch of node.expression) for (const part of branch) visit(part.atom);
    else if (node.kind === 'field' && caret > node.start && caret <= node.end) found = node;
  };
  for (const branch of editableExpression(q) ?? []) for (const part of branch) visit(part.atom);
  return found;
}

/** The decoded value of a quoted value joined with colon parts (`"auth":other` is `auth:other` to the server). */
function readJoinedValue(raw: string): { value: string; wildcard: boolean } {
  let value = '';
  let wildcard = false;
  for (let i = 0; i < raw.length; ) {
    // A bare part runs to the next colon with any quote inside it, as the server's bare run does (`ab"cd` is ab"cd).
    const end = raw[i] === '"' ? scanDelimited(raw, i, '"') : i + (/^[^:]*/.exec(raw.slice(i))?.[0].length ?? 0);
    const part = readQueryValue(raw.slice(i, end));
    value += part.value;
    wildcard = part.wildcard;
    if (raw[end] === ':') value += ':';
    i = end === i ? i + 1 : end + (raw[end] === ':' ? 1 : 0);
  }
  return { value, wildcard };
}

function scanPlainMember(input: string, i: number, limit: number, record = false): number {
  let j: number;
  if (input[i] === '/' && !record) j = Math.min(limit, scanDelimited(input, i, '/'));
  else if (input[i] === '"') j = Math.min(limit, scanDelimited(input, i, '"'));
  else if (record) j = Math.min(limit, scanBareRecordValue(input, i));
  else {
    j = i;
    while (j < limit && !/[\s():[\]{}<>]/.test(input[j] ?? '')) j += 1;
  }
  // A record member never joins; a regex member never does either.
  if (!record && input[i] !== '/') j = joinColons(input, j, limit);
  // Always at least one character, so a stray `[` or `<` can never stall the caller's loop.
  return Math.max(i + 1, j);
}

function skipWhitespace(input: string, start: number): number {
  let i = start;
  while (i < input.length && /\s/.test(input[i] ?? '')) i += 1;
  return i;
}

/** Lex the value after `key:` starting at `i`. */
function scanValue(input: string, i: number, record: boolean): { end: number; kind: ValueKind; op?: string } {
  const ch = input[i];
  if (ch === '"') return { end: scanDelimited(input, i, '"'), kind: 'quoted' };
  if (ch === '/') return { end: scanDelimited(input, i, '/'), kind: 'regex' };
  if (ch === '[' || ch === '{') {
    const close = /[\]}]/.exec(input.slice(i + 1));
    return { end: close ? i + 1 + close.index + 1 : input.length, kind: 'range' };
  }
  if (ch === '(') return { end: scanGroup(input, i), kind: 'group' };
  const op = /^(>=|<=|>|<)/.exec(input.slice(i))?.[0];
  if (op) return { end: scanPlain(input, skipWhitespace(input, i + op.length)), kind: 'compare', op };
  return { end: record ? scanBareRecordValue(input, i) : scanPlain(input, i), kind: 'plain' };
}

/** Tokenize a query. Concatenating every token's `raw` reproduces the input exactly. */
export function tokenize(input: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      tokens.push({ kind: 'space', raw: space[0], start: i, end: i + space[0].length, negated: false });
      i += space[0].length;
      continue;
    }
    const ch = rest[0] ?? '';
    // As in the server's parser, `-` negates only at the start, after whitespace or after `(`. Anywhere else (right
    // after `)`, say) it is part of the word: `(a:b)-action:x` is the attribute `-action`, not NOT action.
    const negatable = i === 0 || /[\s(]/.test(input[i - 1] ?? '');
    if (ch === '(' || ch === ')' || (ch === '-' && rest[1] === '(' && negatable)) {
      const raw = ch === '-' ? '-(' : ch;
      tokens.push({ kind: 'paren', raw, start: i, end: i + raw.length, negated: ch === '-' });
      i += raw.length;
      continue;
    }
    const quotedKey = QUOTED_KEY_RE.exec(rest);
    const key =
      KEY_RE.exec(rest) ?? (quotedKey && (negatable || !quotedKey[1]) ? quotedKey : null) ?? (negatable ? null : LITERAL_DASH_KEY_RE.exec(rest));
    if (key) {
      const negated = key[1] === '-' && negatable;
      const name = key === quotedKey ? readQueryValue(key[2] ?? '').value : (key[2] ?? '');
      const field = negated || key[1] !== '-' ? name : `-${name}`;
      const valueStart = skipWhitespace(input, i + key[0].length);
      const scanned = scanValue(input, valueStart, field === 'record');
      // A quoted value joins adjacent colon parts, as the server reads it: `"auth":other` is one value, `auth:other`.
      const joinedEnd = scanned.kind === 'quoted' && field !== 'record' ? joinColons(input, scanned.end, input.length) : scanned.end;
      const v = { ...scanned, end: joinedEnd };
      const raw = input.slice(i, v.end);
      const valueRaw = input.slice(skipWhitespace(input, valueStart + (v.op?.length ?? 0)), v.end);
      const decoded =
        joinedEnd > scanned.end
          ? readJoinedValue(valueRaw)
          : v.kind === 'plain' || v.kind === 'quoted' || v.kind === 'compare'
            ? readQueryValue(valueRaw)
            : { value: valueRaw, wildcard: false };
      tokens.push({
        kind: 'field',
        raw,
        start: i,
        end: v.end,
        negated,
        // Case is significant: unknown fields are attribute keys (attr.metadata.supportTicket).
        field,
        value: decoded.value,
        wildcard: decoded.wildcard && (field !== 'record' || valueRaw === '*'),
        valueKind: v.kind,
        valueStart,
        op: v.op,
        keyEnd: i + (key[1] ?? '').length + (key[2] ?? '').length,
      });
      i = v.end;
      continue;
    }
    const neg = ch === '-' && negatable && (rest[1] === '"' || rest[1] === '/') ? 1 : 0;
    const delimiter = rest[neg];
    if (delimiter === '"' || delimiter === '/') {
      const end = scanDelimited(input, i + neg, delimiter);
      const raw = input.slice(i, end);
      const value = delimiter === '"' ? readQueryValue(raw.slice(neg)).value : raw.slice(neg);
      tokens.push({ kind: delimiter === '"' ? 'phrase' : 'regex', raw, start: i, end, negated: neg === 1, value });
      i = end;
      continue;
    }
    const word = ch === '-' && !negatable ? LITERAL_DASH_RUN.exec(rest) : WORD_RE.exec(rest);
    if (word) {
      const raw = word[0];
      const isOperator = OPERATORS.has(raw);
      tokens.push({
        kind: isOperator ? 'operator' : 'text',
        raw,
        start: i,
        end: i + raw.length,
        negated: !isOperator && word[1] === '-' && raw.length > 1 && negatable,
        value: raw.length > 1 && negatable ? (word[2] ?? raw) : raw,
      });
      i += raw.length;
      continue;
    }
    // Unreachable in practice; keep the tokenizer total.
    tokens.push({ kind: 'text', raw: ch, start: i, end: i + 1, negated: false, value: ch });
    i += 1;
  }
  return tokens;
}

/**
 * Canonical form of a field key so aliases compare equal: `environment` → env, `timestamp` → occurredAt,
 * and every attribute spelling (`metadata.plan`, `attributes.metadata.plan`) → `attr.metadata.plan`.
 */
export function canonicalField(field: string): string {
  if (/^(attr|attributes)\./.test(field)) return `attr.${attributeKey(field)}`;
  const core = coreField(field);
  if (core) return core.key;
  return `attr.${field}`;
}

/** Keep plain IDs readable and quote values that can contain query syntax. */
const PLAIN_VALUE = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/;

export function quoteIfNeeded(value: string): string {
  return PLAIN_VALUE.test(value) && value !== 'TO' && !OPERATORS.has(value) ? value : quoteQueryValue(value);
}

/** A field name as the query language reads it: bare when it is a plain key, quoted otherwise (`"attr.ticket status"`). */
export function formatField(field: string): string {
  return BARE_KEY.test(field) && !OPERATORS.has(field) && field !== 'TO' ? field : quoteQueryValue(field);
}

export function formatTerm(field: string, value: string, negated = false): string {
  return `${negated ? '-' : ''}${formatField(field)}:${quoteIfNeeded(value)}`;
}

/**
 * A term that matches exactly `value`. `formatTerm` already does (a literal star is escaped, never a prefix search);
 * this name is kept for callers that ask for exactness explicitly.
 */
export const formatExactTerm = formatTerm;

/**
 * Recent parses by query text. A facet list asks "is this value included / excluded?" once per row and per state, each
 * walking the same query: one parse serves them all. The parse is never mutated, so sharing it is safe.
 */
const PARSES = new Map<string, QueryExpression | null>();
const PARSE_CACHE_SIZE = 16;

function editableExpression(q: string): QueryExpression | null {
  const cached = PARSES.get(q);
  if (cached !== undefined) return cached;
  let parsed: QueryExpression | null;
  try {
    parsed = parseQueryExpression(q);
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    parsed = null;
  }
  if (PARSES.size >= PARSE_CACHE_SIZE) PARSES.delete(PARSES.keys().next().value as string);
  PARSES.set(q, parsed);
  return parsed;
}

/** True when the query has an OR outside every group. */
export function hasTopLevelOr(q: string): boolean {
  return (editableExpression(q)?.length ?? 0) > 1;
}

export type ScopedQuery =
  /** Maps a server error position in `q` back onto the reader's text: `readerPosition = position - offset`. */
  { q: string; offset: number; problem: null } | { q: null; offset: 0; problem: QueryError };

/**
 * A locked filter (an entity page's record, actor, tenant or executor; a support agent) AND everything the reader typed.
 * The one function every "entity filter + user query" goes through: timelines, their facets, "Open in explorer", saved
 * views and exports. The reader's query is combined only once it parses, and always as ONE parenthesised group, so no
 * `OR`, negation or parenthesis in it can widen the base: `base (outcome:failure OR action:x)`, never
 * `base outcome:failure OR action:x`. A query that does not parse is never combined (string repairs such as wrapping
 * `a) OR (b` would balance it into an escape); the caller shows `problem` and sends nothing.
 */
export function scopedQuery(base: string, user: string): ScopedQuery {
  const locked = base.trim();
  if (!user.trim()) return { q: locked, offset: 0, problem: null };
  // No locked filter: the reader's query alone, exactly as before (the server reports its own syntax errors).
  if (!locked) return { q: user.trim(), offset: user.trimStart().length - user.length, problem: null };
  try {
    parseQueryExpression(user);
  } catch (error) {
    if (error instanceof QueryError) return { q: null, offset: 0, problem: error };
    throw error;
  }
  return { q: `${locked} (${user})`, offset: locked.length + 2, problem: null };
}

/** AND two queries, wrapping a top-level OR so both sides constrain the whole search. */
export function andQuery(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return x || y;
  const wrap = (s: string) => (hasTopLevelOr(s) ? `(${s})` : s);
  return `${wrap(x)} ${wrap(y)}`;
}

function fieldToken(q: string, node: Extract<QueryAtom, { kind: 'field' }>, start: number, negated: boolean): QueryToken {
  const { field, end, value, valueStart } = node;
  const raw = q.slice(valueStart, end);
  const token = value.kind === 'value' || value.kind === 'compare' ? value.token : undefined;
  let valueKind: ValueKind;
  if (value.kind === 'presence') valueKind = 'plain';
  else if (value.kind !== 'value') valueKind = value.kind;
  else if (value.token.kind === 'regex') valueKind = 'regex';
  else valueKind = raw.startsWith('"') ? 'quoted' : 'plain';
  return {
    kind: 'field',
    raw: q.slice(start, end),
    start,
    end,
    negated,
    field,
    value: value.kind === 'presence' ? '*' : (token?.value ?? raw),
    wildcard: value.kind === 'presence' || (field === 'record' ? raw === '*' : token?.wildcard),
    valueKind,
    valueStart,
    op: value.kind === 'compare' ? value.op : undefined,
    keyEnd: node.key.end,
  };
}

/**
 * Whether negating this group negates each of its terms on its own: true for one term or an OR of single terms
 * (`NOT (a OR b)` is `NOT a AND NOT b`), false once a branch ANDs two terms (`NOT (a b)` is `NOT a OR NOT b`).
 */
function singleTerm(expression: QueryExpression): boolean {
  return expression.every((branch) => branch.length === 1);
}

function unwrapNot(atom: QueryAtom) {
  let node = atom;
  let negated = false;
  while (node.kind === 'not') {
    negated = !negated;
    node = node.operand;
  }
  return { node, negated };
}

/** Drop matched operands with their unary operators, and omit Boolean branches emptied by the edit. */
export function removeTokens(q: string, test: (t: QueryToken) => boolean): string {
  let removed = false;
  // `outer`: whether an enclosing group is negated, so a term is tested with the polarity it has in the whole query;
  // `unpolarized`: inside a negated group that ANDs terms, where no term has a polarity of its own.
  function rewriteAtom(atom: QueryAtom, outer: boolean, unpolarized: boolean): string {
    const { node, negated } = unwrapNot(atom);
    const prefix = q.slice(atom.start, node.start);
    if (node.kind === 'group') {
      // The negation a group inherits counts too: `NOT ((a b))` ANDs a and b under one NOT just as `NOT (a b)` does.
      const inner = rewrite(node.expression, outer !== negated, unpolarized || (outer !== negated && !singleTerm(node.expression)));
      return inner ? `${prefix}(${inner})` : '';
    }
    if (node.kind === 'field' && test({ ...fieldToken(q, node, atom.start, outer !== negated), ...(unpolarized ? { unpolarized } : {}) })) {
      removed = true;
      return '';
    }
    // After a splice a bare leading '-' could become unary NOT. Quote it when the parser read it as data.
    const key = node.kind === 'field' ? node.key : node.kind === 'text' ? node.token : undefined;
    if (q[node.start] === '-' && key) return prefix + quoteQueryValue(node.kind === 'field' ? node.field : key.value) + q.slice(key.end, node.end);
    return q.slice(atom.start, atom.end);
  }

  function rewrite(expression: QueryExpression, outer: boolean, unpolarized: boolean): string {
    return expression
      .map((branch) => {
        let text = '';
        let previousEnd: number | undefined;
        for (const { atom, explicitAnd } of branch) {
          const term = rewriteAtom(atom, outer, unpolarized);
          if (!term) continue;
          if (text) {
            // An inserted separator must also avoid forming a foreign-dialect "key = value".
            if (explicitAnd || (previousEnd !== atom.start && /^(?:=|!=)/.test(term))) text += ' AND ';
            else if (previousEnd !== atom.start) text += ' ';
          }
          text += term;
          previousEnd = atom.end;
        }
        return text;
      })
      .filter(Boolean)
      .join(' OR ');
  }

  const expression = editableExpression(q);
  const edited = expression && rewrite(expression, false, false);
  return removed && edited !== null ? edited : q.trim();
}

/** Field terms with their effective polarity: each `-` or unary `NOT` before them or before an enclosing group negates. */
export function fieldTermsWithPolarity(q: string): { token: QueryToken; negated: boolean }[] {
  // The parsed walk already folds `-` and unary NOT, on the term and on enclosing groups (an even number cancels).
  return fieldTerms(q).map((token) => ({ token, negated: Boolean(token.negated) }));
}

export function fieldTerms(q: string, topLevelOnly = false): QueryToken[] {
  const fields: QueryToken[] = [];
  // A negated group of one term, or of terms ORed, negates each: `NOT (record:page:7)` excludes that record, it never
  // names it. A negated group that ANDs terms (`NOT (impersonator:* outcome:failure)`) says nothing about any one of them
  // alone, so its terms are not reported: no chip, facet or control may read them as the whole query's.
  function visit(expression: QueryExpression, outer: boolean) {
    for (const branch of expression) {
      for (const { atom } of branch) {
        const { node, negated } = unwrapNot(atom);
        if (node.kind === 'field') fields.push(fieldToken(q, node, atom.start, outer !== negated));
        else if (node.kind === 'group' && !topLevelOnly && (outer === negated || singleTerm(node.expression)))
          visit(node.expression, outer !== negated);
      }
    }
  }
  visit(editableExpression(q) ?? [], false);
  return fields;
}

/** Only plain `field:value` / `field:"value"` terms count as a facet value being selected. */
const isSimple = (t: QueryToken) => t.valueKind === 'plain' || t.valueKind === 'quoted';

export function hasTerm(q: string, field: string, value: string, negated?: boolean): boolean {
  const f = canonicalField(field);
  return fieldTerms(q).some(
    (t) => isSimple(t) && !t.wildcard && canonicalField(t.field ?? '') === f && t.value === value && (negated === undefined || t.negated === negated),
  );
}

/**
 * Remove every term for `field` (optionally only one value / polarity). Naming a value or a polarity is a facet's own
 * operation: it never reaches a term inside `NOT (a b)`, which has no polarity of its own. Removing the whole field does.
 */
export function removeTerm(q: string, field: string, value?: string, negated?: boolean): string {
  const f = canonicalField(field);
  return removeTokens(
    q,
    (t) =>
      t.kind === 'field' &&
      canonicalField(t.field ?? '') === f &&
      (value === undefined || (isSimple(t) && !t.wildcard && t.value === value && !t.unpolarized)) &&
      (negated === undefined || (!t.unpolarized && t.negated === negated)),
  );
}

/**
 * Include `field:value`. Adjacent terms are ANDed, so including a second value for the same
 * field would match nothing: positive terms for that field are replaced instead (people who want
 * either value write `(a OR b)` themselves).
 */
export function includeTerm(q: string, field: string, value: string): string {
  const without = removeTerm(removeTerm(q, field, undefined, false), field, value, true);
  return andQuery(without, formatTerm(field, value));
}

/** Exclude `field:value` (any number of exclusions can coexist). */
export function excludeTerm(q: string, field: string, value: string): string {
  const without = removeTerm(q, field, value);
  return andQuery(without, formatTerm(field, value, true));
}

/** Toggle helper used by facet rows: click → include / un-include; alt-click → exclude / un-exclude. */
export function toggleTerm(q: string, field: string, value: string, mode: 'include' | 'exclude'): string {
  if (mode === 'include') {
    return hasTerm(q, field, value, false) ? removeTerm(q, field, value, false) : includeTerm(q, field, value);
  }
  return hasTerm(q, field, value, true) ? removeTerm(q, field, value, true) : excludeTerm(q, field, value);
}

/** The token under the caret. */
export function tokenAt(q: string, caret: number): QueryToken | undefined {
  return tokenize(q).find((t) => t.kind !== 'space' && caret >= t.start && caret <= t.end);
}

/** Map facet API field names back to query fields. */
export function queryFieldForFacet(facet: string): string {
  if (facet === 'environment') return 'env';
  return facet;
}

/* ------------------------------------------------------------------ */
/* Highlighting                                                        */
/* ------------------------------------------------------------------ */

export type SegmentClass =
  | 'plain'
  | 'key'
  | 'negation'
  | 'punct'
  | 'operator'
  | 'keyword'
  | 'value'
  | 'string'
  | 'number'
  | 'regex'
  | 'wildcard'
  | 'ident'
  | 'unknown'
  | 'function'
  | 'comment';

export interface Segment {
  start: number;
  end: number;
  cls: SegmentClass;
  /** Inside the server-reported error span. */
  error?: boolean;
  /** Inside a familiar-but-different spelling the bar will convert (Lucene/KQL). */
  warn?: boolean;
}

const NUMBER_OR_DATE = /^-?(\d+(\.\d+)?|\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?)$/;

function pushValueWord(out: Segment[], input: string, start: number, end: number) {
  if (start >= end) return;
  const raw = input.slice(start, end);
  if (raw.startsWith('"')) {
    out.push({ start, end, cls: 'string' });
    return;
  }
  if (raw === '*') {
    out.push({ start, end, cls: 'wildcard' });
    return;
  }
  if (readQueryValue(raw).wildcard) {
    out.push({ start, end: end - 1, cls: 'value' }, { start: end - 1, end, cls: 'wildcard' });
    return;
  }
  out.push({ start, end, cls: NUMBER_OR_DATE.test(raw) ? 'number' : 'value' });
}

/** Split `[a TO b]` / `(a OR b)` interiors into words, keywords and punctuation. */
function pushCompound(out: Segment[], input: string, start: number, end: number, keyword: string) {
  let i = start;
  while (i < end) {
    const ch = input[i] ?? '';
    if (/\s/.test(ch)) {
      const s = /^\s+/.exec(input.slice(i, end))?.[0].length ?? 1;
      out.push({ start: i, end: i + s, cls: 'plain' });
      i += s;
    } else if ('[]{}()'.includes(ch)) {
      out.push({ start: i, end: i + 1, cls: 'punct' });
      i += 1;
    } else if (ch === '"') {
      const e = Math.min(end, scanDelimited(input, i, '"'));
      out.push({ start: i, end: e, cls: 'string' });
      i = e;
    } else {
      let e = i;
      while (e < end && !/[\s[\]{}()"]/.test(input[e] ?? '')) e += 1;
      const word = input.slice(i, e);
      if (word === keyword || word === 'OR') out.push({ start: i, end: e, cls: 'keyword' });
      else pushValueWord(out, input, i, e);
      i = e;
    }
  }
}

/** Highlight segments for a query. Segments cover the input exactly, in order. */
export function highlightQuery(input: string): Segment[] {
  const out: Segment[] = [];
  for (const t of tokenize(input)) {
    switch (t.kind) {
      case 'space':
        out.push({ start: t.start, end: t.end, cls: 'plain' });
        break;
      case 'paren':
        if (t.negated) out.push({ start: t.start, end: t.start + 1, cls: 'negation' });
        out.push({ start: t.end - 1, end: t.end, cls: 'punct' });
        break;
      case 'operator':
        out.push({ start: t.start, end: t.end, cls: 'keyword' });
        break;
      case 'phrase':
        out.push({ start: t.start, end: t.end, cls: t.negated ? 'negation' : 'string' });
        break;
      case 'regex':
        out.push({ start: t.start, end: t.end, cls: t.negated ? 'negation' : 'regex' });
        break;
      case 'text':
        if (t.negated) out.push({ start: t.start, end: t.end, cls: 'negation' });
        else pushValueWord(out, input, t.start, t.end);
        break;
      case 'field': {
        const keyStart = t.start + (t.negated ? 1 : 0);
        const keyEnd = t.keyEnd ?? keyStart + (t.field?.length ?? 0);
        const colon = input.indexOf(':', keyEnd);
        const valueStart = t.valueStart ?? colon + 1;
        if (t.negated) out.push({ start: t.start, end: keyStart, cls: 'negation' });
        out.push(
          { start: keyStart, end: keyEnd, cls: t.negated ? 'negation' : 'key' },
          { start: keyEnd, end: colon, cls: 'plain' },
          { start: colon, end: colon + 1, cls: 'punct' },
          { start: colon + 1, end: valueStart, cls: 'plain' },
        );
        if (t.valueKind === 'compare') {
          const opEnd = valueStart + (t.op?.length ?? 0);
          out.push({ start: valueStart, end: opEnd, cls: 'operator' });
          const operandStart = skipWhitespace(input, opEnd);
          out.push({ start: opEnd, end: operandStart, cls: 'plain' });
          pushValueWord(out, input, operandStart, t.end);
        } else if (t.valueKind === 'regex') {
          const closed = t.end - valueStart > 1 && input[t.end - 1] === '/' && input[t.end - 2] !== '\\';
          out.push({ start: valueStart, end: valueStart + 1, cls: 'punct' });
          out.push({ start: valueStart + 1, end: closed ? t.end - 1 : t.end, cls: 'regex' });
          if (closed) out.push({ start: t.end - 1, end: t.end, cls: 'punct' });
        } else if (t.valueKind === 'range') {
          pushCompound(out, input, valueStart, t.end, 'TO');
        } else if (t.valueKind === 'group') {
          pushCompound(out, input, valueStart, t.end, 'OR');
        } else {
          pushValueWord(out, input, valueStart, t.end);
        }
        break;
      }
      default:
        break;
    }
  }
  return out.filter((s) => s.end > s.start);
}

/**
 * Mark the half-open error span [start, end) on top of highlight segments, splitting segments at its
 * edges. A zero-width span (start === end) marks nothing; callers draw a caret at `start` instead.
 */
export function markErrorSpan(segments: Segment[], start: number | null, end: number | null, flag: 'error' | 'warn' = 'error'): Segment[] {
  if (start === null || end === null || end <= start) return segments;
  const out: Segment[] = [];
  for (const s of segments) {
    if (s.end <= start || s.start >= end) {
      out.push(s);
      continue;
    }
    if (s.start < start) out.push({ ...s, end: start });
    out.push({ ...s, start: Math.max(s.start, start), end: Math.min(s.end, end), [flag]: true });
    if (s.end > end) out.push({ ...s, start: end });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Autocomplete context                                                */
/* ------------------------------------------------------------------ */

export type QueryCompletion =
  /**
   * Completing a field key (or a bare word). Replace [from, to) with `key:`. `afterTerm`: a complete term
   * precedes the word, so boolean operators make sense here.
   */
  | { kind: 'key'; prefix: string; from: number; to: number; afterTerm: boolean }
  /** Lucene `_exists_:field`: complete field names and rewrite the whole term to `field:*`. */
  | { kind: 'exists'; prefix: string; from: number; to: number }
  /**
   * Completing the value of `field:`. Replace [from, to) with the (quoted if needed) value.
   * `inGroup`: inside `field:( … )`; `afterMember`: a member precedes the caret there (offer OR).
   */
  | {
      kind: 'value';
      field: string;
      prefix: string;
      from: number;
      to: number;
      op?: string;
      inGroup: boolean;
      quoted: boolean;
      afterMember?: boolean;
    }
  /** Inside `[a TO b]` / `/regex/` / a free-text phrase: nothing to complete, but the hint row explains the syntax. */
  | { kind: 'range'; field: string }
  | { kind: 'regex'; field: string }
  | { kind: 'phrase' }
  | { kind: 'none' };

const isTerm = (t?: QueryToken) =>
  Boolean(t && (t.kind === 'field' || t.kind === 'text' || t.kind === 'phrase' || t.kind === 'regex' || t.raw === ')'));

/** What the caret is completing. Pure; drives the suggestion list and the syntax hint row. */
export function queryCompletionAt(q: string, caret: number): QueryCompletion {
  const tokens = tokenize(q);
  const solid = tokens.filter((x) => x.kind !== 'space');
  const t = solid.find((x) => caret > x.start && caret <= x.end) ?? solid.find((x) => caret === x.start);
  const key = (from: number, to: number): QueryCompletion => {
    // The word being completed is not "before" itself; a `)` or term ending at the caret is.
    const prev = [...solid].reverse().find((x) => x.end <= from && !(x === t && (x.kind === 'text' || x.kind === 'operator' || x.kind === 'field')));
    // After a leading `-` a term is being negated: no operator can come next.
    const negating = t !== undefined && t.start < from && (t.negated || t.raw === '-');
    return { kind: 'key', prefix: q.slice(from, caret), from, to, afterTerm: !negating && isTerm(prev) };
  };
  // When the query parses, the server's term at the caret decides what is completed and what a completion replaces
  // (joined colons, quotes inside bare words, a quoted value with spaces): the console's tokens are only the fallback
  // while the query does not parse, so a completion can never rewrite more, or other, than the term it is in.
  const atCaret = serverFieldContaining(q, caret);
  if (atCaret) {
    const colon = q.indexOf(':', atCaret.key.end);
    if (caret <= colon) return key(atCaret.start, colon + 1);
    const completion = serverValueCompletion(q, caret, atCaret);
    if (completion) return completion;
  }
  if (!t || t.kind === 'paren' || (t.kind === 'operator' && caret === t.start)) return key(caret, caret);
  if (t.kind === 'phrase' || t.kind === 'regex') return caret === t.start ? key(caret, caret) : { kind: 'phrase' };
  if (t.kind === 'operator' || t.kind === 'text') {
    if (caret === t.start && t.kind === 'text') return key(caret, caret);
    const from = t.start + (t.negated || t.raw === '-' ? 1 : 0);
    if (caret < from) return { kind: 'none' };
    return key(from, t.end);
  }
  // field token
  const keyStart = t.start + (t.negated ? 1 : 0);
  const valueStart = t.valueStart ?? t.end;
  if (caret < keyStart) return { kind: 'none' };
  const field = t.field ?? '';
  const colon = q.indexOf(':', t.keyEnd ?? keyStart + field.length);
  if (caret <= colon) return key(keyStart, colon + 1);
  if (field === '_exists_') return { kind: 'exists', prefix: q.slice(valueStart, caret), from: keyStart, to: t.end };
  const value = (prefix: string, from: number, to: number, extra: Partial<Extract<QueryCompletion, { kind: 'value' }>> = {}): QueryCompletion => ({
    kind: 'value',
    field,
    prefix,
    from,
    to,
    inGroup: false,
    quoted: false,
    ...extra,
  });
  switch (t.valueKind) {
    case 'regex':
      return caret <= valueStart ? value('', valueStart, t.end) : { kind: 'regex', field };
    case 'range':
      return caret <= valueStart ? value('', valueStart, t.end) : { kind: 'range', field };
    case 'compare': {
      const opEnd = valueStart + (t.op?.length ?? 0);
      const from = skipWhitespace(q, opEnd);
      if (caret < opEnd) return value('', valueStart, t.end);
      return value(q.slice(from, caret), from, t.end, { op: t.op });
    }
    case 'quoted': {
      if (caret <= valueStart) return value('', valueStart, t.end, { quoted: true });
      return value(readQueryValue(q.slice(valueStart, caret)).value, valueStart, t.end, { quoted: true });
    }
    case 'group': {
      if (caret <= valueStart) return value('', valueStart, t.end);
      // Find the member around the caret inside `( … )`, walking whole members: a quoted member ("page:New York") is one
      // member however many spaces it holds, so a completion replaces all of it, never just the word under the caret.
      let s = caret;
      let e = caret;
      for (let i = valueStart + 1; i < t.end; ) {
        if (/[\s()]/.test(q[i] ?? '')) {
          i += 1;
          continue;
        }
        const end = scanPlainMember(q, i, t.end, field === 'record');
        if (caret >= i && caret <= end) {
          s = i;
          e = end;
          break;
        }
        if (i > caret) break;
        i = end;
      }
      const word = q.slice(s, caret);
      if (q.slice(s, e) === 'OR') return { kind: 'none' };
      // Inside a regex member, as in a regex value: no value suggestion may replace the pattern.
      if (q[s] === '/' && field !== 'record' && caret > s) return { kind: 'regex', field };
      // A member before the caret (not `(` or `OR`) means the next thing is `OR`.
      const before = q.slice(valueStart + 1, s).trimEnd();
      const afterMember = before.length > 0 && !/(^|\s)OR$/.test(before);
      return value(readQueryValue(word).value, s, e, { inGroup: true, quoted: q[s] === '"', afterMember });
    }
    default:
      return value(readQueryValue(q.slice(valueStart, caret)).value, valueStart, t.end);
  }
}
