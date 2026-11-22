import { WORKSPACE_ACTIVITY_CATEGORIES } from '@logbird/contracts';
import { andQuery, canonicalField, hasTopLevelOr, type QueryToken, tokenize } from './query-language';

/**
 * Workspace activity's search box and area chips share one `q`. A chip stands for exactly one thing: a positive
 * `category:<value>` term that constrains the whole query (top level, not negated, not inside a group, no top-level OR)
 * with a value from the chip catalogue. Anything else (`-category:auth`, `NOT (category:auth)`,
 * `category:auth OR category:member`, an unknown category) stays in the search box as written. Building the query back
 * from the chip and the box gives the same query, so opening a bookmark never rewrites it.
 */

const CATALOGUE = new Set<string>(WORKSPACE_ACTIVITY_CATEGORIES.map(([value]) => value));

/** The term a chip stands for, if the query has one (see above). */
function chipToken(q: string): QueryToken | undefined {
  if (hasTopLevelOr(q)) return undefined;
  const tokens = tokenize(q);
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as QueryToken;
    if (t.kind === 'paren') depth += t.raw === ')' ? -1 : 1;
    if (depth !== 0 || t.kind !== 'field' || t.negated) continue;
    if (canonicalField(t.field ?? '') !== 'category' || (t.valueKind !== 'plain' && t.valueKind !== 'quoted')) continue;
    let j = i - 1;
    while (j >= 0 && tokens[j]?.kind === 'space') j -= 1;
    if (tokens[j]?.kind === 'operator' && tokens[j]?.raw === 'NOT') continue;
    if (t.value !== undefined && CATALOGUE.has(t.value)) return t;
  }
  return undefined;
}

/** The area chip a query selects, if any. */
export function activityChip(q: string): string | undefined {
  return chipToken(q)?.value;
}

/** What the search box shows: the query without the chip's own term, cut out by its exact source span. */
export function activityFreeText(q: string): string {
  const t = chipToken(q);
  if (!t) return q.trim();
  const left = q.slice(0, t.start).replace(/\s+$/, '');
  const right = q.slice(t.end).replace(/^\s+/, '');
  return left && right ? `${left} ${right}` : `${left}${right}`.trim();
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
