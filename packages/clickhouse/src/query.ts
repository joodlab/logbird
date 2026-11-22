import { decodeRecordPair, QUERY_DIALECT_PREFIX, QUERY_FIELDS, type QueryErrorDetails, scanBareRecordValue } from '@logbird/contracts';
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
  QUERY_FIELDS.flatMap(({ aliases, column, key }) => (column ? [key, ...(aliases ?? [])].map((field) => [field, column]) : [])),
);

/** Match both selectors on one target. The index keeps bindings distinct within a query. */
export function recordTargetPredicate(type: string, id: string, index?: number) {
  const typeParam = `recordType${index ?? ''}`;
  const idParam = `recordId${index ?? ''}`;
  return {
    sql: `has(target_ids, {${idParam}:String}) AND arrayExists((t, i) -> t = {${typeParam}:String} AND i = {${idParam}:String}, target_types, target_ids)`,
    params: { [typeParam]: type, [idParam]: id },
  };
}

const RECORD_HINT = 'Use record:<type>:<id>, for example record:booking:bk_1042';
type Token = { kind: string; value: string; start: number; end: number };
export type Term = { field: string; value: string; negate: boolean; start: number; end: number };
function fail(reason: QueryErrorDetails['reason'], start: number, end: number, hint: string): never {
  throw new QueryError(reason === 'syntax' ? `Invalid query syntax: ${hint}` : hint, { lang: 'query', reason, start, end, hint });
}
function queryLexer(q: string) {
  if (Buffer.byteLength(q) > 4096) fail('too_complex', 0, q.length, 'Query exceeds 4096 bytes');
  let i = 0;
  return (record = false): Token | undefined => {
    while (i < q.length && /\s/.test(q[i]!)) i++;
    if (i === q.length) return undefined;
    // Only inspect outside quoted/regex tokens, so literal punctuation stays literal.
    const dialect = QUERY_DIALECT_PREFIX.exec(q.slice(i));
    if (dialect) {
      const text = dialect[1]
        ? `${dialect[2] === '!=' ? '-' : ''}${dialect[1]}:${dialect[3]}`
        : dialect[4]
          ? '-'
          : dialect[5] === '&&'
            ? ' AND '
            : ' OR ';
      throw new QueryError('Use Logbird query syntax', {
        lang: 'query',
        reason: 'syntax',
        start: i,
        end: i + dialect[0].length,
        hint: `Use ${text.trim()}`,
        replacement: {
          start: i,
          end: i + dialect[0].length,
          text: dialect[5] ? `${i && !/\s/.test(q[i - 1]!) ? ' ' : ''}${text.trim()}${q[i + 2] && !/\s/.test(q[i + 2]!) ? ' ' : ''}` : text,
        },
      });
    }
    const start = i,
      c = q[i++]!;
    if ('()[]{}<>'.includes(c) || (!record && c === ':')) {
      const v = (c === '<' || c === '>') && q[i] === '=' ? c + q[i++] : c;
      return { kind: v, value: v, start, end: i };
    }
    if (!record && c === '-' && (start === 0 || /[\s(]/.test(q[start - 1]!))) {
      return { kind: 'NOT', value: c, start, end: i };
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
      return { kind: c === '/' ? 'regex' : 'value', value, start, end: i };
    }
    if (record) i = scanBareRecordValue(q, start);
    else while (i < q.length && !/[\s():[\]{}<>]/.test(q[i]!) && !['&&', '||'].includes(q.slice(i, i + 2))) i++;
    const value = q.slice(start, i);
    return { kind: !record && ['AND', 'OR', 'NOT', 'TO'].includes(value) ? value : 'value', value, start, end: i };
  };
}
// Parsing and compilation share spans; no user value is emitted into SQL.
function compile(q: string, now: number, tokens?: Token[]) {
  const nextToken = queryLexer(q);
  const params: Record<string, string | number> = {};
  let buffered: Token | undefined;
  let terms = 0,
    parameter = 0,
    recordIndex = 0;
  const peek = (record = false) => {
    buffered ??= nextToken(record);
    return buffered;
  };
  const take = (record = false) => {
    const token = peek(record);
    buffered = undefined;
    if (token) tokens?.push({ ...token });
    return token;
  };
  const error = (hint: string, t = peek()) => fail('syntax', t?.start ?? q.length, t?.end ?? q.length, hint);
  const bind = (value: string | number, type = 'String') => {
    const key = `q${parameter++}`;
    params[key] = value;
    return `{${key}:${type}}`;
  };
  function value(joinColons = true, record = false): Token {
    const t = take(record);
    if (!t || !['value', 'regex'].includes(t.kind)) return error(record ? RECORD_HINT : 'Expected value', t);
    if (joinColons && !record) {
      let afterColon = false;
      for (let next = peek(); next?.start === t.end; next = peek()) {
        if (next.kind !== ':' && !(afterColon && next.kind === 'value')) break;
        t.value += next.value;
        t.end = next.end;
        afterColon = next.kind === ':';
        take();
      }
    }
    return t;
  }
  function predicate(field: string, token: Token, operator = '=', countTerm = true): string {
    if (countTerm && ++terms > 64) fail('too_complex', token.start, token.end, 'Query exceeds 64 terms');
    if (field === 'record') {
      if (token.kind === 'presence' || (token.kind === 'value' && token.value === '*' && q[token.start] !== '"')) return 'notEmpty(target_ids)';
      const pair = token.kind === 'regex' ? null : decodeRecordPair(token.value);
      if (!pair) fail('type', token.start, token.end, RECORD_HINT);
      const record = recordTargetPredicate(pair.type, pair.id, recordIndex++);
      Object.assign(params, record.params);
      return record.sql;
    }
    const info = QUERY_FIELDS.find((f) => f.key === field || f.aliases?.includes(field));
    const col = info?.column;
    const attr = field.replace(/^(attr|attributes)\./, '');
    const attrParameter = col ? '' : bind(attr);
    let expr = col ?? `attributes[${attrParameter}]`;
    const numeric = operator !== '=' || info?.type === 'number' || info?.type === 'date';
    if (numeric && token.value !== '*') {
      if (info && !['number', 'date'].includes(info.type)) fail('type', token.start, token.end, `${field} does not support comparisons`);
      const date = info?.type === 'date' || (!info && /^(?:\d{4}-\d{2}-\d{2}|now(?:$|[-+/]))/.test(token.value));
      if (date) {
        let raw = token.value;
        if (raw.startsWith('now')) {
          const relative = /^now(?:([+-])(\d+)([smhdw]))?(\/d)?$/.exec(raw);
          if (!relative) fail('type', token.start, token.end, 'Use now, now-7d or now/d (s/m/h/d/w)');
          const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
          const instant = now + (relative[1] === '-' ? -1 : 1) * Number(relative[2] ?? 0) * units[relative[3] ?? 's']!;
          const rounded = relative[4] ? Math.floor(instant / 86_400_000) * 86_400_000 : instant;
          if (!Number.isFinite(rounded) || Math.abs(rounded) > 8.64e15) fail('type', token.start, token.end, 'Relative date is out of range');
          raw = new Date(rounded).toISOString();
        }
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
        const pattern = new RegExp(token.value);
        if ([...pattern.source.matchAll(/(?<!\\)\{(\d+)(?:,(\d*))?\}/g)].some((m) => Number(m[1]) > 1000 || Number(m[2] ?? 0) > 1000))
          throw new Error('RE2 repetitions are limited to 1000');
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
    const record = field === 'record';
    const t = peek(record);
    if (!t) return error(record ? RECORD_HINT : 'Expected field value');
    if (record && ['>', '>=', '<', '<=', '[', '{'].includes(t.kind)) fail('type', t.start, t.end, RECORD_HINT);
    if (['>', '>=', '<', '<='].includes(t.kind)) {
      take();
      return predicate(field, value(), t.kind);
    }
    if (t.kind === '[' || t.kind === '{') {
      take();
      const lower = value();
      if (peek()?.kind !== 'TO') error('Expected TO');
      take();
      const upper = value(),
        close = peek();
      if (!close || ![']', '}'].includes(close.kind)) error('Expected closing range bracket');
      take();
      const parts: string[] = [];
      if (lower.value !== '*') parts.push(predicate(field, lower, t.kind === '[' ? '>=' : '>'));
      if (upper.value !== '*') parts.push(predicate(field, upper, close?.kind === ']' ? '<=' : '<', lower.value === '*'));
      return parts.length ? parts.join(' AND ') : predicate(field, lower);
    }
    if (t.kind === '(') {
      if (depth >= 16) fail('too_complex', t.start, t.end, 'Query exceeds 16 nesting levels');
      take();
      const members = [value(true, record)];
      while (peek()?.kind === 'OR') {
        take();
        members.push(value(true, record));
      }
      if (peek()?.kind !== ')') error('Expected closing value group parenthesis');
      take();
      const info = QUERY_FIELDS.find((f) => f.key === field || f.aliases?.includes(field));
      if (info && ['string', 'text'].includes(info.type) && members.every((m) => m.kind === 'value' && !m.value.endsWith('*'))) {
        terms += members.length;
        if (terms > 64) fail('too_complex', t.start, peek()?.start ?? q.length, 'Query exceeds 64 terms');
        return `${info.column} IN (${members.map((m) => bind(m.value)).join(',')})`;
      }
      return members.map((m) => `(${predicate(field, m)})`).join(' OR ');
    }
    return predicate(field, value(true, record));
  }
  function atom(depth: number): string {
    const t = peek();
    if (!t) return error('Expected term');
    if (t.kind === 'NOT') {
      take();
      return `NOT (${atom(depth)})`;
    }
    if (t.kind === '(') {
      if (depth >= 16) fail('too_complex', t.start, t.end, 'Query exceeds 16 nesting levels');
      take();
      const sql = disjunction(depth + 1);
      if (peek()?.kind !== ')') error('Expected closing parenthesis');
      take();
      return `(${sql})`;
    }
    const v = value(false);
    if (peek()?.kind === ':') {
      take();
      if (v.value === '_exists_') {
        const field = value(false);
        return `(${predicate(field.value, { ...field, kind: field.value === 'record' ? 'presence' : field.kind, value: '*' })})`;
      }
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
      if (peek()?.kind === 'AND') take();
      parts.push(atom(depth));
    }
    return parts.join(' AND ');
  }
  function disjunction(depth: number): string {
    const parts = [conjunction(depth)];
    while (peek()?.kind === 'OR') {
      take();
      parts.push(conjunction(depth));
    }
    return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]!;
  }
  const sql = peek() ? disjunction(0) : '1';
  if (peek()) error('Unexpected token');
  return { sql, params };
}
export function compileQuery(q = '', now = Date.now()) {
  return compile(q, now);
}
export function parseQuery(q = '') {
  const tokens: Token[] = [];
  compile(q, Date.now(), tokens);
  return tokens;
}
