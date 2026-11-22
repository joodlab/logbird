/**
 * Placeholder data, as a class. Project queries keep the previous answer while a new key loads
 * (`keepPreviousInProject`): that answer belongs to another range, search, entity or page. It must never render as the
 * current one: no counts, rows, names or charts labelled with the new key. Components never read `query.data` of a
 * project query directly: they read `current(query)`, or `shownDimmed(query)` where the previous answer is shown on
 * purpose, dimmed and marked busy while `query.isPlaceholderData` (the entity directory's search-as-you-type rows).
 * `current.test.tsx` enforces this for every query that has placeholder data.
 */

/** The query's data only when it answers the current key; undefined while a placeholder (another key's answer) shows. */
export function current<T>(query: { data: T | undefined; isPlaceholderData: boolean }): T | undefined {
  return query.isPlaceholderData ? undefined : query.data;
}

/**
 * The query's data including a placeholder: only for a component that shows the previous answer dimmed and marked busy
 * while `query.isPlaceholderData`. Everything else reads `current()`.
 */
export function shownDimmed<T>(query: { data: T | undefined }): T | undefined {
  return query.data;
}

/** True while nothing current is available yet: the first load, or a placeholder from another key. */
export function awaiting(query: { isPending: boolean; isPlaceholderData: boolean }): boolean {
  return query.isPending || query.isPlaceholderData;
}
