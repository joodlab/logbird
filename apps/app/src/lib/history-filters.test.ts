import { describe, expect, it } from 'vitest';
import { applyHistoryFilter, historyFilterTerms, removeHistoryFilter } from './history-filters';

describe('record history controls', () => {
  it.each([
    ['tenant', 'east', 'west'],
    ['changes.field', 'title', 'status'],
  ] as const)('preserves the Boolean expression when adding, switching, or removing a %s filter', (field, before, after) => {
    const original = `${field}:${before} outcome:failure OR outcome:denied`;
    expect(historyFilterTerms(original, field)).toEqual([]);
    const applied = applyHistoryFilter(original, field, after);
    expect(applied).toBe(`(${original}) ${field}:${after}`);
    const switched = applyHistoryFilter(applied, field, before);
    expect(switched).toBe(`(${original}) ${field}:${before}`);
    expect(historyFilterTerms(switched, field).map((term) => term.value)).toEqual([before]);
    expect(removeHistoryFilter(switched, field, before)).toBe(`(${original})`);
  });

  it('can address an unnamed indexed field without removing nested exclusions', () => {
    const query = applyHistoryFilter('NOT (changes.field:status outcome:denied)', 'changes.field', '');
    expect(query).toBe('NOT (changes.field:status outcome:denied) changes.field:""');
    expect(removeHistoryFilter(query, 'changes.field', '')).toBe('NOT (changes.field:status outcome:denied)');
  });

  it('switches grouped exact filters in a conjunction and preserves OR and NOT groups', () => {
    expect(applyHistoryFilter('(tenant:east)', 'tenant', 'west')).toBe('tenant:west');
    const query = '((tenant:east outcome:failure)) (tenant:north OR tenant:south) NOT (tenant:central)';
    expect(historyFilterTerms(query, 'tenant').map((term) => term.value)).toEqual(['east']);
    expect(applyHistoryFilter(query, 'tenant', 'west')).toBe('((outcome:failure)) (tenant:north OR tenant:south) NOT (tenant:central) tenant:west');
  });
});
