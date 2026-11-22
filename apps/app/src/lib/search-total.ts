import { formatNumber } from './format';

type TotalPage = { total: number; totalExact?: boolean };
/** The capped count's sentinel: 10,001 means "more than 10,000". */
export const TOTAL_CAP = 10_001;

/**
 * Best known total, reconciled with what is on screen. Only the newest page counts (each page resolves its own
 * range, so older totals can be stale); it is exact when it says so and is not below the rows loaded (plus one when
 * another page exists). Otherwise it is a lower bound. Servers without `totalExact` are exact below the cap.
 */
export function searchTotal(pages: readonly TotalPage[] | undefined, loaded = 0, hasMore = false): { count: number; exact: boolean } {
  const floor = loaded + (hasMore ? 1 : 0);
  const newest = pages?.at(-1);
  if (!newest) return { count: floor, exact: !hasMore };
  if (newest.totalExact !== false && newest.total < TOTAL_CAP && newest.total >= floor) return { count: newest.total, exact: true };
  return { count: Math.max(floor, newest.total), exact: false };
}

/** "1,234", "≥ 101" for a lower bound, "10,000+" at the cap. */
export function formatSearchTotal(total: { count: number; exact: boolean }): string {
  if (total.exact) return formatNumber(total.count);
  return total.count >= TOTAL_CAP ? '10,000+' : `≥ ${formatNumber(total.count)}`;
}
