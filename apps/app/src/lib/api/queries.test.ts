import { describe, expect, it } from 'vitest';
import { eventsInfiniteQuery, keepPreviousInProject, keys } from './queries';

describe('keepPreviousInProject', () => {
  const previous = { pages: [{ data: [{ id: 'evt_from_a' }] }] };

  it('keeps the previous result while the same project loads a new search', () => {
    const keep = keepPreviousInProject('proj_a');
    expect(keep(previous, { queryKey: [...keys.project('proj_a'), 'events', '24h', '', 'query'] })).toBe(previous);
  });

  it('never carries one project’s result into another while it loads', () => {
    const keep = keepPreviousInProject('proj_b');
    expect(keep(previous, { queryKey: [...keys.project('proj_a'), 'events', '24h', '', 'query'] })).toBeUndefined();
    expect(keep(previous, { queryKey: ['workspace-activity', '24h', ''] })).toBeUndefined();
    expect(keep(previous, undefined)).toBeUndefined();
  });

  it('is what the explorer’s events query uses', () => {
    const options = eventsInfiniteQuery('proj_b', '24h', '');
    const placeholder = options.placeholderData as unknown as (p: unknown, q?: { queryKey: readonly unknown[] }) => unknown;
    expect(placeholder(previous, { queryKey: eventsInfiniteQuery('proj_a', '24h', '').queryKey })).toBeUndefined();
    expect(placeholder(previous, { queryKey: eventsInfiniteQuery('proj_b', '7d', '').queryKey })).toBe(previous);
  });
});
