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
        // A chosen range stays in the URL even when it equals the page default: entity pages tell "the reader picked
        // 24 hours" apart from "no choice, show the full history".
        search: ((prev: Record<string, unknown>) => ({ ...prev, range: next })) as never,
      });
    },
    [navigate],
  );
  const clearRange = useCallback(
    () => navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, range: undefined })) as never }),
    [navigate],
  );
  return { range, setRange, explicit, clearRange };
}
