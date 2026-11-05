import { SQL_ALLOWED_COLUMNS, SQL_ALLOWED_FUNCTIONS } from '@trailmark/contracts';
import type { ClickHouseClient } from './client';
import { QueryError } from './query';

const prefix =
  'SELECT event_id FROM trailmark.events WHERE project_id = {p:String} AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)} AND (';
const parameters = { p: '__validation__', from: '2000-01-01 00:00:00', to: '2000-01-02 00:00:00' };
type Node = { text: string; children: Node[] };
function reject(reason: 'not_allowed' | 'unknown_field' | 'too_complex' | 'syntax', q: string, hint: string, start = 0, end = q.length): never {
  throw new QueryError(hint, { lang: 'sql', reason, start, end, hint });
}
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
    if (!(SQL_ALLOWED_COLUMNS as readonly string[]).includes(name) && !scope.has(name)) reject('unknown_field', q, `Column ${name} is not allowed`);
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
  if (!node.text.startsWith('Function ')) reject('not_allowed', q, 'Only boolean expressions, allowed columns and pure functions are supported');
  const name = node.text.slice(9);
  if (!(SQL_ALLOWED_FUNCTIONS as readonly string[]).includes(name)) reject('not_allowed', q, `Function ${name} is not allowed`);
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
  const result = await ch.query({ query: `EXPLAIN AST ${prefix}${q})`, query_params: parameters, format: 'TabSeparatedRaw' });
  return parseTree(await result.text());
}
export async function validateSql(ch: ClickHouseClient, q = ''): Promise<string> {
  if (Buffer.byteLength(q) > 4096) reject('too_complex', q, 'SQL exceeds 4096 bytes');
  if (/;|--|#|\/\*|\{[^}]*:[^}]*\}/.test(q)) reject('not_allowed', q, 'Comments, semicolons and query parameters are not allowed');
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
      const position = Number(message.match(/position (\d+)/)?.[1] ?? 1) - 1;
      const bytes = Buffer.from(`EXPLAIN AST ${prefix}${expression}`);
      const start = Math.max(0, Math.min(q.length, bytes.subarray(0, position).toString('utf8').length - prefix.length - 12));
      reject('syntax', q, 'Check the SQL expression syntax', start, Math.min(q.length, start + 1));
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
