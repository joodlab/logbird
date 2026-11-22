import { useSyncExternalStore } from 'react';

/**
 * Which zone the console shows times in: the browser's own ("local") or UTC. Saved per browser, so an auditor who
 * compares the console with UTC exports can keep UTC everywhere. Every formatter in `lib/format.ts` reads the zone
 * that `consoleTimeZone()` returns.
 */
export type ZonePreference = 'local' | 'utc';

const STORAGE_KEY = 'logbird.timeZone';

/** The browser's zone, e.g. "Europe/Berlin" (UTC when the runtime cannot tell). */
export const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function readPreference(): ZonePreference {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(STORAGE_KEY) === 'utc' ? 'utc' : 'local';
  } catch {
    return 'local';
  }
}

let preference: ZonePreference = readPreference();
const listeners = new Set<() => void>();

export const zoneFor = (p: ZonePreference): string => (p === 'utc' ? 'UTC' : BROWSER_ZONE);

/** The IANA zone every console time is shown in right now. */
export function consoleTimeZone(): string {
  return zoneFor(preference);
}

export function setZonePreference(next: ZonePreference): void {
  if (next === preference) return;
  preference = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private windows and blocked storage: the choice still applies to this tab.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current preference; components re-render when it changes. */
export function useZonePreference(): ZonePreference {
  return useSyncExternalStore(
    subscribe,
    () => preference,
    () => 'local',
  );
}

/**
 * The zone every console time is shown in, for components that format times: calling it re-renders the component when
 * the reader switches zones (nothing is remounted, so forms, scroll positions and live buffers survive the switch).
 */
export function useConsoleZone(): string {
  return zoneFor(useZonePreference());
}

/** "UTC", or the city of the browser's zone ("Berlin" for Europe/Berlin), for compact labels such as column headers. */
export function shortZoneLabel(zone: string): string {
  if (zone === 'UTC') return 'UTC';
  return (zone.split('/').at(-1) ?? zone).replaceAll('_', ' ');
}
