import type { Project } from '@logbird/contracts';

/**
 * Most active first: events in the last 24 hours, then the most recent event, then name. Busy production projects
 * lead the Projects page and the switcher; idle or never-used (test) projects sink to the end instead of sitting above
 * the real ones in creation order.
 */
export function sortProjectsByActivity<T extends Pick<Project, 'name' | 'eventsLast24h' | 'lastEventAt'>>(projects: readonly T[]): T[] {
  return [...projects].sort(
    (a, b) =>
      b.eventsLast24h - a.eventsLast24h ||
      (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? '') ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  );
}
