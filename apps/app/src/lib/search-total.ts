import { formatNumber } from './format';

type TotalPage = { total: number; totalExact?: boolean };
/** The capped count's sentinel: 10,001 means "more than 10,000". */
export const TOTAL_CAP = 10_001;

/**
 * Best known total across loaded pages. Any exact page wins; otherwise the largest lower bound (a later page can know
 * more than page one). Servers without `totalExact` are exact below the cap.
 */
export function searchTotal(pages: readonly TotalPage[] | undefined): { count: number; exact: boolean } {
  if (!pages?.length) return { count: 0, exact: true };
  const exact = pages.find((p) => p.totalExact !== false && p.total < TOTAL_CAP);
  if (exact) return { count: exact.total, exact: true };
  return { count: Math.max(...pages.map((p) => p.total)), exact: false };
}

/** "1,234", "≥ 101" for a lower bound, "10,000+" at the cap. */
export function formatSearchTotal(total: { count: number; exact: boolean }): string {
  if (total.exact) return formatNumber(total.count);
  return total.count >= TOTAL_CAP ? '10,000+' : `≥ ${formatNumber(total.count)}`;
}
