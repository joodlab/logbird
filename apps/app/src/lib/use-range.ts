import { useMatches, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { DEFAULT_RANGE, isValidRange } from '@/lib/range';

/** The shared time range lives in the `range` search param of every project page. */
export function useRange(): { range: string; setRange: (next: string) => void } {
  const search = useSearch({ strict: false }) as { range?: string };
  const pageDefault = useMatches({ select: (matches) => matches.findLast((m) => m.staticData?.defaultRange)?.staticData.defaultRange });
  const fallback = pageDefault ?? DEFAULT_RANGE;
  const range = search.range && isValidRange(search.range) ? search.range : fallback;
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
  return { range, setRange };
}
