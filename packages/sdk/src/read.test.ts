import type { SearchQuery as ContractQuery, SearchResponse as ContractResponse } from '@logbird/contracts';
import { expect, expectTypeOf, it } from 'vitest';
import { type SearchQuery, type SearchResponse, trailQuery } from './read';

it('keeps structural read types aligned with public contracts and quotes selectors', () => {
  expectTypeOf<SearchResponse>().toEqualTypeOf<ContractResponse>();
  expectTypeOf<SearchQuery>().toEqualTypeOf<ContractQuery>();
  expect(trailQuery({ target: { id: 'a" OR actor:other' }, q: 'action:record.* OR action:other' }).q).toBe(
    '(action:record.* OR action:other) AND target:"a\\" OR actor:other"',
  );
  expect(trailQuery({ target: { type: 'order', id: 'A:1' } }).q).toBe('record:"order:A:1"');
  expect(trailQuery({ target: { type: String.raw`order\:archived`, id: 'A:"1"' } }).q).toBe(String.raw`record:"order\\\\\\:archived:A:\"1\""`);
});

it('escapes carriage returns in SDK trail selectors', () => {
  const id = ' x\t\n\r:y"\\ ';
  const { q } = trailQuery({ target: { type: 'page:section\\v2', id }, actor: id, tenant: id });
  expect(q).toBe('record:"page\\\\:section\\\\\\\\v2: x\t\n\\r:y\\"\\\\ " AND actor:" x\t\n\\r:y\\"\\\\ " AND tenant:" x\t\n\\r:y\\"\\\\ "');
  expect(trailQuery({ target: { id } }).q).toBe('target:" x\t\n\\r:y\\"\\\\ "');
});

it('drops a blank query next to a selector and keeps it (for the server to reject) without one', () => {
  expect(trailQuery({ target: { id: 'inv_1' }, q: '  ' }).q).toBe('target:"inv_1"');
  expect(trailQuery({ actor: 'u', q: '\t' }).q).toBe('actor:"u"');
  expect(trailQuery({ q: '  ' }).q).toBe('(  )');
});

it('escapes every star in exact trail selectors', () => {
  expect(trailQuery({ target: { id: 'doc*v2*' }, actor: 'agent*', tenant: 'team*' }).q).toBe(
    String.raw`target:"doc\*v2\*" AND actor:"agent\*" AND tenant:"team\*"`,
  );
  expect(trailQuery({ target: { type: 'page*', id: 'doc*v2*' } }).q).toBe(String.raw`record:"page\*:doc\*v2\*"`);
});
