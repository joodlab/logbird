import { compileQuery } from '@logbird/clickhouse';
import { formatRecordTerm } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { hasTerm, removeTerm, toggleTerm } from '@/lib/query-language';
import { recordPairValues } from './facet-sidebar';

it('lists one Record facet row per (type, id), so two records sharing an id never merge', () => {
  const rows = recordPairValues([
    {
      value: '12',
      label: 'Home page',
      count: 9,
      groups: [
        { value: 'page', label: 'page', count: 6 },
        { value: 'site', label: 'site', count: 3 },
      ],
    },
    { value: '7', label: '7', count: 4, groups: [{ value: 'a:b', label: 'a:b', count: 4 }] },
  ]);
  expect(rows).toEqual([
    // Two types share id 12: neither row borrows the other's name.
    { value: 'page:12', label: '12', count: 6 },
    { value: 'a\\:b:7', label: '7', count: 4 },
    { value: 'site:12', label: '12', count: 3 },
  ]);
});

it('names a record by its own name when its id belongs to one type', () => {
  expect(recordPairValues([{ value: '12', label: 'Home page', count: 2, groups: [{ value: 'page', label: 'page', count: 2 }] }])).toEqual([
    { value: 'page:12', label: 'Home page', count: 2 },
  ]);
  // A type outside the returned groups could hold the name too: fall back to the id.
  expect(
    recordPairValues([{ value: '12', label: 'Home page', count: 3, groups: [{ value: 'page', label: 'page', count: 2 }], groupsOtherCount: 1 }]),
  ).toEqual([{ value: 'page:12', label: '12', count: 2 }]);
});

it('filters a Record facet row with a paired record: term, and recognises and removes it', () => {
  const [row] = recordPairValues([{ value: '12', label: '', count: 1, groups: [{ value: 'site', label: 'site', count: 1 }] }]);
  const q = toggleTerm('outcome:failure', 'record', row?.value ?? '', 'include');
  expect(q).toBe(`outcome:failure ${formatRecordTerm('site', '12')}`);
  expect(hasTerm(q, 'record', 'site:12', false)).toBe(true);
  expect(hasTerm(q, 'record', 'page:12', false)).toBe(false);
  expect(removeTerm(q, 'record')).toBe('outcome:failure');
  // The server matches type and id on the same target, never id 12 of any type.
  expect(compileQuery(q).sql).toContain('arrayExists((t, i) -> t = {recordType');
  const typeWithColon = toggleTerm(
    '',
    'record',
    recordPairValues([{ value: '7', label: '', count: 1, groups: [{ value: 'a:b', label: '', count: 1 }] }])[0]?.value ?? '',
    'include',
  );
  expect(compileQuery(typeWithColon).params).toMatchObject({ recordType0: 'a:b', recordId0: '7' });
});
