import { RECENT_PROBLEM_OUTCOMES, RECENT_PROBLEM_SEVERITY } from '@logbird/contracts';
import type { SeriesKey } from '@/components/charts/outcome-series';

/**
 * Overview drill-downs: each widget's link opens exactly the events the widget counts or lists (#202), built from the
 * same definitions the widget uses.
 */

/** Outcomes the overview chart draws as their own bands. Everything else, `unknown` and custom outcomes, is "Other". */
export const NAMED_OUTCOMES = ['success', 'partial', 'denied', 'failure'] as const;

/** "Recent problems" → View all: the server's group, `outcome IN (failure, denied) OR severity = critical`. */
export const RECENT_PROBLEMS_QUERY = `(${[...RECENT_PROBLEM_OUTCOMES.map((o) => `outcome:${o}`), `severity:${RECENT_PROBLEM_SEVERITY}`].join(' OR ')})`;

/** A chart band → its events. "Other" excludes the named outcomes instead of matching only `unknown`. */
export function outcomeBandQuery(band: SeriesKey): string {
  return band === 'unknown' ? NAMED_OUTCOMES.map((o) => `-outcome:${o}`).join(' ') : `outcome:${band}`;
}
