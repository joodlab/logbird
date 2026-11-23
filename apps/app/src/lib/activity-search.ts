import { parseQueryExpression, type QueryAtom, QueryError, WORKSPACE_ACTIVITY_CATEGORIES } from '@logbird/contracts';
import { andQuery, canonicalField, fieldTerms, hasTopLevelOr, type QueryToken, tokenize } from './query-language';

/**
 * Workspace activity's search box and area chips share one `q`. A chip stands for exactly one thing: a positive
 * `category:<value>` term that constrains the whole query (top level, not negated, not inside a group, no top-level OR)
 * with a value from the chip catalogue. Anything else (`-category:auth`, `NOT (category:auth)`,
 * `category:auth OR category:member`, an unknown category) stays in the search box as written. Building the query back
 * from the chip and the box gives the same query, so opening a bookmark never rewrites it.
 */

const CATALOGUE = new Set<string>(WORKSPACE_ACTIVITY_CATEGORIES.map(([value]) => value));

/**
 * The term a chip stands for, if the query has one (see above). The server's parse must see the same top-level term over
 * the same text: `"category":"auth":other` is the value `auth:other` to it, so no chip, and the query stays in the box as
 * written. (The page writes a query only when the reader edits the box or toggles a chip, never on its own.)
 */
function chipToken(q: string): QueryToken | undefined {
  if (hasTopLevelOr(q)) return undefined;
  const server = fieldTerms(q, true);
  const tokens = tokenize(q);
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as QueryToken;
    if (t.kind === 'paren') depth += t.raw === ')' ? -1 : 1;
    if (depth !== 0 || t.kind !== 'field' || t.negated) continue;
    if (canonicalField(t.field ?? '') !== 'category' || (t.valueKind !== 'plain' && t.valueKind !== 'quoted')) continue;
    const before = tokens[previousNonSpace(tokens, i)];
    // `NOT category:x` and `- category:x` (a standalone minus, which the server reads as NOT) negate the term.
    if ((before?.kind === 'operator' && before.raw === 'NOT') || before?.raw === '-') continue;
    if (t.value === undefined || !CATALOGUE.has(t.value)) continue;
    if (!server.some((x) => x.start === t.start && x.end === t.end && !x.negated && x.value === t.value && x.field === t.field)) continue;
    // Moving the chip out must not change what any other term means (`"category":"auth"-action:booked` would turn the
    // attribute `-action` into NOT action once its neighbour is gone): otherwise there is no chip.
    if (meaning(activityQuery(t.value, freeTextWithout(q, t))) === meaning(q)) return t;
  }
  return undefined;
}

/**
 * What a query means to the server, order aside: each term's field, value and polarity, and each free-text word. Two
 * queries with the same meaning here filter the same events when they ANDed the same terms at the top level.
 */
function meaning(q: string): string | null {
  const parts: string[] = [];
  const visit = (node: QueryAtom, negated: boolean) => {
    if (node.kind === 'not') visit(node.operand, !negated);
    else if (node.kind === 'group') for (const branch of node.expression) for (const part of branch) visit(part.atom, negated);
    else if (node.kind === 'text') parts.push(JSON.stringify(['t', node.token.kind, node.token.value, negated]));
    else parts.push(JSON.stringify(['f', node.field, node.value, negated], (key, v) => (key === 'start' || key === 'end' ? undefined : v)));
  };
  try {
    const expression = parseQueryExpression(q);
    for (const branch of expression) for (const part of branch) visit(part.atom, false);
    return `${expression.length}|${parts.sort().join('|')}`;
  } catch (error) {
    if (error instanceof QueryError) return null;
    throw error;
  }
}

/** The area chip a query selects, if any. */
export function activityChip(q: string): string | undefined {
  return chipToken(q)?.value;
}

/** What the search box shows: the query without the chip's own term, cut out by its exact source span. */
export function activityFreeText(q: string): string {
  const t = chipToken(q);
  return t ? freeTextWithout(q, t) : q.trim();
}

function freeTextWithout(q: string, t: QueryToken): string {
  const tokens = tokenize(q);
  const at = tokens.findIndex((x) => x.start === t.start && x.end === t.end);
  // An explicit `AND` joining the term to its neighbour goes with it (`revoked AND category:auth` → `revoked`).
  const prev = tokens[previousNonSpace(tokens, at)];
  const next = tokens[nextNonSpace(tokens, at)];
  const isAnd = (x: QueryToken | undefined) => x?.kind === 'operator' && x.raw === 'AND';
  const start = isAnd(prev) ? (prev as QueryToken).start : t.start;
  const end = !isAnd(prev) && isAnd(next) ? (next as QueryToken).end : t.end;
  const left = q.slice(0, start).replace(/\s+$/, '');
  const right = q.slice(end).replace(/^\s+/, '');
  return left && right ? `${left} ${right}` : `${left}${right}`.trim();
}

function previousNonSpace(tokens: QueryToken[], i: number): number {
  let j = i - 1;
  while (j >= 0 && tokens[j]?.kind === 'space') j -= 1;
  return j;
}
function nextNonSpace(tokens: QueryToken[], i: number): number {
  let j = i + 1;
  while (j < tokens.length && tokens[j]?.kind === 'space') j += 1;
  return j;
}

/** The query for a chip and the search box's text. */
export function activityQuery(chip: string | undefined, text: string): string {
  return andQuery(chip ? `category:${chip}` : '', text.trim());
}

/** Toggle an area chip on a query: select it (replacing the current chip) or clear it, leaving every other term as is. */
export function toggleActivityChip(q: string, value: string): string {
  const chip = activityChip(q);
  return activityQuery(chip === value ? undefined : value, activityFreeText(q));
}
