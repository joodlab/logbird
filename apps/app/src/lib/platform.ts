import { useSyncExternalStore } from 'react';

/** Apple keyboards label modifiers ⌘ / ⌥; everyone else has Ctrl / Alt. */
export function detectMac(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || '');
}

const subscribe = () => () => undefined;

/** Platform check that is stable across server render and hydration (the server assumes "not Mac"). */
export function useIsMac(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => detectMac(),
    () => false,
  );
}

/** "⌥-click" on Mac, "Alt-click" elsewhere. */
export const altClickLabel = (isMac: boolean) => (isMac ? '⌥-click' : 'Alt-click');

/** "⌘K" on Mac, "Ctrl K" elsewhere. */
export const modKeyLabel = (isMac: boolean, key: string) => (isMac ? `⌘${key}` : `Ctrl ${key}`);
