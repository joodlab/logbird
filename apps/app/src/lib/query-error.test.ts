import { expect, it } from 'vitest';
import { reasonTitle } from './query-error';

it('titles a /pattern/ RE2 cannot run as a regex problem, not a type mismatch', () => {
  const details = { lang: 'query' as const, reason: 'type' as const, start: null, end: null, hint: null };
  expect(reasonTitle(details, 'invalid_query', 'RE2 does not support lookaround, backreferences or this group type')).toBe('Regex not supported');
  expect(reasonTitle(details, 'invalid_query', 'attempt expects a number')).toBe('Type mismatch');
  expect(reasonTitle(null, 'invalid_query')).toBe('Invalid query');
});
