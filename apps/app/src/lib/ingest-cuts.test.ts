import { expect, it } from 'vitest';
import { ingestCuts } from './ingest-cuts';

const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'doc', id: `d${i}`, name: '' }));
const changes = (n: number) => Array.from({ length: n }, (_, i) => ({ field: `f${i}`, before: '', after: '' }));

it('reads the counts ingest recorded and compares them with what was indexed', () => {
  expect(
    ingestCuts({
      attributes: { 'logbird.truncated.targets': '70', 'logbird.truncated.changes': '300', 'logbird.truncated.changeFields': '2' },
      targets: targets(64),
      changes: changes(256),
    }),
  ).toEqual({ targets: { indexed: 64, sent: 70 }, changes: { indexed: 256, sent: 300 }, changeFields: 2 });
});

it('shows no cut without the reserved attributes, for an unreadable value, or when nothing is missing', () => {
  const none = { targets: null, changes: null, changeFields: null };
  expect(ingestCuts({ attributes: {}, targets: targets(64), changes: changes(256) })).toEqual(none);
  expect(
    ingestCuts({ attributes: { 'logbird.truncated.targets': 'many', 'logbird.truncated.changeFields': '0' }, targets: [], changes: [] }),
  ).toEqual(none);
  expect(ingestCuts({ attributes: { 'logbird.truncated.targets': '3' }, targets: targets(3), changes: [] })).toEqual(none);
});
