import { describe, expect, it } from 'vitest';
import { MAX_RECENT, pushRecent, type RecentQuery } from './recent-queries';

describe('pushRecent', () => {
  it('puts the newest first and de-duplicates per language', () => {
    let items: RecentQuery[] = [];
    items = pushRecent(items, 'outcome:failure', 'query', 1);
    items = pushRecent(items, "outcome = 'failure'", 'sql', 2);
    items = pushRecent(items, '  outcome:failure ', 'query', 3);
    expect(items).toEqual([
      { q: 'outcome:failure', lang: 'query', at: 3 },
      { q: "outcome = 'failure'", lang: 'sql', at: 2 },
    ]);
  });

  it('ignores empty queries and keeps at most MAX_RECENT', () => {
    let items: RecentQuery[] = [];
    for (let i = 0; i < MAX_RECENT + 5; i += 1) items = pushRecent(items, `attempt:>${i}`, 'query', i);
    expect(pushRecent(items, '   ', 'query')).toBe(items);
    expect(items).toHaveLength(MAX_RECENT);
    expect(items[0]?.q).toBe(`attempt:>${MAX_RECENT + 4}`);
  });
});
