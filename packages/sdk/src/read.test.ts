import type { SearchQuery as ContractQuery, SearchResponse as ContractResponse } from '@logbird/contracts';
import { expect, expectTypeOf, it } from 'vitest';
import { type SearchQuery, type SearchResponse, trailQuery } from './read';

it('keeps structural read types aligned with public contracts and quotes selectors', () => {
  expectTypeOf<SearchResponse>().toEqualTypeOf<ContractResponse>();
  expectTypeOf<SearchQuery>().toEqualTypeOf<ContractQuery>();
  expect(trailQuery({ target: { id: 'a" OR actor:other' }, q: 'action:record.* OR action:other' }).q).toBe(
    '(action:record.* OR action:other) AND target:"a\\" OR actor:other"',
  );
});
