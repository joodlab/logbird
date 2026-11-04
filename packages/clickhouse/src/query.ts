export type Term = { field: string; value: string; negate: boolean };
export const columns: Record<string, string> = {
  id: 'event_id',
  action: 'action',
  category: 'category',
  outcome: 'outcome',
  severity: 'severity',
  env: 'environment',
  environment: 'environment',
  actor: 'actor_id',
  'actor.id': 'actor_id',
  'actor.type': 'actor_type',
  'actor.name': 'actor_name',
  impersonator: 'impersonator_id',
  'actor.email': 'actor_email',
  parent: 'parent_event_id',
  'tenant.name': 'tenant_name',
  'executor.name': 'executor_name',
  job: 'job_id',
  tenant: 'tenant_id',
  executor: 'executor_id',
  'executor.type': 'executor_type',
  target: 'target_ids',
  'target.type': 'target_types',
  operation: 'operation_id',
  request: 'request_id',
  trace: 'trace_id',
  source: 'source',
};
type Token = Term | 'OR' | '(' | ')';
export function parseQuery(q = ''): Token[] {
  if (new TextEncoder().encode(q).length > 4096) throw new Error('Query exceeds 4096 bytes');
  const terms: Token[] = [];
  let termCount = 0;
  let token = '',
    quoted = false,
    escaped = false,
    fieldColon = -1,
    hadQuotes = false;
  const push = () => {
    if (!token) return;
    const negate = token.startsWith('-');
    const body = negate ? token.slice(1) : token;
    if (!hadQuotes && body === 'OR') {
      terms.push('OR');
      token = '';
      fieldColon = -1;
      return;
    }
    const colon = fieldColon - (negate ? 1 : 0);
    terms.push({ field: colon > 0 ? body.slice(0, colon) : '', value: colon > 0 ? body.slice(colon + 1) : body, negate });
    if (++termCount > 64) throw new Error('Query exceeds 64 terms');
    token = '';
    fieldColon = -1;
    hadQuotes = false;
  };
  for (const c of q) {
    if (escaped) {
      token += c;
      escaped = false;
    } else if (c === '\\' && quoted) escaped = true;
    else if (c === '"') {
      quoted = !quoted;
      hadQuotes = true;
    } else if (/\s/.test(c) && !quoted) push();
    else {
      if (!quoted && (c === '(' || c === ')')) {
        push();
        terms.push(c);
        continue;
      }
      if (c === ':' && !quoted && fieldColon < 0) fieldColon = token.length;
      token += c;
    }
  }
  if (quoted || escaped) throw new Error('Unterminated quoted query');
  push();
  booleanExpression(terms, () => '1');
  return terms;
}
export function compileQuery(q: string | Token[] = '') {
  const terms = typeof q === 'string' ? parseQuery(q) : q;
  const params: Record<string, string> = {};
  let termIndex = 0;
  const sql = booleanExpression(terms, (t) => {
    const i = termIndex++;
    const key = `q${i}`,
      wildcard = t.value.endsWith('*');
    params[key] = wildcard ? t.value.slice(0, -1) : t.value;
    const column = Object.hasOwn(columns, t.field) ? columns[t.field] : undefined;
    let expression: string;
    if (!t.field)
      expression = /^[\p{L}\p{N}]+$/u.test(t.value)
        ? `hasToken(search_text, lowerUTF8({${key}:String}))`
        : `position(search_text, lowerUTF8({${key}:String})) > 0`;
    else {
      let lhs = column;
      if (!lhs) {
        params[`${key}k`] = t.field.replace(/^attr\./, '');
        lhs = `attributes[{${key}k:String}]`;
      }
      expression =
        lhs === 'target_ids' || lhs === 'target_types'
          ? `arrayExists(x -> ${wildcard ? `startsWith(x, {${key}:String})` : `x = {${key}:String}`}, ${lhs})`
          : wildcard
            ? `startsWith(${lhs}, {${key}:String})`
            : `${lhs} = {${key}:String}`;
      if (!column)
        expression = wildcard
          ? `mapContains(attributes,{${key}k:String}) AND (${expression})`
          : `has(attribute_items,concat(toString(length({${key}k:String})),':',{${key}k:String},{${key}:String}))`;
    }
    return t.negate ? `NOT (${expression})` : `(${expression})`;
  });
  return { sql, params };
}

// Recursive descent: adjacency binds more tightly than OR. Values never become SQL.
function booleanExpression(tokens: Token[], compile: (term: Term) => string): string {
  let index = 0;
  function atom(depth: number): string {
    const token = tokens[index++];
    if (token === '(') {
      if (depth >= 16) throw new Error('Query exceeds 16 nesting levels');
      const value = disjunction(depth + 1);
      if (tokens[index++] !== ')') throw new Error('Invalid query syntax: missing closing parenthesis');
      return `(${value})`;
    }
    if (!token || typeof token === 'string') throw new Error('Invalid query syntax: expected term');
    return compile(token);
  }
  function conjunction(depth: number): string {
    const parts = [atom(depth)];
    while (index < tokens.length && tokens[index] !== 'OR' && tokens[index] !== ')') parts.push(atom(depth));
    return parts.join(' AND ');
  }
  function disjunction(depth: number): string {
    const parts = [conjunction(depth)];
    while (tokens[index] === 'OR') {
      index++;
      parts.push(conjunction(depth));
    }
    return parts.length > 1 ? `(${parts.join(' OR ')})` : (parts[0] ?? '1');
  }
  if (!tokens.length) return '1';
  const result = disjunction(0);
  if (index !== tokens.length) throw new Error('Invalid query syntax: unexpected parenthesis');
  return result;
}
