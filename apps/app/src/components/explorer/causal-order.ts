import type { AuditEvent } from '@logbird/contracts';

type TimelineEvent = Pick<AuditEvent, 'id' | 'timestamp' | 'context'>;

/**
 * Keep time and page boundaries intact. Within each tie, visit an event's prerequisites before moving on in
 * API order. A malformed cycle cannot be ordered, so ignore the back edge and keep every event in the result.
 */
export function causalPageOrder<T extends TimelineEvent>(events: readonly T[], direction: 'asc' | 'desc'): T[] {
  const ordered: T[] = [];
  let start = 0;
  while (start < events.length) {
    const first = events[start] as T;
    let end = start + 1;
    while (events[end]?.timestamp === first.timestamp) end += 1;
    if (end === start + 1) ordered.push(first);
    else {
      const group = events.slice(start, end);
      const byId = new Map(group.map((event) => [event.id, event]));
      const prerequisites = new Map<string, T[]>();
      for (const child of group) {
        const parent = byId.get(child.context.parentEventId);
        if (!parent || parent === child) continue;
        const [from, to] = direction === 'asc' ? [child, parent] : [parent, child];
        const earlier = prerequisites.get(from.id);
        if (earlier) earlier.push(to);
        else prerequisites.set(from.id, [to]);
      }
      const visited = new Set<T>();
      const visit = (event: T) => {
        if (visited.has(event)) return;
        visited.add(event);
        for (const earlier of prerequisites.get(event.id) ?? []) visit(earlier);
        ordered.push(event);
      };
      for (const event of group) visit(event);
    }
    start = end;
  }
  return ordered;
}
