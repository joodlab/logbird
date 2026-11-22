import { formatNumber } from './format';

type TotalPage = { total: number; totalExact?: boolean };
/** The capped count's sentinel: 10,001 means "more than 10,000". */
export const TOTAL_CAP = 10_001;

/**
 * Best known total across loaded pages, reconciled with what is on screen. The newest exact page wins unless the rows
 * already loaded (plus one when another page exists) disprove it; otherwise the largest lower bound. Servers without
 * `totalExact` are exact below the cap.
 */
export function searchTotal(pages: readonly TotalPage[] | undefined, loaded = 0, hasMore = false): { count: number; exact: boolean } {
  if (!pages?.length) return { count: loaded, exact: !hasMore };
  // Every page's total is at least a lower bound; together with what is on screen, the largest one is the floor.
  const floor = Math.max(loaded + (hasMore ? 1 : 0), ...pages.map((p) => p.total));
  const exact = pages.findLast((p) => p.totalExact !== false && p.total < TOTAL_CAP);
  if (exact && exact.total >= floor) return { count: exact.total, exact: true };
  return { count: floor, exact: false };
}

/** "1,234", "≥ 101" for a lower bound, "10,000+" at the cap. */
export function formatSearchTotal(total: { count: number; exact: boolean }): string {
  if (total.exact) return formatNumber(total.count);
  return total.count >= TOTAL_CAP ? '10,000+' : `≥ ${formatNumber(total.count)}`;
}
