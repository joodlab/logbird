import { parseJsonExact } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { normalizeEvent } from './normalize';
import { toEvent } from './queries';

function normalize(input: unknown) {
  const result = normalizeEvent(input, { projectId: 'fictional', receivedAt: new Date('2026-11-25T14:00:00Z') });
  if (!result.ok) throw new Error(result.reason);
  return result.row;
}

it('records both JSON kinds without changing the indexed text', () => {
  const row = normalize(
    parseJsonExact(`{"action":"record.updated","changes":[
      {"field":"created","after":"draft"},
      {"field":"removed","before":"draft"},
      {"field":"nullable","before":null,"after":"null"},
      {"field":"unset","before":"null","after":null},
      {"field":"empty","before":"","after":""},
      {"field":"amount","before":10,"after":"10"},
      {"field":"exact","before":"9007199254740993","after":9007199254740993},
      {"field":"active","before":false,"after":true},
      {"field":"config","before":{"items":[1,null,"2"]},"after":[{"enabled":true}]}
    ]}`),
  );
  expect(toEvent(row).changes).toEqual([
    { field: 'created', before: '', after: 'draft', beforeKind: 'absent', afterKind: 'string' },
    { field: 'removed', before: 'draft', after: '', beforeKind: 'string', afterKind: 'absent' },
    { field: 'nullable', before: 'null', after: 'null', beforeKind: 'null', afterKind: 'string' },
    { field: 'unset', before: 'null', after: 'null', beforeKind: 'string', afterKind: 'null' },
    { field: 'empty', before: '', after: '', beforeKind: 'string', afterKind: 'string' },
    { field: 'amount', before: '10', after: '10', beforeKind: 'number', afterKind: 'string' },
    { field: 'exact', before: '9007199254740993', after: '9007199254740993', beforeKind: 'string', afterKind: 'number' },
    { field: 'active', before: 'false', after: 'true', beforeKind: 'boolean', afterKind: 'boolean' },
    { field: 'config', before: '{"items":[1,null,"2"]}', after: '[{"enabled":true}]', beforeKind: 'json', afterKind: 'json' },
  ]);
});

it('keeps five arrays in step when the indexed changes are capped', () => {
  const changes = Array.from({ length: 257 }, (_, i) => ({ field: `item-${i}`, before: i, ...(i % 2 === 0 ? { after: null } : {}) }));
  const row = normalize({ action: 'record.updated', changes });
  expect(row.changes_fields).toHaveLength(256);
  expect(row.changes_before).toHaveLength(256);
  expect(row.changes_after).toHaveLength(256);
  expect(row.changes_before_kind).toHaveLength(256);
  expect(row.changes_after_kind).toHaveLength(256);
  expect(toEvent(row).changes.slice(-2)).toEqual([
    { field: 'item-254', before: '254', after: 'null', beforeKind: 'number', afterKind: 'null' },
    { field: 'item-255', before: '255', after: '', beforeKind: 'number', afterKind: 'absent' },
  ]);
  expect(JSON.parse(row.payload).changes).toHaveLength(257);
});

it('omits unknown kinds for old rows regardless of their text or payload', () => {
  const {
    changes_before_kind: _before,
    changes_after_kind: _after,
    ...legacy
  } = normalize({
    action: 'record.updated',
    changes: [{ field: 'value', after: null }],
  });
  const expected = [{ field: 'value', before: '', after: 'null' }];
  expect(toEvent(legacy).changes).toStrictEqual(expected);
  expect(toEvent({ ...legacy, changes_before_kind: [], changes_after_kind: [] }).changes).toStrictEqual(expected);
  expect(toEvent({ ...legacy, changes_after_kind: ['null', 'string'] }).changes).toStrictEqual(expected);
});
