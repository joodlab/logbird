import { formatRecordTerm } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { entityViewName } from '@/components/views/save-entity-view-button';
import { holdForSavedView, upgradeRecordView, viewSearch } from './views';

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
  // Named through the API with the label's prefix but not the generated name: not the record page's own save.
  same({ name: 'Home page — manual review', state });
  // The generated name, but with a description: the record page never wrote one.
  same({ name: 'Home page — last 7 days', description: 'Hand-made review view', state });
  // The record page wrote exactly { q, lang: 'query', range, labels: [one Record label] }: any other state shape stays.
  same({ ...legacy, state: { ...state, labels: [...state.labels, { field: 'actor', value: 'u1', label: 'Lina' }] } });
  const { lang: _lang, ...withoutLang } = state;
  same({ ...legacy, state: withoutLang });
  const { range: _range, ...withoutRange } = state;
  same({ name: 'Home page — last 24 hours', state: withoutRange });
  same({ name: 'Home page — last 30 days', state });
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

it('upgrades a record page save whose long name was cut to 80 characters', () => {
  for (const label of ['L'.repeat(78), 'L'.repeat(80), 'L'.repeat(200)]) {
    const view = { name: entityViewName(label, '7d'), state: { ...state, labels: [{ field: 'target' as const, value: '12', label }] } };
    expect(view.name.length).toBeLessThanOrEqual(80);
    expect(upgradeRecordView(view).upgraded, String(label.length)).toBe(true);
  }
  // A shorter name that is merely a prefix of the label was typed by someone, not generated.
  expect(
    upgradeRecordView({ name: 'L'.repeat(40), state: { ...state, labels: [{ field: 'target', value: '12', label: 'L'.repeat(200) }] } }).upgraded,
  ).toBe(false);
});

it('holds a saved-view link until no legacy query can run', () => {
  const base = {
    viewId: 'v1',
    q: 'target:12 target.type:site',
    listPending: false,
    listError: false,
    found: true,
    confirmedMissing: false,
    legacyQ: undefined,
  };
  // A cold list.
  expect(holdForSavedView({ ...base, listPending: true, found: false })).toBe(true);
  // A cached list without the linked view, fresh or refreshing: hold until a fresh fetch confirms it is gone.
  expect(holdForSavedView({ ...base, found: false })).toBe(true);
  expect(holdForSavedView({ ...base, found: false, confirmedMissing: true })).toBe(false);
  // An old record-page view whose stored query is still in the link.
  expect(holdForSavedView({ ...base, legacyQ: 'target:12 target.type:site' })).toBe(true);
  // ...even when a background refresh of the list failed (the cached list still has the view).
  expect(holdForSavedView({ ...base, legacyQ: 'target:12 target.type:site', listError: true })).toBe(true);
  // Replaced by its exact form, or an ordinary view: run.
  expect(holdForSavedView({ ...base, q: formatRecordTerm('site', '12'), legacyQ: 'target:12 target.type:site' })).toBe(false);
  expect(holdForSavedView(base)).toBe(false);
  // No view in the link; a list error.
  expect(holdForSavedView({ ...base, viewId: undefined, listPending: true })).toBe(false);
  expect(holdForSavedView({ ...base, found: false, listError: true })).toBe(false);
});
