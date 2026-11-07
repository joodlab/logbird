import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api/errors';
import { failureSummary, isOverBudget } from './query-budget';

const limit = new ApiRequestError(422, 'invalid_query', 'Query exceeded its resource budget', {
  lang: 'query',
  reason: 'limit',
  start: null,
  end: null,
  hint: null,
});
const timeout = new ApiRequestError(503, 'query_unavailable', 'Storage query failed or exceeded its budget.');
const syntax = new ApiRequestError(422, 'invalid_query', 'Syntax error', { lang: 'query', reason: 'syntax', start: 0, end: 1, hint: null });
const offline = new TypeError('Failed to fetch');

describe('query budget', () => {
  it('recognises budget and timeout failures only', () => {
    expect(isOverBudget(limit)).toBe(true);
    expect(isOverBudget(timeout)).toBe(true);
    expect(isOverBudget(syntax)).toBe(false);
    expect(isOverBudget(offline)).toBe(false);
    expect(isOverBudget(null)).toBe(false);
  });

  it('summarises a page with mixed success and failure', () => {
    const ok = { isError: false, error: null };
    expect(failureSummary([ok, ok])).toBeNull();
    // The total loaded but the histogram ran out of budget: still the range message.
    expect(failureSummary([ok, { isError: true, error: timeout }, ok])).toBe('budget');
    expect(
      failureSummary([
        { isError: true, error: offline },
        { isError: true, error: limit },
      ]),
    ).toBe('budget');
    expect(failureSummary([ok, { isError: true, error: offline }])).toBe('error');
  });
});
