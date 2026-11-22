import { useMatches, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { ALL_RANGE, DEFAULT_RANGE, isValidRange } from '@/lib/range';

/** The shared time range lives in the `range` search param of every project page. */
export function useRange(): {
  range: string;
  setRange: (next: string) => void;
  /** True when the URL carries a range the user chose, false when the page default applies. */
  explicit: boolean;
  /** Drop the chosen range, back to the page default. */
  clearRange: () => void;
} {
  const search = useSearch({ strict: false }) as { range?: string };
  const pageDefault = useMatches({ select: (matches) => matches.findLast((m) => m.staticData?.defaultRange)?.staticData.defaultRange });
  const keepChosen = useMatches({ select: (matches) => matches.some((m) => m.staticData?.keepChosenRange) });
  const fallback = pageDefault ?? DEFAULT_RANGE;
  // "all" (passed on from an entity's full history) is not a narrowing choice.
  const valid = search.range && isValidRange(search.range) ? search.range : undefined;
  const explicit = Boolean(valid && valid !== ALL_RANGE);
  const range = valid ?? fallback;
  const navigate = useNavigate();
  const setRange = useCallback(
    (next: string) => {
      navigate({
        to: '.',
        // Entity pages keep a chosen range even when it equals the default ("the reader picked 24 hours" is not "no
        // choice, show the full history"); other pages drop the default so the next page falls back to its own.
        search: ((prev: Record<string, unknown>) => ({ ...prev, range: next === fallback && !keepChosen ? undefined : next })) as never,
      });
    },
    [navigate, fallback, keepChosen],
  );
  const clearRange = useCallback(
    () => navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, range: undefined })) as never }),
    [navigate],
  );
  return { range, setRange, explicit, clearRange };
}
