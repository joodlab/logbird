import { QUERY_DIALECT_PREFIX, type QueryErrorDetails } from './query';
import { readQueryValue, scanBareRecordValue } from './record-selector';

export class QueryError extends Error {
  constructor(
    message: string,
    readonly details: QueryErrorDetails,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}
export const RECORD_HINT = 'Use record:<type>:<id>, for example record:booking:bk_1042';
export type ParsedQueryToken = { kind: string; value: string; start: number; end: number };
export type QuerySyntaxToken = Omit<ParsedQueryToken, 'kind'> & {
  wildcard?: boolean;
  kind: 'value' | 'regex' | 'AND' | 'OR' | 'NOT' | 'TO' | '(' | ')' | '[' | ']' | '{' | '}' | ':' | '<' | '<=' | '>' | '>=';
};
export function failQuery(reason: QueryErrorDetails['reason'], start: number, end: number, hint: string): never {
  throw new QueryError(reason === 'syntax' ? `Invalid query syntax: ${hint}` : hint, { lang: 'query', reason, start, end, hint });
}
function queryLexer(q: string) {
  if (new TextEncoder().encode(q).length > 4096) failQuery('too_complex', 0, q.length, 'Query exceeds 4096 bytes');
  let i = 0;
  return (record = false): QuerySyntaxToken | undefined => {
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
      return { kind: v as QuerySyntaxToken['kind'], value: v, start, end: i };
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
          if (c === '/') value += next === '/' ? next : `\\${next}`;
        } else if (c === '/') value += ch;
      }
      if (!closed) failQuery('syntax', start, i, c === '"' ? 'Unterminated quoted query' : 'Unterminated regex');
      if (c === '/') return { kind: 'regex', value, start, end: i };
      return { kind: 'value', ...readQueryValue(q.slice(start, i)), start, end: i };
    }
    if (record) i = scanBareRecordValue(q, start);
    else while (i < q.length && !/[\s():[\]{}<>]/.test(q[i]!) && !['&&', '||'].includes(q.slice(i, i + 2))) i++;
    const raw = q.slice(start, i);
    return {
      kind: !record && ['AND', 'OR', 'NOT', 'TO'].includes(raw) ? (raw as 'AND' | 'OR' | 'NOT' | 'TO') : 'value',
      ...readQueryValue(raw),
      start,
      end: i,
    };
  };
}
/** Field names use the source spelling when bare, and the decoded value when quoted or delimited. */
export function queryFieldName(raw: string, decoded?: string): string {
  return /^["/]/.test(raw) ? (decoded ?? readQueryValue(raw).value) : raw;
}

type Span = { start: number; end: number };
type FieldValue =
  | { kind: 'value'; token: QuerySyntaxToken }
  | { kind: 'compare'; op: string; token: QuerySyntaxToken }
  | { kind: 'range'; open: string; close: string; lower: QuerySyntaxToken; upper: QuerySyntaxToken }
  | { kind: 'group'; members: QuerySyntaxToken[] }
  | { kind: 'presence'; token: QuerySyntaxToken };

export type QueryAtom = Span &
  (
    | { kind: 'not'; operand: QueryAtom }
    | { kind: 'group'; expression: QueryExpression }
    | { kind: 'field'; field: string; key: QuerySyntaxToken; valueStart: number; value: FieldValue }
    | { kind: 'text'; token: QuerySyntaxToken }
  );

/** Disjunction of conjunctions. Each atom after the first may have an explicit AND. */
export type QueryExpression = { atom: QueryAtom; explicitAnd: boolean }[][];

export function parseQueryExpression(q: string, tokens?: ParsedQueryToken[]): QueryExpression {
  const nextToken = queryLexer(q);
  let buffered: QuerySyntaxToken | undefined;
  let end = 0;
  const peek = (record = false) => {
    buffered ??= nextToken(record);
    return buffered;
  };
  const take = () => {
    const token = buffered;
    buffered = undefined;
    if (token) {
      end = token.end;
      const { kind, value, start } = token;
      tokens?.push({ kind, value, start, end });
    }
    return token;
  };
  const error = (hint: string, t = peek()) => failQuery('syntax', t?.start ?? q.length, t?.end ?? q.length, hint);
  const fieldName = (t: QuerySyntaxToken) => queryFieldName(q.slice(t.start, t.end), t.value);

  function value(joinColons = true, record = false): QuerySyntaxToken {
    const t = peek(record);
    if (!t || !['value', 'regex'].includes(t.kind)) return error(record ? RECORD_HINT : 'Expected value', t);
    take();
    if (joinColons && !record) {
      let afterColon = false;
      for (let next = peek(); next?.start === t.end; next = peek()) {
        if (next.kind !== ':' && !(afterColon && next.kind === 'value')) break;
        t.value += next.value;
        t.wildcard = next.wildcard;
        t.end = next.end;
        afterColon = next.kind === ':';
        take();
      }
    }
    return t;
  }

  function fieldValue(field: string, depth: number): FieldValue {
    const record = field === 'record';
    const t = peek(record);
    if (!t) return error(record ? RECORD_HINT : 'Expected field value');
    if (record && ['>', '>=', '<', '<=', '[', '{'].includes(t.kind)) failQuery('type', t.start, t.end, RECORD_HINT);
    if (['>', '>=', '<', '<='].includes(t.kind)) {
      take();
      return { kind: 'compare', op: t.kind, token: value() };
    }
    if (t.kind === '[' || t.kind === '{') {
      take();
      const lower = value();
      if (peek()?.kind !== 'TO') error('Expected TO');
      take();
      const upper = value();
      const close = peek();
      if (!close || ![']', '}'].includes(close.kind)) return error('Expected closing range bracket');
      take();
      return { kind: 'range', open: t.kind, close: close.kind, lower, upper };
    }
    if (t.kind === '(') {
      checkDepth(depth, t);
      take();
      const members = [value(true, record)];
      while (peek()?.kind === 'OR') {
        take();
        members.push(value(true, record));
      }
      if (peek()?.kind !== ')') error('Expected closing value group parenthesis');
      take();
      return { kind: 'group', members };
    }
    return { kind: 'value', token: value(true, record) };
  }

  function checkDepth(depth: number, t: QuerySyntaxToken) {
    if (depth >= 16) failQuery('too_complex', t.start, t.end, 'Query exceeds 16 nesting levels');
  }

  function atom(depth: number): QueryAtom {
    const t = peek();
    if (!t) return error('Expected term');
    const { start } = t;
    if (t.kind === 'NOT') {
      take();
      const operand = atom(depth);
      return { kind: 'not', start, end, operand };
    }
    if (t.kind === '(') {
      checkDepth(depth, t);
      take();
      const expression = disjunction(depth + 1);
      if (peek()?.kind !== ')') error('Expected closing parenthesis');
      take();
      return { kind: 'group', start, end, expression };
    }
    const key = value(false);
    if (peek()?.kind !== ':') return { kind: 'text', start, end, token: key };
    take();
    const field = fieldName(key);
    const valueStart = peek(field === 'record')?.start ?? q.length;
    if (field === '_exists_') {
      const token = value(false);
      return { kind: 'field', start, end, field: fieldName(token), key, valueStart, value: { kind: 'presence', token } };
    }
    const term = fieldValue(field, depth);
    return { kind: 'field', start, end, field, key, valueStart, value: term };
  }

  function conjunction(depth: number) {
    const parts = [{ atom: atom(depth), explicitAnd: false }];
    while (peek() && !['OR', ')'].includes(peek()?.kind ?? '')) {
      const explicitAnd = peek()?.kind === 'AND';
      if (explicitAnd) take();
      parts.push({ atom: atom(depth), explicitAnd });
    }
    return parts;
  }

  function disjunction(depth: number): QueryExpression {
    const parts = [conjunction(depth)];
    while (peek()?.kind === 'OR') {
      take();
      parts.push(conjunction(depth));
    }
    return parts;
  }

  const expression = peek() ? disjunction(0) : [];
  if (peek()) error('Unexpected token');
  return expression;
}
