import { useSyncExternalStore } from 'react';

/**
 * Secrets the server returns exactly once (API keys on creation). Kept in memory only — never in storage — so a
 * reload genuinely forgets them, matching "shown once". Components subscribe so a key created in one step is
 * pre-filled into every snippet on the page for the rest of the session.
 *
 * Ids: `<projectId>` = the project's ingest key, `<projectId>:read` = a read key.
 */
const secrets = new Map<string, string>();
const listeners = new Set<() => void>();

export const ingestSecretId = (projectId: string) => projectId;
export const readSecretId = (projectId: string) => `${projectId}:read`;

export function stashSecret(id: string, secret: string): void {
  secrets.set(id, secret);
  for (const listener of listeners) listener();
}

export function peekSecret(id: string): string | undefined {
  return secrets.get(id);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSecret(id: string): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => secrets.get(id),
    () => undefined,
  );
}
