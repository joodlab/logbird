import { formatRecordTerm } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { upgradeRecordView, viewSearch } from './views';

const legacy = {
  q: 'target:12 target.type:site',
  lang: 'query' as const,
  range: '7d',
  labels: [{ field: 'target' as const, value: '12', label: 'Home page' }],
};

it('opens a view saved from a record page before exact matching in its exact record: form, without saving it', () => {
  const { state, upgraded } = upgradeRecordView(legacy);
  expect(upgraded).toBe(true);
  expect(state.q).toBe(formatRecordTerm('site', '12'));
  expect(state.labels).toEqual([{ field: 'record', value: 'site:12', label: 'Home page' }]);
  // The stored state is untouched (the reader saves the change, or not).
  expect(legacy.q).toBe('target:12 target.type:site');
  expect(viewSearch({ id: 'v1', state: legacy })).toMatchObject({ q: formatRecordTerm('site', '12'), view: 'v1' });
  // Filters typed on the record page after the pair are kept, ANDed as before.
  expect(upgradeRecordView({ ...legacy, q: 'target:12 target.type:site outcome:failure' }).state.q).toBe(
    `${formatRecordTerm('site', '12')} outcome:failure`,
  );
  expect(
    upgradeRecordView({ ...legacy, q: 'target:"a b" target.type:"x:y"', labels: [{ field: 'target', value: 'a b', label: 'AB' }] }).state.q,
  ).toBe(formatRecordTerm('x:y', 'a b'));
});

it('leaves a hand-typed lookalike exactly as written', () => {
  // No Record label: the reader typed the two terms themselves and may mean "any target 12, any site target".
  const typed = { ...legacy, labels: undefined };
  expect(upgradeRecordView(typed)).toEqual({ state: typed, upgraded: false });
  for (const q of [
    'target:12 OR target.type:site',
    'outcome:failure target:12 target.type:site',
    '-target:12 target.type:site',
    'target:12 outcome:failure target.type:site',
    'target:1* target.type:site',
    'target:13 target.type:site',
    'target.type:site target:12',
  ]) {
    const state = { ...legacy, q };
    expect(upgradeRecordView(state), q).toEqual({ state, upgraded: false });
  }
  const sql = { ...legacy, lang: 'sql' as const };
  expect(upgradeRecordView(sql).upgraded).toBe(false);
});
