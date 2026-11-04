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
export function parseQuery(q = ''): Term[] {
  const terms: Term[] = [];
  let token = '',
    quoted = false,
    escaped = false;
  const push = () => {
    if (!token) return;
    const negate = token.startsWith('-');
    const body = negate ? token.slice(1) : token;
    const colon = body.indexOf(':');
    terms.push({ field: colon > 0 ? body.slice(0, colon) : '', value: colon > 0 ? body.slice(colon + 1) : body, negate });
    token = '';
  };
  for (const c of q) {
    if (escaped) {
      token += c;
      escaped = false;
    } else if (c === '\\' && quoted) escaped = true;
    else if (c === '"') quoted = !quoted;
    else if (/\s/.test(c) && !quoted) push();
    else token += c;
  }
  if (quoted || escaped) throw new Error('Unterminated quoted query');
  push();
  return terms;
}
export function compileQuery(q: string | Term[] = '') {
  const terms = typeof q === 'string' ? parseQuery(q) : q;
  const params: Record<string, string> = {};
  const clauses = terms.map((t, i) => {
    const key = `q${i}`,
      wildcard = t.value.endsWith('*');
    params[key] = wildcard ? t.value.slice(0, -1) : t.value;
    const column = columns[t.field];
    let expression: string;
    if (!t.field)
      expression = `positionCaseInsensitiveUTF8(concat(description,' ',actor_name,' ',tenant_name,' ',arrayStringConcat(target_names,' ')), {${key}:String}) > 0`;
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
    }
    return t.negate ? `NOT (${expression})` : `(${expression})`;
  });
  return { sql: clauses.join(' AND ') || '1', params };
}
