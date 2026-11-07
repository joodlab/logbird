import { SQL_ALLOWED_COLUMNS, SQL_ALLOWED_FUNCTIONS } from '@logbird/contracts';
import type { ClickHouseClient } from './client';
import { QueryError } from './query';

const prefix =
  'SELECT event_id FROM logbird.events WHERE project_id = {p:String} AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)} AND (';
const parameters = { p: '__validation__', from: '2000-01-01 00:00:00', to: '2000-01-02 00:00:00' };
type Node = { text: string; children: Node[] };
type Reason = 'not_allowed' | 'unknown_field' | 'too_complex' | 'syntax';
const HINTS: Record<Reason, string> = {
  not_allowed: 'Write a boolean WHERE expression using allowed columns and pure functions only (see the SQL cheat-sheet).',
  unknown_field: "Use an events column such as action, actor_id, tenant_id, job_attempt, or attributes['key'].",
  too_complex: 'Simplify the expression: fewer nested parentheses or a shorter filter.',
  syntax: 'Check quotes, parentheses and operators near the marked position.',
};
function reject(reason: Reason, q: string, message: string, start = 0, end = q.length, hint = HINTS[reason]): never {
  throw new QueryError(message, { lang: 'sql', reason, start, end, hint });
}
/** q with the contents of single-quoted literals blanked (same length), so searches never match inside strings. */
function code(q: string) {
  return q.replace(/'(?:[^'\\]|\\[\s\S]|'')*'?/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}${m.length > 1 ? "'" : ''}`);
}
/** Span of the first occurrence of `pattern` outside string literals, or the whole expression. */
function locate(q: string, pattern: RegExp): [number, number] {
  const m = pattern.exec(code(q));
  return m ? [m.index, m.index + m[0].length] : [0, q.length];
}
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parseTree(text: string): Node {
  const roots: Node[] = [],
    stack: { depth: number; node: Node }[] = [];
  for (const line of text.trimEnd().split('\n')) {
    const depth = line.length - line.trimStart().length;
    const node = { text: line.trim().replace(/ \(children \d+\)$/, ''), children: [] as Node[] };
    while (stack.length && (stack.at(-1)?.depth ?? -1) >= depth) stack.pop();
    (stack.at(-1)?.node.children ?? roots).push(node);
    stack.push({ depth, node });
  }
  if (roots.length !== 1) throw new Error('Unexpected ClickHouse AST format');
  return roots[0]!;
}
function walk(node: Node, q: string, scope = new Set<string>(), depth = 0) {
  if (depth > 64) reject('too_complex', q, 'SQL expression exceeds 64 AST levels');
  if (node.text.startsWith('Identifier ')) {
    const name = node.text.slice(11);
    if (!(SQL_ALLOWED_COLUMNS as readonly string[]).includes(name) && !scope.has(name))
      reject('unknown_field', q, `Unknown column ${name}`, ...locate(q, new RegExp(`(?<![\\w.])${escapeRegExp(name)}(?!\\w)`)));
    if (node.children.length) reject('not_allowed', q, 'Invalid identifier');
    return;
  }
  if (node.text.startsWith('Literal ')) {
    if (node.children.length) reject('not_allowed', q, 'Invalid literal');
    return;
  }
  if (node.text === 'ExpressionList') {
    for (const child of node.children) walk(child, q, scope, depth + 1);
    return;
  }
  if (!node.text.startsWith('Function '))
    reject(
      'not_allowed',
      q,
      /Subquery|SelectWithUnionQuery|SelectQuery/.test(node.text) ? 'Subqueries are not allowed' : `${node.text.split(' ')[0]} is not allowed`,
      ...locate(q, /\b(?:select|with|union|settings|format|join)\b/i),
    );
  const name = node.text.slice(9);
  if (!(SQL_ALLOWED_FUNCTIONS as readonly string[]).includes(name))
    reject('not_allowed', q, `Function ${name}() is not allowed`, ...locate(q, new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'i')));
  if (name === 'lambda') {
    const args = node.children[0]?.children;
    const names = args?.[0]?.children[0]?.children;
    if (
      args?.length !== 2 ||
      args[0]?.text !== 'Function tuple' ||
      !names?.length ||
      names.some((n) => !/^Identifier [A-Za-z_][A-Za-z_0-9]*$/.test(n.text))
    )
      reject('not_allowed', q, 'Invalid lambda parameters');
    const nested = new Set(scope);
    for (const n of names!) nested.add(n.text.slice(11));
    walk(args[1]!, q, nested, depth + 1);
    return;
  }
  for (const child of node.children) walk(child, q, scope, depth + 1);
}
/**
 * String-aware pre-check. Outside single-quoted string literals we refuse comments, statement separators, query
 * parameters, heredoc strings and quoted identifiers. Quoted identifiers matter for safety, not just style: ClickHouse
 * unescapes them (a backslash-n inside backticks becomes a real newline), and EXPLAIN AST prints identifier names raw, so a newline inside one could forge extra
 * lines in the indentation-based tree we parse. Allowed columns never need quoting.
 */
function lexicalCheck(q: string) {
  let inString = false;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === "'") {
        if (q[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") inString = true;
    else if (c === '`' || c === '"')
      reject('not_allowed', q, 'Quoted identifiers are not supported; use plain column names and single-quoted strings', i, i + 1);
    else if (c === ';' || c === '#' || c === '$' || c === '{' || c === '}')
      reject('not_allowed', q, `"${c}" is not allowed outside string literals (no comments, separators or query parameters)`, i, i + 1);
    else if ((c === '-' && q[i + 1] === '-') || (c === '/' && q[i + 1] === '*')) reject('not_allowed', q, 'Comments are not allowed', i, i + 2);
  }
}
const caches = new WeakMap<ClickHouseClient, Map<string, number>>();
const baselines = new WeakMap<ClickHouseClient, Promise<string>>();
function extract(tree: Node): Node {
  const select = tree.children[0]?.children[0];
  const args = select?.children[2]?.children[0];
  if (
    tree.text !== 'SelectWithUnionQuery' ||
    tree.children.length !== 2 ||
    tree.children[1]?.text !== 'Identifier TabSeparatedRaw' ||
    tree.children[0]?.text !== 'ExpressionList' ||
    tree.children[0].children.length !== 1 ||
    select?.text !== 'SelectQuery' ||
    select.children.length !== 3 ||
    select.children[2]?.text !== 'Function and' ||
    args?.children.length !== 4
  )
    throw new Error('Unexpected SQL statement shape');
  return args;
}
async function explain(ch: ClickHouseClient, q: string) {
  const result = await ch.query({
    query: `EXPLAIN AST ${prefix}${q})`,
    query_params: parameters,
    clickhouse_settings: { SQL_logbird_project: parameters.p },
    format: 'TabSeparatedRaw',
  });
  return parseTree(await result.text());
}
export async function validateSql(ch: ClickHouseClient, q = ''): Promise<string> {
  if (Buffer.byteLength(q) > 4096) reject('too_complex', q, 'SQL exceeds 4096 bytes');
  lexicalCheck(q);
  const statement = /^\s*(select|with)\b/i.exec(q);
  if (statement) reject('not_allowed', q, "Enter only a WHERE expression (e.g. outcome = 'failure')", ...locate(q, /\b(?:select|with)\b/i));
  const expression = q.trim() ? q : '1';
  const cache = caches.get(ch) ?? new Map<string, number>();
  caches.set(ch, cache);
  if ((cache.get(expression) ?? 0) > Date.now()) return expression;
  let baseline = baselines.get(ch);
  if (!baseline) {
    baseline = explain(ch, '1').then((t) => {
      extract(t).children[3] = { text: 'USER', children: [] };
      return JSON.stringify(t);
    });
    baselines.set(ch, baseline);
    void baseline.catch(() => baselines.delete(ch));
  }
  let tree: Node;
  try {
    tree = await explain(ch, expression);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const kind = error && typeof error === 'object' && 'type' in error ? String(error.type) : '';
    if (/TOO_DEEP|TOO_BIG_AST|maximum pars(?:e|er) depth/i.test(message + kind)) reject('too_complex', q, 'Reduce SQL expression nesting');
    if (/SYNTAX_ERROR|Syntax error/.test(message)) {
      throw sqlSyntaxError(error, `EXPLAIN AST ${prefix}${expression})`, expression);
    }
    throw error;
  }
  let args: Node;
  try {
    args = extract(tree);
  } catch {
    return reject('not_allowed', q, 'The SQL statement must retain the project and time filters');
  }
  const user = args.children[3]!;
  args.children[3] = { text: 'USER', children: [] };
  if (JSON.stringify(tree) !== (await baseline)) reject('not_allowed', q, 'The SQL statement must retain the project and time filters');
  walk(user, q);
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(expression, Date.now() + 30_000);
  return expression;
}

/** ClickHouse positions are one-based UTF-8 byte offsets; editors use UTF-16. */
export function sqlSyntaxError(error: unknown, statement: string, expression: string) {
  const message = error instanceof Error ? error.message : '';
  const position = Number(message.match(/position (\d+)/)?.[1] ?? 1) - 1;
  const offset = statement.indexOf(expression);
  const start = Math.max(0, Math.min(expression.length, Buffer.from(statement).subarray(0, position).toString('utf8').length - Math.max(0, offset)));
  return new QueryError('Invalid SQL expression syntax', {
    lang: 'sql',
    reason: 'syntax',
    start,
    end: Math.min(expression.length, start + 1),
    hint: 'Check the SQL expression syntax',
  });
}

/** Called only after SQL validation. Resolve moving date functions once for every export page. */
export function freezeSqlClock(expression: string, clock: number) {
  const literal = "'(?:[^'\\\\]|\\\\[\\s\\S]|'')*'";
  const tokens = new RegExp(`${literal}|\\b(now64|now|today|yesterday)\\s*\\(`, 'gi');
  let end = 0;
  let sql = '';
  for (const token of expression.matchAll(tokens)) {
    if (!token[1] || token.index < end) continue;
    const args = new RegExp(`^\\s*(?:(\\d+)\\s*(?:,\\s*(${literal}))?|(${literal}))?\\s*\\)`).exec(expression.slice(token.index + token[0].length));
    if (!args || (args[1] !== undefined && token[1].toLowerCase() !== 'now64'))
      throw new QueryError('Use a literal time zone and precision for export clock functions', {
        lang: 'sql',
        reason: 'not_allowed',
        start: token.index,
        end: token.index + token[0].length,
        hint: 'Use now(), now64(3), or an explicit timestamp literal.',
      });
    const timezone = args[2] ?? args[3];
    const base = `fromUnixTimestamp64Milli({exportClockMillis:Int64}${timezone ? `,${timezone}` : ''})`;
    const fn = token[1].toLowerCase();
    const replacement =
      fn === 'now64'
        ? `toDateTime64(${base},${args[1] ?? 3}${timezone ? `,${timezone}` : ''})`
        : fn === 'now'
          ? `toDateTime(${base}${timezone ? `,${timezone}` : ''})`
          : fn === 'today'
            ? `toDate(${base})`
            : `subtractDays(toDate(${base}),1)`;
    sql += expression.slice(end, token.index) + replacement;
    end = token.index + token[0].length + args[0].length;
  }
  return { sql: sql + expression.slice(end), params: { exportClockMillis: clock } };
}
