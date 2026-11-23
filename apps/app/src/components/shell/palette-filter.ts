import type { EntityKind } from '@logbird/contracts';
import { defaultFilter } from '@logbird/ui/components/ui/command';

/**
 * A palette row's value for a row that carries text from the reader or the server (what was typed, an id, a name):
 * its group, then the parts as JSON. Rows of different groups never share a value, and neither do two rows of one
 * group, whatever the text holds (`entity:actor:sam` typed, an id with spaces or colons). Fixed labels ("API keys")
 * never contain `:[`, so they never collide with one either.
 */
export const paletteValue = (group: 'entity' | 'jump' | 'support' | 'notice', ...parts: string[]) => `${group}:${JSON.stringify(parts)}`;

/**
 * A row named by text the reader types (a saved view's or a project's name), kept apart from a namesake by a key they
 * never type (its id). cmdk scores it on its group and name only, as `view Sample`, so the id adds no stray matches.
 */
export const paletteKeyedValue = (group: 'view' | 'project', name: string, key: string) => `${group}#${JSON.stringify([name, key])}`;
const KEYED = /^(view|project)#(\[.*\])$/s;

/** An entity row's palette value. */
export const paletteEntityValue = (e: { kind: EntityKind; id: string }) => paletteValue('entity', e.kind, e.id);

const ENTITY = 'entity:[';
/** Jump to rows and notices are built from what was typed, in the order they should be read: never re-sorted or dropped. */
const FIXED = ['jump:[', 'notice:['];

/**
 * The palette's filter. Entity rows were ranked by the server (exact id, id prefix, name prefix, …) for the text as
 * looked up, so cmdk must neither drop nor re-sort them: every entity row gets one shared score (how well the best of
 * them matches what is typed, never zero), so they stay together in the server's order and their group ranks against
 * the others as before. Jump to rows and notices keep the order they are written in. Saved views and projects are
 * scored on their name. Every other row is scored by cmdk as usual.
 */
export function paletteFilter(entities: readonly { id: string; name: string }[], search: string) {
  const typed = search.trim();
  const entityScore = Math.max(0.01, ...entities.map((e) => defaultFilter(`${e.name} ${e.id}`, typed)));
  return (value: string, query: string, keywords?: string[]) => {
    if (value.startsWith(ENTITY)) return entityScore;
    if (FIXED.some((p) => value.startsWith(p))) return 1;
    const keyed = KEYED.exec(value);
    if (keyed) return defaultFilter(`${keyed[1]} ${(JSON.parse(keyed[2] ?? '[]') as string[])[0] ?? ''}`, query, keywords);
    return defaultFilter(value, query, keywords);
  };
}
