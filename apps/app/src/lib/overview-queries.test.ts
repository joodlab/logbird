import { OUTCOMES, RECENT_PROBLEM_OUTCOMES, RECENT_PROBLEM_SEVERITY } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { SERIES, toSeries } from '@/components/charts/outcome-series';
import { outcomeBandQuery, RECENT_PROBLEMS_QUERY } from './overview-queries';
import { fieldTermsWithPolarity } from './query-language';

/** Whether an event with this outcome matches a band query made only of (possibly negated) outcome terms, ANDed. */
function bandMatches(query: string, outcome: string): boolean {
  const terms = fieldTermsWithPolarity(query);
  expect(terms.every((t) => t.token.field === 'outcome')).toBe(true);
  return terms.every(({ token, negated }) => (token.value === outcome) !== negated);
}

/** Whether an event matches a query made of field terms joined by OR (and outer parentheses), like Recent problems. */
function anyTermMatches(query: string, event: Record<string, string>): boolean {
  return fieldTermsWithPolarity(query).some(({ token, negated }) => (event[token.field ?? ''] === token.value) !== negated);
}

describe('overview drill-downs open exactly what their widget shows (#202)', () => {
  it('Recent problems → View all selects exactly the server group: failure or denied outcome, or critical severity', () => {
    expect(RECENT_PROBLEMS_QUERY).toBe('(outcome:failure OR outcome:denied OR severity:critical)');
    const server = (e: { outcome: string; severity: string }) =>
      (RECENT_PROBLEM_OUTCOMES as readonly string[]).includes(e.outcome) || e.severity === RECENT_PROBLEM_SEVERITY;
    const events = [
      { outcome: 'failure', severity: 'info' },
      { outcome: 'denied', severity: 'warning' },
      { outcome: 'success', severity: 'critical' },
      { outcome: 'unknown', severity: 'info' },
      { outcome: 'partial', severity: 'warning' },
      { outcome: 'success', severity: 'info' },
    ];
    for (const e of events) expect(anyTermMatches(RECENT_PROBLEMS_QUERY, e), JSON.stringify(e)).toBe(server(e));
  });

  it("each outcome lands in exactly one band, and only that band's link selects it (custom outcomes in Other)", () => {
    for (const outcome of [...OUTCOMES, 'timeout', 'skipped', 'Success']) {
      const h = { interval: 60, buckets: [{ ts: '2026-11-22T10:00:00.000Z', total: 1, byOutcome: { [outcome]: 1 } }] };
      const [row] = toSeries(h as Parameters<typeof toSeries>[0]);
      const counted = SERIES.filter((band) => (row?.[band] ?? 0) === 1);
      const linked = SERIES.filter((band) => bandMatches(outcomeBandQuery(band), outcome));
      expect(counted, outcome).toHaveLength(1);
      expect(linked, outcome).toEqual(counted);
    }
    expect(outcomeBandQuery('unknown')).toBe('-outcome:success -outcome:partial -outcome:denied -outcome:failure');
  });
});
