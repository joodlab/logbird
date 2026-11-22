import { andQuery, canonicalField, fieldTermsWithPolarity, formatTerm, removeTerm } from './query-language';

/**
 * Workspace activity's search box and area chips share one `q`. The chip is the query's positive `category:` term; the
 * search box holds everything else, including negated categories (`-category:auth` is a filter the reader wrote, not a
 * chip). Building a query back from the chip and the box gives the same query, so opening a bookmark never rewrites it.
 */

/** The area chip a query selects: its first positive `category:` term, if any. */
export function activityChip(q: string): string | undefined {
  return fieldTermsWithPolarity(q).find(({ token, negated }) => !negated && canonicalField(token.field ?? '') === 'category')?.token.value;
}

/** What the search box shows: the query without the chip's own term. */
export function activityFreeText(q: string): string {
  const chip = activityChip(q);
  return chip ? removeTerm(q, 'category', chip, false) : q.trim();
}

/** The query for a chip and the search box's text. */
export function activityQuery(chip: string | undefined, text: string): string {
  return andQuery(chip ? formatTerm('category', chip) : '', text.trim());
}

/** Toggle an area chip: select it (replacing another positive chip) or clear it, keeping negated categories. */
export function toggleActivityChip(q: string, value: string): string {
  const chip = activityChip(q);
  const text = activityFreeText(q);
  return activityQuery(chip === value ? undefined : value, text);
}
