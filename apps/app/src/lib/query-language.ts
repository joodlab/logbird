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
}

const KEY_RE = /^(-?)([A-Za-z_][\w.$@-]*)\s*:/;
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
    if (ch === '(' || ch === ')' || (ch === '-' && rest[1] === '(')) {
      const raw = ch === '-' ? '-(' : ch;
      tokens.push({ kind: 'paren', raw, start: i, end: i + raw.length, negated: ch === '-' });
      i += raw.length;
      continue;
    }
    const key = KEY_RE.exec(rest);
    if (key) {
      const valueStart = skipWhitespace(input, i + key[0].length);
      const v = scanValue(input, valueStart, key[2] === 'record');
      const raw = input.slice(i, v.end);
      const valueRaw = input.slice(skipWhitespace(input, valueStart + (v.op?.length ?? 0)), v.end);
      const decoded =
        v.kind === 'plain' || v.kind === 'quoted' || v.kind === 'compare' ? readQueryValue(valueRaw) : { value: valueRaw, wildcard: false };
      tokens.push({
        kind: 'field',
        raw,
        start: i,
        end: v.end,
        negated: key[1] === '-',
        // Case is significant: unknown fields are attribute keys (attr.metadata.supportTicket).
        field: key[2] ?? '',
        value: decoded.value,
        wildcard: decoded.wildcard && (key[2] !== 'record' || valueRaw === '*'),
        valueKind: v.kind,
        valueStart,
        op: v.op,
      });
      i = v.end;
      continue;
    }
    const neg = ch === '-' && (rest[1] === '"' || rest[1] === '/') ? 1 : 0;
    const delimiter = rest[neg];
    if (delimiter === '"' || delimiter === '/') {
      const end = scanDelimited(input, i + neg, delimiter);
      const raw = input.slice(i, end);
      const value = delimiter === '"' ? readQueryValue(raw.slice(neg)).value : raw.slice(neg);
      tokens.push({ kind: delimiter === '"' ? 'phrase' : 'regex', raw, start: i, end, negated: neg === 1, value });
      i = end;
      continue;
    }
    const word = /^(-?)([^\s()"]+)/.exec(rest);
    if (word) {
      const raw = word[0];
      const isOperator = OPERATORS.has(raw);
      tokens.push({
        kind: isOperator ? 'operator' : 'text',
        raw,
        start: i,
        end: i + raw.length,
        negated: !isOperator && word[1] === '-' && raw.length > 1,
        value: raw.length > 1 ? (word[2] ?? raw) : raw,
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

export function formatTerm(field: string, value: string, negated = false): string {
  return `${negated ? '-' : ''}${field}:${quoteIfNeeded(value)}`;
}

function editableExpression(q: string): QueryExpression | null {
  try {
    return parseQueryExpression(q);
  } catch (error) {
    if (error instanceof QueryError) return null;
    throw error;
  }
}

/** True when the query has an OR outside every group. */
export function hasTopLevelOr(q: string): boolean {
  return (editableExpression(q)?.length ?? 0) > 1;
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
  };
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
  function rewriteAtom(atom: QueryAtom): string {
    const { node, negated } = unwrapNot(atom);
    const prefix = q.slice(atom.start, node.start);
    if (node.kind === 'group') {
      const inner = rewrite(node.expression);
      return inner ? `${prefix}(${inner})` : '';
    }
    if (node.kind === 'field' && test(fieldToken(q, node, atom.start, negated))) {
      removed = true;
      return '';
    }
    // After a splice a bare leading '-' could become unary NOT. Quote it when the parser read it as data.
    const key = node.kind === 'field' ? node.key : node.kind === 'text' ? node.token : undefined;
    if (q[node.start] === '-' && key) return prefix + quoteQueryValue(node.kind === 'field' ? node.field : key.value) + q.slice(key.end, node.end);
    return q.slice(atom.start, atom.end);
  }

  function rewrite(expression: QueryExpression): string {
    return expression
      .map((branch) => {
        let text = '';
        let previousEnd: number | undefined;
        for (const { atom, explicitAnd } of branch) {
          const term = rewriteAtom(atom);
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
  const edited = expression && rewrite(expression);
  return removed && edited !== null ? edited : q.trim();
}

/** Field operands with the effective polarity of their directly attached unary operators. */
export function fieldTerms(q: string, topLevelOnly = false): QueryToken[] {
  const fields: QueryToken[] = [];
  function visit(expression: QueryExpression) {
    for (const branch of expression) {
      for (const { atom } of branch) {
        const { node, negated } = unwrapNot(atom);
        if (node.kind === 'field') fields.push(fieldToken(q, node, atom.start, negated));
        else if (node.kind === 'group' && !topLevelOnly) visit(node.expression);
      }
    }
  }
  visit(editableExpression(q) ?? []);
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

/** Remove every term for `field` (optionally only one value / polarity). */
export function removeTerm(q: string, field: string, value?: string, negated?: boolean): string {
  const f = canonicalField(field);
  return removeTokens(
    q,
    (t) =>
      t.kind === 'field' &&
      canonicalField(t.field ?? '') === f &&
      (value === undefined || (isSimple(t) && !t.wildcard && t.value === value)) &&
      (negated === undefined || t.negated === negated),
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
        const keyEnd = keyStart + (t.field?.length ?? 0);
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
  const colon = q.indexOf(':', keyStart + field.length);
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
      // Find the member word around the caret inside `( … )`.
      let s = caret;
      while (s > valueStart + 1 && !/[\s()]/.test(q[s - 1] ?? '')) s -= 1;
      let e = caret;
      while (e < t.end && !/[\s()]/.test(q[e] ?? '')) e += 1;
      if (q[s] === '"') e = Math.min(t.end, scanDelimited(q, s, '"'));
      const word = q.slice(s, caret);
      if (q.slice(s, e) === 'OR') return { kind: 'none' };
      // A member before the caret (not `(` or `OR`) means the next thing is `OR`.
      const before = q.slice(valueStart + 1, s).trimEnd();
      const afterMember = before.length > 0 && !/(^|\s)OR$/.test(before);
      return value(readQueryValue(word).value, s, e, { inGroup: true, quoted: q[s] === '"', afterMember });
    }
    default:
      return value(readQueryValue(q.slice(valueStart, caret)).value, valueStart, t.end);
  }
}
