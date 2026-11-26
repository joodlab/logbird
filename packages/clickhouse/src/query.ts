import {
  CHANGES_FIELD_HINT,
  decodeRecordPair,
  failQuery as fail,
  isUnknownChangesKey,
  type ParsedQueryToken,
  parseQueryExpression,
  QUERY_FIELDS,
  type QueryAtom,
  type QueryExpression,
  type QuerySyntaxToken,
  RECORD_HINT,
  REQUEST_LIMITS,
} from '@logbird/contracts';

import { re2Problem } from './re2';
import { pairedTargetSql } from './target-pair';

export { QueryError } from '@logbird/contracts';
export const columns: Record<string, string> = Object.fromEntries(
  QUERY_FIELDS.flatMap(({ aliases, column, key }) => (column ? [key, ...(aliases ?? [])].map((field) => [field, column]) : [])),
);

/** Match both selectors on one target. The index keeps bindings distinct within a query. */
export function recordTargetPredicate(type: string, id: string, index?: number) {
  const typeParam = `recordType${index ?? ''}`;
  const idParam = `recordId${index ?? ''}`;
  return {
    sql: pairedTargetSql(typeParam, idParam),
    params: { [typeParam]: type, [idParam]: id },
  };
}

export type Term = { field: string; value: string; negate: boolean; start: number; end: number };
export type CompileOptions = {
  /**
   * Webhook filters only. `now` in relative times is each event's `received_at` instead of one clock, so a filter selects
   * the same events whenever and however often discovery runs, and its offset range does not depend on the scan time.
   * Regexes are checked against RE2's syntax instead of JavaScript's, refusing only what RE2 is known to reject.
   * Explorer, search, facets and exports never pass this, so they keep their existing behaviour.
   */
  webhook?: boolean;
};
/** Compile options for webhook filters: discovery, the send-time recheck, and create and PATCH validation. */
export const WEBHOOK_FILTER: CompileOptions = { webhook: true };
/** Relative offsets in webhook filters, fixed independently of any clock: about 100 years either way. */
export const WEBHOOK_RELATIVE_LIMIT_MS = 36_500 * 86_400_000;

// Parse with the same grammar used by the console. All data values are bound as parameters.
function compile(q: string, now: number, tokens?: ParsedQueryToken[], options: CompileOptions = {}) {
  const params: Record<string, string | number> = {};
  let terms = 0;
  let parameter = 0;
  let recordIndex = 0;
  const bind = (value: string | number, type = 'String') => {
    const key = `q${parameter++}`;
    params[key] = value;
    return `{${key}:${type}}`;
  };
  function predicate(
    field: string,
    token: Omit<QuerySyntaxToken, 'kind'> & { kind: QuerySyntaxToken['kind'] | 'presence' },
    operator = '=',
    countTerm = true,
  ): string {
    if (countTerm && ++terms > REQUEST_LIMITS.queryTerms)
      fail('too_complex', token.start, token.end, `Query exceeds ${REQUEST_LIMITS.queryTerms} terms`);
    if (field === 'record') {
      if (token.kind === 'presence' || (token.wildcard && token.value === '*' && q[token.start] !== '"')) return 'notEmpty(target_ids)';
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
    const presence = token.wildcard && token.value === '*';
    // `field:>*` is a comparison, not presence: refused like any comparison on a field that is not a number or date,
    // and on any field (attributes included) without a value to compare with. Open bounds inside ranges never get here.
    if (operator !== '=' && info && !['number', 'date'].includes(info.type))
      fail('type', token.start, token.end, `${field} does not support comparisons`);
    if (operator !== '=' && presence) fail('type', token.start, token.end, `A comparison needs a value; use ${field}:* for presence`);
    if (numeric && !presence) {
      if (info && !['number', 'date'].includes(info.type)) fail('type', token.start, token.end, `${field} does not support comparisons`);
      const date = info?.type === 'date' || (!info && /^(?:\d{4}-\d{2}-\d{2}|now(?:$|[-+/]))/.test(token.value));
      if (date) {
        let raw = token.value;
        let relativeSql: string | undefined;
        if (raw.startsWith('now')) {
          const relative = /^now(?:([+-])(\d+)([smhdw]))?(\/d)?$/.exec(raw);
          if (!relative) fail('type', token.start, token.end, 'Use now, now-7d or now/d (s/m/h/d/w)');
          const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
          const offset = (relative[1] === '-' ? -1 : 1) * Number(relative[2] ?? 0) * units[relative[3] ?? 's']!;
          if (options.webhook) {
            // Measured from each arrival, so the accepted range must not depend on when the filter is compiled.
            if (!(Math.abs(offset) <= WEBHOOK_RELATIVE_LIMIT_MS)) fail('type', token.start, token.end, 'Relative date is out of range');
            const shifted = `received_at + toIntervalMillisecond(${bind(offset, 'Int64')})`;
            relativeSql = relative[4] ? `toDateTime64(toStartOfDay(${shifted}, 'UTC'), 3, 'UTC')` : shifted;
            raw = new Date(0).toISOString();
          } else {
            const instant = now + offset;
            const rounded = relative[4] ? Math.floor(instant / 86_400_000) * 86_400_000 : instant;
            if (!Number.isFinite(rounded) || Math.abs(rounded) > 8.64e15) fail('type', token.start, token.end, 'Relative date is out of range');
            raw = new Date(rounded).toISOString();
          }
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
        return `${expr} ${operator} ${relativeSql ?? `parseDateTime64BestEffort(${bind(d.toISOString())},3,'UTC')`}`;
      }
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token.value) || !Number.isFinite(Number(token.value)))
        fail('type', token.start, token.end, `${field} is a number`);
      if (!col) expr = `toFloat64OrNull(${expr})`;
      return `${expr} ${operator} ${bind(Number(token.value), 'Float64')}`;
    }
    let test: string;
    const x = info?.type === 'array' ? 'x' : expr;
    if (token.kind === 'regex') {
      if (options.webhook) {
        // ClickHouse runs the pattern with RE2. Refuse what RE2 is known to reject; anything else is left to RE2.
        const problem = re2Problem(token.value);
        if (problem) fail('type', token.start, token.end, problem);
      } else
        try {
          const pattern = new RegExp(token.value);
          if ([...pattern.source.matchAll(/(?<!\\)\{(\d+)(?:,(\d*))?\}/g)].some((m) => Number(m[1]) > 1000 || Number(m[2] ?? 0) > 1000))
            throw new Error('RE2 repetitions are limited to 1000');
          if (/\(\?[=!<]|\\[1-9]|\(\?>/.test(token.value)) throw new Error('Unsupported RE2 construct');
        } catch {
          fail('type', token.start, token.end, 'Use a valid RE2 regex without lookaround or backreferences');
        }
      test = `match(${x}, ${bind(`^(?:${token.value})$`)})`;
    } else if (presence) test = info?.type === 'number' || info?.type === 'date' ? '1' : `${x} != ''`;
    else if (token.wildcard) test = `startsWith(${x}, ${bind(token.value.slice(0, -1))})`;
    else test = `${x} = ${bind(token.value)}`;
    if (info?.type === 'array') return `arrayExists(x -> ${test}, ${expr})`;
    if (!col) return `mapContains(attributes,${attrParameter}) AND (${test})`;
    return test;
  }
  function fieldValue(atom: Extract<QueryAtom, { kind: 'field' }>): string {
    const { field, value } = atom;
    // `changes` is never flattened into attributes: an unknown changes.* key would silently match nothing.
    if (isUnknownChangesKey(field)) fail('unknown_field', atom.start, atom.end, `Unknown field ${field}. ${CHANGES_FIELD_HINT}`);
    switch (value.kind) {
      case 'value':
        return predicate(field, value.token);
      case 'presence':
        return predicate(field, { ...value.token, kind: field === 'record' ? 'presence' : value.token.kind, value: '*', wildcard: true });
      case 'compare':
        return predicate(field, value.token, value.op);
      case 'range': {
        const { lower, upper, open, close } = value;
        const parts: string[] = [];
        const openLower = lower.wildcard && lower.value === '*';
        const openUpper = upper.wildcard && upper.value === '*';
        if (!openLower) parts.push(predicate(field, lower, open === '[' ? '>=' : '>'));
        if (!openUpper) parts.push(predicate(field, upper, close === ']' ? '<=' : '<', openLower));
        return parts.length ? parts.join(' AND ') : predicate(field, lower);
      }
      case 'group': {
        const info = QUERY_FIELDS.find((f) => f.key === field || f.aliases?.includes(field));
        const { members } = value;
        if (info && ['string', 'text'].includes(info.type) && members.every((m) => m.kind === 'value' && !m.wildcard)) {
          terms += members.length;
          if (terms > REQUEST_LIMITS.queryTerms) fail('too_complex', atom.valueStart, atom.end, `Query exceeds ${REQUEST_LIMITS.queryTerms} terms`);
          return `${info.column} IN (${members.map((m) => bind(m.value)).join(',')})`;
        }
        return members.map((m) => `(${predicate(field, m)})`).join(' OR ');
      }
      default:
        return value satisfies never;
    }
  }

  function atom(node: QueryAtom): string {
    switch (node.kind) {
      case 'not':
        return `NOT (${atom(node.operand)})`;
      case 'group':
        return `(${disjunction(node.expression)})`;
      case 'field':
        return `(${fieldValue(node)})`;
      case 'text': {
        const v = node.token;
        if (++terms > REQUEST_LIMITS.queryTerms) fail('too_complex', v.start, v.end, `Query exceeds ${REQUEST_LIMITS.queryTerms} terms`);
        if (v.kind === 'regex') return `(${predicate('description', v, '=', false)})`;
        const p = bind(v.value);
        return /^[\p{L}\p{N}]+$/u.test(v.value) ? `(hasToken(search_text, lowerUTF8(${p})))` : `(position(search_text, lowerUTF8(${p})) > 0)`;
      }
      default:
        return node satisfies never;
    }
  }

  function disjunction(expression: QueryExpression): string {
    const parts = expression.map((branch) => branch.map((term) => atom(term.atom)).join(' AND '));
    return parts.length > 1 ? `(${parts.join(' OR ')})` : (parts[0] ?? '1');
  }

  return { sql: disjunction(parseQueryExpression(q, tokens)), params };
}
export function compileQuery(q = '', now = Date.now(), options?: CompileOptions) {
  return compile(q, now, undefined, options);
}
export function parseQuery(q = '') {
  const tokens: ParsedQueryToken[] = [];
  compile(q, Date.now(), tokens);
  return tokens;
}
