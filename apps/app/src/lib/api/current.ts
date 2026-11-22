/**
 * Placeholder data, as a class. Project queries keep the previous answer while a new key loads
 * (`keepPreviousInProject`): that answer belongs to another range, search, entity or page. It must never render as the
 * current one: no counts, rows, names or charts labelled with the new key. Components read project queries through
 * these two helpers. A component may still show the previous answer, but only dimmed and marked as updating, and only
 * through `isPlaceholderData` explicitly (the Explorer's facet groups do).
 */

/** The query's data only when it answers the current key; undefined while a placeholder (another key's answer) shows. */
export function current<T>(query: { data: T | undefined; isPlaceholderData: boolean }): T | undefined {
  return query.isPlaceholderData ? undefined : query.data;
}

/** True while nothing current is available yet: the first load, or a placeholder from another key. */
export function awaiting(query: { isPending: boolean; isPlaceholderData: boolean }): boolean {
  return query.isPending || query.isPlaceholderData;
}
