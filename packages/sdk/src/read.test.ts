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

it('drops a blank query next to a selector', () => {
  expect(trailQuery({ target: { id: 'inv_1' }, q: '  ' }).q).toBe('target:"inv_1"');
  expect(trailQuery({ actor: 'u', q: '\t' }).q).toBe('actor:"u"');
  expect(trailQuery({ q: 'action:invoice.*' }).q).toBe('(action:invoice.*)');
});

// #263: a trail never widens to the whole project.
it('throws instead of returning a project-wide query when there is no selector and no query', () => {
  const empty = /a trail needs a target, actor, tenant or query; an empty trail would be the whole project/;
  expect(() => trailQuery({})).toThrow(TypeError);
  expect(() => trailQuery({})).toThrow(empty);
  expect(() => trailQuery({ q: '' })).toThrow(empty);
  expect(() => trailQuery({ q: '  \n\t' })).toThrow(empty);
  expect(() => trailQuery({ range: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }, limit: 50 })).toThrow(empty);
});

it('throws when a selector key is present without a value, even next to another selector or a query', () => {
  const session: { tenantId?: string } = {};
  // The case behind #263: a backend that forgets the null check must not show every customer's history.
  expect(() => trailQuery({ tenant: session.tenantId })).toThrow(/`tenant` was given but is empty/);
  expect(() => trailQuery({ target: { id: 'inv_1' }, tenant: session.tenantId })).toThrow(/`tenant` was given but is empty/);
  expect(() => trailQuery({ q: 'action:x', tenant: '' })).toThrow(/`tenant`/);
  expect(() => trailQuery({ actor: ' ' })).toThrow(/`actor` was given but is empty/);
  expect(() => trailQuery({ actor: undefined, tenant: 't1' })).toThrow(/`actor`/);
  expect(() => trailQuery({ actor: 42 as unknown as string })).toThrow(/`actor`/);
  expect(() => trailQuery({ target: undefined, actor: 'u' })).toThrow(/`target` was given but is empty/);
  expect(() => trailQuery({ target: { id: '' } })).toThrow(/`target` needs an id/);
  expect(() => trailQuery({ target: { type: 'invoice', id: '  ' } })).toThrow(/`target` needs an id/);
  expect(() => trailQuery({ target: { type: 'invoice' } as unknown as { id: string } })).toThrow(/`target` needs an id/);
  expect(() => trailQuery({ target: { type: 7, id: 'x' } as unknown as { id: string } })).toThrow(/`target.type`/);
  expect(() => trailQuery({ q: 7 as unknown as string })).toThrow(/`q` must be a string/);
  // Present and valid still works, and an absent key is simply absent.
  expect(trailQuery({ tenant: 't1' }).q).toBe('tenant:"t1"');
  expect(trailQuery({ target: { type: '', id: 'A2' } }).q).toBe('record:":A2"');
});

it('escapes every star in exact trail selectors', () => {
  expect(trailQuery({ target: { id: 'doc*v2*' }, actor: 'agent*', tenant: 'team*' }).q).toBe(
    String.raw`target:"doc\*v2\*" AND actor:"agent\*" AND tenant:"team\*"`,
  );
  expect(trailQuery({ target: { type: 'page*', id: 'doc*v2*' } }).q).toBe(String.raw`record:"page\*:doc\*v2\*"`);
});
