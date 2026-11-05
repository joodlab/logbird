/**
 * Client-side model of the Trailmark query language (docs/SPEC.md §5.1 + §5.1.1 v2).
 *
 * The server owns parsing → SQL. The console only needs a *lossless* tokenizer to highlight the
 * query bar, drive autocomplete, and add/remove filter terms from facets, charts and entity pages
 * without destroying what the user typed.
 */
import { attributeKey, coreField } from './query-catalog';

export type TokenKind = 'field' | 'text' | 'phrase' | 'operator' | 'paren' | 'space';
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
  valueKind?: ValueKind;
  /** Offset of the first value character (after `:`) for `field` tokens. */
  valueStart?: number;
  /** `>`, `>=`, `<`, `<=` for comparisons. */
  op?: string;
}

const KEY_RE = /^(-?)([A-Za-z_][\w.$@-]*):/;
const OPERATORS = new Set(['OR', 'AND', 'NOT']);

function unquote(value: string): string {
  if (value.startsWith('"')) {
    const inner = value.endsWith('"') && value.length > 1 ? value.slice(1, -1) : value.slice(1);
    return inner.replace(/\\(.)/g, '$1');
  }
  return value;
}

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
    if (ch === '"') {
      j = scanDelimited(input, j, '"');
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

/** Lex the value after `key:` starting at `i`. */
function scanValue(input: string, i: number): { end: number; kind: ValueKind; op?: string } {
  const ch = input[i];
  if (ch === '"') return { end: scanDelimited(input, i, '"'), kind: 'quoted' };
  if (ch === '/') return { end: scanDelimited(input, i, '/'), kind: 'regex' };
  if (ch === '[' || ch === '{') {
    const close = /[\]}]/.exec(input.slice(i + 1));
    return { end: close ? i + 1 + close.index + 1 : input.length, kind: 'range' };
  }
  if (ch === '(') return { end: scanGroup(input, i), kind: 'group' };
  const op = /^(>=|<=|>|<)/.exec(input.slice(i))?.[0];
  if (op) return { end: scanPlain(input, i + op.length), kind: 'compare', op };
  return { end: scanPlain(input, i), kind: 'plain' };
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
      const valueStart = i + key[0].length;
      const v = scanValue(input, valueStart);
      const raw = input.slice(i, v.end);
      const valueRaw = input.slice(valueStart + (v.op?.length ?? 0), v.end);
      tokens.push({
        kind: 'field',
        raw,
        start: i,
        end: v.end,
        negated: key[1] === '-',
        // Case is significant: unknown fields are attribute keys (attr.metadata.supportTicket).
        field: key[2] ?? '',
        value: v.kind === 'plain' || v.kind === 'quoted' || v.kind === 'compare' ? unquote(valueRaw) : valueRaw,
        valueKind: v.kind,
        valueStart,
        op: v.op,
      });
      i = v.end;
      continue;
    }
    const neg = ch === '-' && rest[1] === '"' ? 1 : 0;
    if (rest[neg] === '"') {
      const end = scanDelimited(input, i + neg, '"');
      const raw = input.slice(i, end);
      tokens.push({ kind: 'phrase', raw, start: i, end, negated: neg === 1, value: unquote(raw.slice(neg)) });
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

const NEEDS_QUOTES = /[\s()"\\]|^[[{/<>]|^$/;

export function quoteIfNeeded(value: string): string {
  return NEEDS_QUOTES.test(value) || OPERATORS.has(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value;
}

export function formatTerm(field: string, value: string, negated = false): string {
  return `${negated ? '-' : ''}${field}:${quoteIfNeeded(value)}`;
}

/**
 * Drop operators and groups that removing a term left dangling — `(a OR b)` minus `a` and `b` must
 * not become `( OR )`, which the server rightly rejects.
 */
function tidy(tokens: QueryToken[]): QueryToken[] {
  let current = tokens;
  for (;;) {
    const solid = current.filter((t) => t.kind !== 'space');
    const drop = new Set<QueryToken>();
    solid.forEach((t, i) => {
      const prev = solid[i - 1];
      const next = solid[i + 1];
      const opens = (x?: QueryToken) => x?.kind === 'paren' && x.raw !== ')';
      if (t.kind === 'operator' && t.raw !== 'NOT' && (!prev || !next || opens(prev) || next.raw === ')' || next.kind === 'operator')) drop.add(t);
      if (t.raw === 'NOT' && (!next || next.raw === ')' || (next.kind === 'operator' && next.raw !== 'NOT'))) drop.add(t);
      if (opens(t) && next?.raw === ')') {
        drop.add(t);
        drop.add(next);
      }
    });
    current.forEach((t, i) => {
      const prev = current[i - 1];
      if (t.kind === 'space' && ((prev?.kind === 'paren' && prev.raw !== ')') || current[i + 1]?.raw === ')')) drop.add(t);
    });
    if (drop.size === 0) return current;
    current = current.filter((t) => !drop.has(t));
  }
}

function join(tokens: QueryToken[]): string {
  return tidy(tokens)
    .map((t) => t.raw)
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
    (t) => isSimple(t) && canonicalField(t.field ?? '') === f && t.value === value && (negated === undefined || t.negated === negated),
  );
}

/** Remove every term for `field` (optionally only one value / polarity). */
export function removeTerm(q: string, field: string, value?: string, negated?: boolean): string {
  const f = canonicalField(field);
  const kept = tokenize(q).filter(
    (t) =>
      !(
        t.kind === 'field' &&
        canonicalField(t.field ?? '') === f &&
        (value === undefined || (isSimple(t) && t.value === value)) &&
        (negated === undefined || t.negated === negated)
      ),
  );
  return join(kept);
}

/**
 * Include `field:value`. Adjacent terms are ANDed, so including a second value for the same
 * field would match nothing: positive terms for that field are replaced instead (people who want
 * either value write `(a OR b)` themselves).
 */
export function includeTerm(q: string, field: string, value: string): string {
  const without = removeTerm(removeTerm(q, field, undefined, false), field, value, true);
  return `${without} ${formatTerm(field, value)}`.trim();
}

/** Exclude `field:value` (any number of exclusions can coexist). */
export function excludeTerm(q: string, field: string, value: string): string {
  const without = removeTerm(q, field, value);
  return `${without} ${formatTerm(field, value, true)}`.trim();
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
  if (raw.endsWith('*')) {
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
      case 'text':
        if (t.negated) out.push({ start: t.start, end: t.end, cls: 'negation' });
        else pushValueWord(out, input, t.start, t.end);
        break;
      case 'field': {
        const keyStart = t.start + (t.negated ? 1 : 0);
        const colon = keyStart + (t.field?.length ?? 0);
        const valueStart = t.valueStart ?? colon + 1;
        if (t.negated) out.push({ start: t.start, end: keyStart, cls: 'negation' });
        out.push({ start: keyStart, end: colon, cls: t.negated ? 'negation' : 'key' }, { start: colon, end: valueStart, cls: 'punct' });
        if (t.valueKind === 'compare') {
          const opEnd = valueStart + (t.op?.length ?? 0);
          out.push({ start: valueStart, end: opEnd, cls: 'operator' });
          pushValueWord(out, input, opEnd, t.end);
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
export function markErrorSpan(segments: Segment[], start: number | null, end: number | null): Segment[] {
  if (start === null || end === null || end <= start) return segments;
  const out: Segment[] = [];
  for (const s of segments) {
    if (s.end <= start || s.start >= end) {
      out.push(s);
      continue;
    }
    if (s.start < start) out.push({ ...s, end: start });
    out.push({ ...s, start: Math.max(s.start, start), end: Math.min(s.end, end), error: true });
    if (s.end > end) out.push({ ...s, start: end });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Autocomplete context                                                */
/* ------------------------------------------------------------------ */

export type QueryCompletion =
  /** Completing a field key (or a bare word). Replace [from, to) with `key:`. */
  | { kind: 'key'; prefix: string; from: number; to: number }
  /** Completing the value of `field:`. Replace [from, to) with the (quoted if needed) value. */
  | { kind: 'value'; field: string; prefix: string; from: number; to: number; op?: string; inGroup: boolean }
  | { kind: 'none' };

/** What the caret is completing. Pure; drives the suggestion list. */
export function queryCompletionAt(q: string, caret: number): QueryCompletion {
  const tokens = tokenize(q);
  const t =
    tokens.find((x) => x.kind !== 'space' && caret > x.start && caret <= x.end) ?? tokens.find((x) => x.kind !== 'space' && caret === x.start);
  if (!t || t.kind === 'paren' || (t.kind === 'operator' && caret === t.start)) return { kind: 'key', prefix: '', from: caret, to: caret };
  if (t.kind === 'phrase') return { kind: 'none' };
  if (t.kind === 'operator' || t.kind === 'text') {
    if (caret === t.start && t.kind === 'text') return { kind: 'key', prefix: '', from: caret, to: caret };
    const from = t.start + (t.negated || t.raw === '-' ? 1 : 0);
    if (caret < from) return { kind: 'none' };
    return { kind: 'key', prefix: q.slice(from, caret), from, to: t.end };
  }
  // field token
  const keyStart = t.start + (t.negated ? 1 : 0);
  const valueStart = t.valueStart ?? t.end;
  if (caret < keyStart) return { kind: 'none' };
  if (caret < valueStart) return { kind: 'key', prefix: q.slice(keyStart, caret), from: keyStart, to: valueStart };
  const field = t.field ?? '';
  switch (t.valueKind) {
    case 'regex':
    case 'range':
      return { kind: 'none' };
    case 'compare': {
      const from = valueStart + (t.op?.length ?? 0);
      if (caret < from) return { kind: 'none' };
      return { kind: 'value', field, prefix: q.slice(from, caret), from, to: t.end, op: t.op, inGroup: false };
    }
    case 'quoted': {
      if (caret === valueStart) return { kind: 'value', field, prefix: '', from: valueStart, to: t.end, inGroup: false };
      return { kind: 'value', field, prefix: unquote(q.slice(valueStart, caret)), from: valueStart, to: t.end, inGroup: false };
    }
    case 'group': {
      if (caret === valueStart) return { kind: 'none' };
      // Find the member word around the caret inside `( … )`.
      let s = caret;
      while (s > valueStart + 1 && !/[\s()]/.test(q[s - 1] ?? '')) s -= 1;
      let e = caret;
      while (e < t.end && !/[\s()]/.test(q[e] ?? '')) e += 1;
      const word = q.slice(s, caret);
      if (word === 'OR' || q.slice(s, e) === 'OR') return { kind: 'none' };
      return { kind: 'value', field, prefix: unquote(word), from: s, to: e, inGroup: true };
    }
    default:
      return { kind: 'value', field, prefix: q.slice(valueStart, caret), from: valueStart, to: t.end, inGroup: false };
  }
}
