/**
 * Recent explorer queries, per project, in localStorage (a per-browser convenience, never synced). Newest first,
 * de-duplicated per language, at most MAX_RECENT. Other tabs see changes through the `storage` event.
 */
import type { QueryLang } from '@logbird/contracts';
import { useCallback, useSyncExternalStore } from 'react';

export interface RecentQuery {
  q: string;
  lang: QueryLang;
  /** Epoch ms of the last run. */
  at: number;
}

export const MAX_RECENT = 20;
const EVENT = 'logbird:recent-queries';
const storageKey = (projectId: string) => `logbird:recent-queries:${projectId}`;

function parse(raw: string | null): RecentQuery[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((x): x is RecentQuery => typeof x?.q === 'string' && (x.lang === 'query' || x.lang === 'sql') && typeof x.at === 'number')
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function read(projectId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(projectId));
  } catch {
    return null;
  }
}

function write(projectId: string, items: RecentQuery[]) {
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(items.slice(0, MAX_RECENT)));
  } catch {
    // Storage full or blocked: recents are a convenience only.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Pure list update: move (or add) `q` to the front, keeping one entry per (q, lang). */
export function pushRecent(items: RecentQuery[], q: string, lang: QueryLang, at = Date.now()): RecentQuery[] {
  const text = q.trim();
  if (!text) return items;
  return [{ q: text, lang, at }, ...items.filter((x) => !(x.q === text && x.lang === lang))].slice(0, MAX_RECENT);
}

const EMPTY: RecentQuery[] = [];
const cache = new Map<string, { raw: string | null; items: RecentQuery[] }>();

function snapshot(projectId: string): RecentQuery[] {
  const raw = read(projectId);
  const hit = cache.get(projectId);
  if (hit && hit.raw === raw) return hit.items;
  const items = parse(raw);
  cache.set(projectId, { raw, items });
  return items;
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

export function useRecentQueries(projectId: string) {
  const items = useSyncExternalStore(
    subscribe,
    () => snapshot(projectId),
    () => EMPTY,
  );
  const add = useCallback((q: string, lang: QueryLang) => write(projectId, pushRecent(snapshot(projectId), q, lang)), [projectId]);
  const remove = useCallback(
    (q: string, lang: QueryLang) =>
      write(
        projectId,
        snapshot(projectId).filter((x) => !(x.q === q && x.lang === lang)),
      ),
    [projectId],
  );
  const clear = useCallback(() => write(projectId, []), [projectId]);
  return { items, add, remove, clear };
}
