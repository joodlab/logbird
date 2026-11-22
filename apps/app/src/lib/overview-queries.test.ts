import { OUTCOMES } from '@logbird/contracts';
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

describe('overview drill-downs open exactly what their widget shows (#202)', () => {
  it('Recent problems → View all is the server group: failure or denied outcome, or critical severity', () => {
    expect(RECENT_PROBLEMS_QUERY).toBe('(outcome:failure OR outcome:denied OR severity:critical)');
  });

  it('every outcome lands in exactly the band whose link selects it, custom outcomes in Other', () => {
    const outcomes = [...OUTCOMES, 'timeout', 'skipped', 'Success'];
    const h = {
      interval: 60,
      buckets: [{ ts: '2026-11-22T10:00:00.000Z', total: outcomes.length, byOutcome: Object.fromEntries(outcomes.map((o) => [o, 1])) }],
    };
    const [row] = toSeries(h as Parameters<typeof toSeries>[0]);
    for (const band of SERIES) {
      // The chart counts these outcomes in the band…
      const linked = outcomes.filter((o) => bandMatches(outcomeBandQuery(band), o));
      // …and the band's link selects the same ones.
      expect(row?.[band], band).toBe(linked.length);
    }
    expect(outcomeBandQuery('unknown')).toBe('-outcome:success -outcome:partial -outcome:denied -outcome:failure');
    expect(row?.unknown).toBe(4); // unknown, timeout, skipped and a differently-cased "Success"
  });
});
