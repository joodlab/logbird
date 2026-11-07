/**
 * Test-only ESM stand-in for `use-sync-external-store/shim/with-selector` (used by TanStack Store, under TanStack Table).
 * The hoisted install gives that CommonJS package its own nested React, which Node loads natively in component tests:
 * two Reacts, broken hooks. This port of React's implementation imports the app's React instead. The app bundle is
 * unaffected (Vite dedupes React there).
 */
import { useDebugValue, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: undefined | null | (() => Snapshot),
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  const inst = useRef<{ hasValue: boolean; value: Selection | null }>({ hasValue: false, value: null }).current;
  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false;
    let memoSnapshot: Snapshot;
    let memoSelection: Selection;
    const select = (next: Snapshot): Selection => {
      if (!hasMemo) {
        hasMemo = true;
        memoSnapshot = next;
        const selection = selector(next);
        if (isEqual && inst.hasValue && isEqual(inst.value as Selection, selection)) {
          memoSelection = inst.value as Selection;
          return memoSelection;
        }
        memoSelection = selection;
        return selection;
      }
      if (Object.is(memoSnapshot, next)) return memoSelection;
      const selection = selector(next);
      memoSnapshot = next;
      if (isEqual?.(memoSelection, selection)) return memoSelection;
      memoSelection = selection;
      return selection;
    };
    const server = getServerSnapshot ?? null;
    return [() => select(getSnapshot()), server === null ? undefined : () => select(server())];
  }, [getSnapshot, getServerSnapshot, selector, isEqual, inst]);
  const value = useSyncExternalStore(subscribe, getSelection, getServerSelection);
  useEffect(() => {
    inst.hasValue = true;
    inst.value = value;
  }, [value, inst]);
  useDebugValue(value);
  return value;
}
