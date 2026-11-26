import { expect, it } from 'vitest';
import { ingestCuts } from './ingest-cuts';

const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'doc', id: `d${i}`, name: '' }));
const changes = (n: number) => Array.from({ length: n }, (_, i) => ({ field: `f${i}`, before: '', after: '' }));
const none = { targets: null, changes: null, changeFields: null };
const cutAttributes = { 'logbird.truncated.targets': '70', 'logbird.truncated.changes': '300', 'logbird.truncated.changeFields': '2' };
const payload = {
  targets: targets(70),
  changes: [{ field: 'x'.repeat(300) }, { field: ` ${'y'.repeat(257)} ` }, ...changes(298)],
};

it('reads the counts ingest recorded when the original payload confirms them', () => {
  expect(ingestCuts({ attributes: cutAttributes, targets: targets(64), changes: changes(256) }, payload)).toEqual({
    targets: { indexed: 64, sent: 70 },
    changes: { indexed: 256, sent: 300 },
    changeFields: 2,
  });
});

it('shows nothing until the payload is there, and nothing the payload contradicts', () => {
  // Still loading, failed, or not fetched: no payload to confirm (or point to).
  expect(ingestCuts({ attributes: cutAttributes, targets: targets(64), changes: changes(256) }, undefined)).toEqual(none);
  // A producer value stored by an earlier release: the payload has 1 target, not 70.
  expect(ingestCuts({ attributes: { 'logbird.truncated.targets': '70' }, targets: targets(1), changes: [] }, { targets: targets(1) })).toEqual(none);
  expect(ingestCuts({ attributes: { 'logbird.truncated.changeFields': '5' }, targets: [], changes: changes(1) }, { changes: changes(1) })).toEqual(
    none,
  );
});

it('shows no cut without the reserved attributes, for an unreadable value, or when nothing is missing', () => {
  expect(ingestCuts({ attributes: {}, targets: targets(64), changes: changes(256) }, payload)).toEqual(none);
  expect(
    ingestCuts({ attributes: { 'logbird.truncated.targets': 'many', 'logbird.truncated.changeFields': '0' }, targets: [], changes: [] }, payload),
  ).toEqual(none);
  expect(ingestCuts({ attributes: { 'logbird.truncated.targets': '3' }, targets: targets(3), changes: [] }, { targets: targets(3) })).toEqual(none);
});
