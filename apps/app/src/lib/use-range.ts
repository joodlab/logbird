import { useMatches, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { DEFAULT_RANGE, isValidRange } from '@/lib/range';

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
  const fallback = pageDefault ?? DEFAULT_RANGE;
  const explicit = Boolean(search.range && isValidRange(search.range));
  const range = explicit && search.range ? search.range : fallback;
  const navigate = useNavigate();
  const setRange = useCallback(
    (next: string) => {
      navigate({
        to: '.',
        search: ((prev: Record<string, unknown>) => ({ ...prev, range: next === fallback ? undefined : next })) as never,
      });
    },
    [navigate, fallback],
  );
  const clearRange = useCallback(() => setRange(fallback), [setRange, fallback]);
  return { range, setRange, explicit, clearRange };
}
