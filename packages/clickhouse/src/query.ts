import { QUERY_FIELDS, type QueryErrorDetails } from '@trailmark/contracts';
export class QueryError extends Error {
  constructor(
    message: string,
    readonly details: QueryErrorDetails,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}
export const columns: Record<string, string> = Object.fromEntries(
  QUERY_FIELDS.flatMap((f) => [f.key, ...(f.aliases ?? [])].map((k) => [k, f.column])),
);
type Token = { kind: string; value: string; start: number; end: number };
export type Term = { field: string; value: string; negate: boolean; start: number; end: number };
function fail(reason: QueryErrorDetails['reason'], start: number, end: number, hint: string): never {
  throw new QueryError(reason === 'syntax' ? `Invalid query syntax: ${hint}` : hint, { lang: 'query', reason, start, end, hint });
}
function tokenize(q: string): Token[] {
  if (Buffer.byteLength(q) > 4096) fail('too_complex', 0, q.length, 'Query exceeds 4096 bytes');
  const tokens: Token[] = [];
  let i = 0;
  while (i < q.length) {
    if (/\s/.test(q[i]!)) {
      i++;
      continue;
    }
    const start = i,
      c = q[i++]!;
    if ('():[]{}<>'.includes(c)) {
      const v = (c === '<' || c === '>') && q[i] === '=' ? c + q[i++] : c;
      tokens.push({ kind: v, value: v, start, end: i });
      continue;
    }
    if (c === '-' && (start === 0 || /[\s(]/.test(q[start - 1]!))) {
      tokens.push({ kind: 'NOT', value: c, start, end: i });
      continue;
    }
    if (c === '"' || c === '/') {
      let value = '',
        closed = false;
      while (i < q.length) {
        const ch = q[i++]!;
        if (ch === c) {
          closed = true;
          break;
        }
        if (ch === '\\' && i < q.length) {
          const next = q[i++]!;
          value += c === '/' && next !== '/' ? `\\${next}` : next;
        } else value += ch;
      }
      if (!closed) fail('syntax', start, i, c === '"' ? 'Unterminated quoted query' : 'Unterminated regex');
      tokens.push({ kind: c === '/' ? 'regex' : 'value', value, start, end: i });
      continue;
    }
    while (i < q.length && !/[\s():[\]{}<>]/.test(q[i]!)) i++;
    const value = q.slice(start, i);
    tokens.push({ kind: ['AND', 'OR', 'NOT', 'TO'].includes(value) ? value : 'value', value, start, end: i });
  }
  return tokens;
}
// Parsing and compilation share spans; no user value is emitted into SQL.
export function compileQuery(q = '') {
  const tokens = tokenize(q),
    params: Record<string, string | number> = {};
  let at = 0,
    terms = 0,
    parameter = 0;
  const peek = () => tokens[at];
  const error = (hint: string, t = peek()) => fail('syntax', t?.start ?? q.length, t?.end ?? q.length, hint);
  const bind = (value: string | number, type = 'String') => {
    const key = `q${parameter++}`;
    params[key] = value;
    return `{${key}:${type}}`;
  };
  function value(joinColons = true): Token {
    const t = tokens[at++];
    if (!t || !['value', 'regex'].includes(t.kind)) error('Expected value', t);
    if (t && joinColons) {
      while (tokens[at]?.start === t.end && tokens[at]?.kind === ':') {
        const next = tokens[at++]!;
        t.value += next.value;
        t.end = next.end;
        const tail = tokens[at];
        if (tail && tail.start === t.end && tail.kind === 'value') {
          t.value += tail.value;
          t.end = tail.end;
          at++;
        }
      }
    }
    return t!;
  }
  function predicate(field: string, token: Token, operator = '=', countTerm = true): string {
    if (countTerm && ++terms > 64) fail('too_complex', token.start, token.end, 'Query exceeds 64 terms');
    const info = QUERY_FIELDS.find((f) => f.key === field || f.aliases?.includes(field));
    const col = info?.column;
    const attr = field.replace(/^(attr|attributes)\./, '');
    const attrParameter = col ? '' : bind(attr);
    let expr = col ?? `attributes[${attrParameter}]`;
    const numeric = operator !== '=' || info?.type === 'number' || info?.type === 'date';
    if (numeric && token.value !== '*') {
      if (info && !['number', 'date'].includes(info.type)) fail('type', token.start, token.end, `${field} does not support comparisons`);
      const date = info?.type === 'date' || (!info && /^\d{4}-\d{2}-\d{2}/.test(token.value));
      if (date) {
        const raw = token.value;
        const calendar = raw.slice(0, 10);
        const midnight = new Date(`${calendar}T00:00:00Z`);
        if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== calendar)
          fail('type', token.start, token.end, `${field} is a date`);
        const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
        if (
          !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw) ||
          !Number.isFinite(d.getTime()) ||
          (d.toISOString().slice(0, 10) !== raw.slice(0, 10) && raw.length === 10)
        )
          fail('type', token.start, token.end, `${field} is a date; use YYYY-MM-DD or ISO-8601`);
        if (!col) expr = `parseDateTime64BestEffortOrNull(${expr},3,'UTC')`;
        return `${expr} ${operator} parseDateTime64BestEffort(${bind(d.toISOString())},3,'UTC')`;
      }
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token.value) || !Number.isFinite(Number(token.value)))
        fail('type', token.start, token.end, `${field} is a number`);
      if (!col) expr = `toFloat64OrNull(${expr})`;
      return `${expr} ${operator} ${bind(Number(token.value), 'Float64')}`;
    }
    let test: string;
    const x = info?.type === 'array' ? 'x' : expr;
    if (token.kind === 'regex') {
      try {
        const regex = new RegExp(token.value);
        regex.test('');
        if (/\(\?[=!<]|\\[1-9]|\(\?>/.test(token.value)) throw new Error('Unsupported RE2 construct');
      } catch {
        fail('type', token.start, token.end, 'Use a valid RE2 regex without lookaround or backreferences');
      }
      test = `match(${x}, ${bind(`^(?:${token.value})$`)})`;
    } else if (token.value === '*') test = info?.type === 'number' || info?.type === 'date' ? '1' : `${x} != ''`;
    else if (token.value.endsWith('*')) test = `startsWith(${x}, ${bind(token.value.slice(0, -1))})`;
    else test = `${x} = ${bind(token.value)}`;
    if (info?.type === 'array') return `arrayExists(x -> ${test}, ${expr})`;
    if (!col) return `mapContains(attributes,${attrParameter}) AND (${test})`;
    return test;
  }
  function fieldValue(field: string, depth: number): string {
    const t = peek();
    if (!t) return error('Expected field value');
    if (['>', '>=', '<', '<='].includes(t.kind)) {
      at++;
      return predicate(field, value(), t.kind);
    }
    if (t.kind === '[' || t.kind === '{') {
      at++;
      const lower = value();
      if (peek()?.kind !== 'TO') error('Expected TO');
      at++;
      const upper = value(),
        close = peek();
      if (!close || ![']', '}'].includes(close.kind)) error('Expected closing range bracket');
      at++;
      const parts: string[] = [];
      if (lower.value !== '*') parts.push(predicate(field, lower, t.kind === '[' ? '>=' : '>'));
      if (upper.value !== '*') parts.push(predicate(field, upper, close?.kind === ']' ? '<=' : '<', lower.value === '*'));
      return parts.length ? parts.join(' AND ') : predicate(field, lower);
    }
    if (t.kind === '(') {
      if (depth >= 16) fail('too_complex', t.start, t.end, 'Query exceeds 16 nesting levels');
      at++;
      const members = [value()];
      while (peek()?.kind === 'OR') {
        at++;
        members.push(value());
      }
      if (peek()?.kind !== ')') error('Expected closing value group parenthesis');
      at++;
      const info = QUERY_FIELDS.find((f) => f.key === field || f.aliases?.includes(field));
      if (info && ['string', 'text'].includes(info.type) && members.every((m) => m.kind === 'value' && !m.value.endsWith('*'))) {
        terms += members.length;
        if (terms > 64) fail('too_complex', t.start, peek()?.start ?? q.length, 'Query exceeds 64 terms');
        return `${info.column} IN (${members.map((m) => bind(m.value)).join(',')})`;
      }
      return members.map((m) => `(${predicate(field, m)})`).join(' OR ');
    }
    return predicate(field, value());
  }
  function atom(depth: number): string {
    const t = peek();
    if (!t) return error('Expected term');
    if (t.kind === 'NOT') {
      at++;
      return `NOT (${atom(depth)})`;
    }
    if (t.kind === '(') {
      if (depth >= 16) fail('too_complex', t.start, t.end, 'Query exceeds 16 nesting levels');
      at++;
      const sql = disjunction(depth + 1);
      if (peek()?.kind !== ')') error('Expected closing parenthesis');
      at++;
      return `(${sql})`;
    }
    const v = value(false);
    if (peek()?.kind === ':') {
      at++;
      return `(${fieldValue(v.value, depth)})`;
    }
    if (++terms > 64) fail('too_complex', v.start, v.end, 'Query exceeds 64 terms');
    if (v.kind === 'regex') return `(${predicate('description', v, '=', false)})`;
    const p = bind(v.value);
    return /^[\p{L}\p{N}]+$/u.test(v.value) ? `(hasToken(search_text, lowerUTF8(${p})))` : `(position(search_text, lowerUTF8(${p})) > 0)`;
  }
  function conjunction(depth: number): string {
    const parts = [atom(depth)];
    while (peek() && !['OR', ')'].includes(peek()?.kind ?? '')) {
      if (peek()?.kind === 'AND') at++;
      parts.push(atom(depth));
    }
    return parts.join(' AND ');
  }
  function disjunction(depth: number): string {
    const parts = [conjunction(depth)];
    while (peek()?.kind === 'OR') {
      at++;
      parts.push(conjunction(depth));
    }
    return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]!;
  }
  const sql = tokens.length ? disjunction(0) : '1';
  if (peek()) error('Unexpected token');
  return { sql, params };
}
export function parseQuery(q = '') {
  compileQuery(q);
  return tokenize(q);
}
