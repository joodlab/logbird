/**
 * Client-side model of the Logbird query language (docs/SPEC.md §5.1 + §5.1.1 v2).
 *
 * The server owns parsing → SQL. The console only needs a *lossless* tokenizer to highlight the
 * query bar, drive autocomplete, and add/remove filter terms from facets, charts and entity pages
 * without destroying what the user typed.
 */
import { quoteQueryValue, readQueryValue, scanBareRecordValue } from '@logbird/contracts';
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

/** True when `q` has an `OR` outside every group. Adjacent terms bind tighter than `OR` (`a b OR c` = `(a b) OR c`). */
export function hasTopLevelOr(q: string): boolean {
  let depth = 0;
  for (const t of tokenize(q)) {
    if (t.kind === 'paren') depth += t.raw === ')' ? -1 : 1;
    else if (depth === 0 && t.kind === 'operator' && t.raw === 'OR') return true;
  }
  return false;
}

/**
 * `a` AND `b`, as one query. A side with a top-level `OR` is parenthesised, so the other side constrains all of it:
 * `andQuery('impersonator:x', 'outcome:failure OR outcome:denied')` → `impersonator:x (outcome:failure OR outcome:denied)`.
 */
export function andQuery(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  if (!x) return y;
  if (!y) return x;
  const wrap = (s: string) => (hasTopLevelOr(s) ? `(${s})` : s);
  return `${wrap(x)} ${wrap(y)}`;
}

/** Terms outside every group (`depth 0`), i.e. the ones that constrain the whole query when it has no top-level OR. */
export function topLevelFieldTerms(q: string): QueryToken[] {
  let depth = 0;
  const out: QueryToken[] = [];
  for (const t of tokenize(q)) {
    if (t.kind === 'paren') depth += t.raw === ')' ? -1 : 1;
    else if (depth === 0 && t.kind === 'field') out.push(t);
  }
  return out;
}

/** Drop operands within each AND branch, then drop empty branches from the enclosing OR. */
export function removeTokens(q: string, test: (t: QueryToken) => boolean): string {
  const tokens = tokenize(q).filter((t) => t.kind !== 'space');
  let i = 0;
  const isOperator = (raw: string) => tokens[i]?.kind === 'operator' && tokens[i]?.raw === raw;
  function expression(depth: number): string | null {
    if (depth > 16) return null;
    const branches: string[] = [];
    for (;;) {
      const terms: string[] = [];
      let connector = '';
      let previousEnd: number | undefined;
      for (;;) {
        const start = tokens[i]?.start;
        let not = '';
        while (isOperator('NOT')) {
          not += 'NOT ';
          i += 1;
        }
        const token = tokens[i++];
        if (!token || token.kind === 'operator' || token.raw === ')') return null;
        let term = '';
        if (token.kind === 'paren') {
          const group = expression(depth + 1);
          if (group === null || tokens[i++]?.raw !== ')') return null;
          if (group) term = `${token.raw}${group})`;
        } else if (!test(token)) {
          term = token.raw;
        }
        if (term) {
          const separator = terms.length && (connector || previousEnd !== start) ? ' ' : '';
          terms.push(`${separator}${terms.length ? connector : ''}${not}${term}`);
          previousEnd = tokens[i - 1]?.end;
        }
        if (isOperator('AND')) {
          i += 1;
          connector = 'AND ';
        } else {
          connector = '';
          if (!tokens[i] || tokens[i]?.raw === ')' || isOperator('OR')) break;
        }
      }
      if (terms.length) branches.push(terms.join(''));
      if (!isOperator('OR')) break;
      i += 1;
    }
    return branches.join(' OR ');
  }
  if (!tokens.length) return '';
  const result = expression(0);
  return result !== null && i === tokens.length ? result : q.trim();
}

/** Field terms with their effective polarity: a leading `-` or a unary `NOT` before them (not both) negates. */
export function fieldTermsWithPolarity(q: string): { token: QueryToken; negated: boolean }[] {
  const tokens = tokenize(q);
  const out: { token: QueryToken; negated: boolean }[] = [];
  tokens.forEach((t, i) => {
    if (t.kind !== 'field') return;
    let j = i - 1;
    let negated = t.negated;
    while (j >= 0) {
      const previous = tokens[j--];
      if (previous?.kind === 'space') continue;
      if (previous?.kind !== 'operator' || previous.raw !== 'NOT') break;
      negated = !negated;
    }
    out.push({ token: t, negated });
  });
  return out;
}

/** Field terms present in the query (non-space tokens only). */
export function fieldTerms(q: string): QueryToken[] {
  return tokenize(q).filter((t) => t.kind === 'field');
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
