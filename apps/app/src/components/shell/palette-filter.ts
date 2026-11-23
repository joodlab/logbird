import type { EntityKind } from '@logbird/contracts';
import { defaultFilter } from '@logbird/ui/components/ui/command';

/** Entity rows' values start with this; no other palette row's value does (pages, views, agents, Jump to). */
const ENTITY = 'entity:';

/** An entity row's palette value: unique per row, never equal to another group's value (a saved view named alike). */
export const paletteEntityValue = (e: { kind: EntityKind; id: string }) => `${ENTITY}${e.kind}:${e.id}`;

/**
 * The palette's filter. Entity rows were ranked by the server (exact id, id prefix, name prefix, …) for the text as
 * looked up, so cmdk must neither drop nor re-sort them: every entity row gets one shared score (how well the best of
 * them matches what is typed, never zero), so they stay together in the server's order and their group ranks against
 * the others as before. Every other row is scored by cmdk as usual.
 */
export function paletteFilter(entities: readonly { id: string; name: string }[], search: string) {
  const typed = search.trim();
  const entityScore = Math.max(0.01, ...entities.map((e) => defaultFilter(`${e.name} ${e.id}`, typed)));
  return (value: string, query: string, keywords?: string[]) => (value.startsWith(ENTITY) ? entityScore : defaultFilter(value, query, keywords));
}
