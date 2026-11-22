import { formatRecordTerm } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { upgradeRecordView, viewSearch } from './views';

// What a record page saved before exact record matching: generated name, no columns, a Record label for the id.
const state = {
  q: 'target:12 target.type:site',
  lang: 'query' as const,
  range: '7d',
  labels: [{ field: 'target' as const, value: '12', label: 'Home page' }],
};
const legacy = { name: 'Home page — last 7 days', state };

it('opens a view saved from a record page before exact matching in its exact record: form, without saving it', () => {
  const { state: upgraded, upgraded: changed } = upgradeRecordView(legacy);
  expect(changed).toBe(true);
  expect(upgraded.q).toBe(formatRecordTerm('site', '12'));
  expect(upgraded.labels).toEqual([{ field: 'record', value: 'site:12', label: 'Home page' }]);
  // The stored state is untouched (the reader saves the change, or not).
  expect(state.q).toBe('target:12 target.type:site');
  expect(viewSearch({ id: 'v1', ...legacy })).toMatchObject({ q: formatRecordTerm('site', '12'), view: 'v1' });
  // Without the name a link opens as saved; the explorer route upgrades it on arrival.
  expect(viewSearch({ id: 'v1', state })).toMatchObject({ q: 'target:12 target.type:site' });
  // Filters typed on the record page after the pair are kept, ANDed as before.
  expect(upgradeRecordView({ ...legacy, state: { ...state, q: 'target:12 target.type:site outcome:failure' } }).state.q).toBe(
    `${formatRecordTerm('site', '12')} outcome:failure`,
  );
  expect(
    upgradeRecordView({
      name: 'AB — last 7 days',
      state: { ...state, q: 'target:"a b" target.type:"x:y"', labels: [{ field: 'target', value: 'a b', label: 'AB' }] },
    }).state.q,
  ).toBe(formatRecordTerm('x:y', 'a b'));
});

it('leaves a hand-typed lookalike exactly as written, even with a resolved Record label', () => {
  const same = (view: Parameters<typeof upgradeRecordView>[0]) =>
    expect(upgradeRecordView(view), JSON.stringify(view)).toEqual({ state: view.state, upgraded: false });
  // Saved from the explorer: the reader's own name and its columns, with the Record label the dialog resolved.
  same({ name: 'Site 12 review', state: { ...state, columns: ['time', 'action', 'actor'] } });
  same({ name: 'Home page — last 7 days', state: { ...state, columns: ['time', 'action'] } });
  same({ name: 'Site 12 review', state });
  // No Record label.
  same({ ...legacy, state: { ...state, labels: undefined } });
  for (const q of [
    'target:12 OR target.type:site',
    'outcome:failure target:12 target.type:site',
    '-target:12 target.type:site',
    'target:12 outcome:failure target.type:site',
    'target:1* target.type:site',
    'target:13 target.type:site',
    'target.type:site target:12',
  ])
    same({ ...legacy, state: { ...state, q } });
  same({ ...legacy, state: { ...state, lang: 'sql' as const } });
});
