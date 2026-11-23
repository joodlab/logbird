import type { EntityKind } from '@logbird/contracts';
import { defaultFilter } from '@logbird/ui/components/ui/command';

/**
 * A palette row's value for a row that carries text from the reader or the server (what was typed, an id, a name):
 * its group, then the parts as JSON. Rows of different groups never share a value, and neither do two rows of one
 * group, whatever the text holds (`entity:actor:sam` typed, an id with spaces or colons). Fixed labels ("API keys")
 * never contain `:[`, so they never collide with one either.
 */
export const paletteValue = (group: 'entity' | 'jump' | 'support' | 'notice', ...parts: string[]) => `${group}:${JSON.stringify(parts)}`;

/** An entity row's palette value. */
export const paletteEntityValue = (e: { kind: EntityKind; id: string }) => paletteValue('entity', e.kind, e.id);

const ENTITY = 'entity:[';
/** Jump to rows and notices are built from what was typed, in the order they should be read: never re-sorted or dropped. */
const FIXED = ['jump:[', 'notice:['];

/**
 * The palette's filter. Entity rows were ranked by the server (exact id, id prefix, name prefix, …) for the text as
 * looked up, so cmdk must neither drop nor re-sort them: every entity row gets one shared score (how well the best of
 * them matches what is typed, never zero), so they stay together in the server's order and their group ranks against
 * the others as before. Jump to rows and notices keep the order they are written in. Every other row is scored by cmdk
 * as usual.
 */
export function paletteFilter(entities: readonly { id: string; name: string }[], search: string) {
  const typed = search.trim();
  const entityScore = Math.max(0.01, ...entities.map((e) => defaultFilter(`${e.name} ${e.id}`, typed)));
  return (value: string, query: string, keywords?: string[]) =>
    value.startsWith(ENTITY) ? entityScore : FIXED.some((p) => value.startsWith(p)) ? 1 : defaultFilter(value, query, keywords);
}
