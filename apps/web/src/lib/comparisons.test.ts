import { describe, expect, it } from 'vitest';
import { ACCESSED, comparisons, longDate } from './comparisons';
import { getPage } from './site-map';

describe('comparisons', () => {
  it.each(comparisons)('$slug cites a listed source for every claim, and lists no unused source', (comparison) => {
    const ids = comparison.sources.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cited = new Set([
      ...comparison.summarySourceIds,
      ...(comparison.note?.sourceIds ?? []),
      ...comparison.rows.flatMap((row) => row.sourceIds),
    ]);
    for (const id of cited) {
      expect(ids).toContain(id);
    }
    expect(ids.filter((id) => !cited.has(id))).toEqual([]);
  });

  it.each(comparisons)('$slug sources are dated and official https links', (comparison) => {
    for (const source of comparison.sources) {
      expect(source.accessed).toBe(ACCESSED);
      for (const url of [source.url, ...(source.also ?? [])]) {
        expect(new URL(url).protocol).toBe('https:');
      }
    }
  });

  it.each(comparisons)('$slug has a manifest page and no performance numbers', (comparison) => {
    expect(getPage(comparison.path).section).toBe('compare');
    const text = JSON.stringify(comparison);
    expect(text).not.toMatch(/\d\s?(ms|milliseconds|events\/s|req\/s|rps)\b/i);
    expect(text.toLowerCase()).not.toContain(['jood', 'cms'].join(''));
  });

  it('formats the access date without locale data', () => {
    expect(longDate('2026-11-07')).toBe('7 November 2026');
  });
});

describe('trust page metadata', () => {
  it.each(['/cloud', '/open-source', '/security', '/compare', ...comparisons.map((comparison) => comparison.path)])(
    '%s has a real description of at most 155 characters',
    (path) => {
      const { description } = getPage(path);
      expect(description).not.toMatch(/being prepared/);
      expect(description.length).toBeLessThanOrEqual(155);
    },
  );
});
