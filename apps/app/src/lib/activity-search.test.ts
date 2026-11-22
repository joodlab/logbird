import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityChip, activityFreeText, activityQuery, toggleActivityChip } from './activity-search';
import { createSearchCommitter } from './search-committer';

const roundTrip = (q: string) => activityQuery(activityChip(q), activityFreeText(q));

describe('workspace activity chips (#226)', () => {
  it('only a positive, top-level, catalogued category is a chip; everything else stays as written', () => {
    for (const q of [
      '-category:auth',
      'NOT category:auth',
      'NOT (category:auth)',
      'category:auth OR category:member',
      '(category:auth revoked)',
      'category:unknown',
      'category:auth*',
    ]) {
      expect(activityChip(q), q).toBeUndefined();
      expect(activityFreeText(q), q).toBe(q);
      expect(roundTrip(q), q).toBe(q);
    }
  });

  it('splits a chip from the rest and builds the same query back, keeping quoted spacing', () => {
    for (const q of [
      'category:api_key',
      'category:api_key revoked',
      'category:member -category:auth',
      'revoked',
      'category:member actor.name:"Nadia  Example"',
    ]) {
      expect(roundTrip(q), q).toBe(q);
    }
    expect(activityChip('category:member -category:auth')).toBe('member');
    expect(activityFreeText('category:member -category:auth')).toBe('-category:auth');
    expect(activityFreeText('category:member actor.name:"Nadia  Example"')).toBe('actor.name:"Nadia  Example"');
  });

  it('toggles a chip without touching other terms', () => {
    expect(toggleActivityChip('-category:auth', 'api_key')).toBe('category:api_key -category:auth');
    expect(toggleActivityChip('category:api_key -category:auth', 'api_key')).toBe('-category:auth');
    expect(toggleActivityChip('category:api_key revoked', 'member')).toBe('category:member revoked');
    // A compound filter is not a chip: selecting one ANDs it with the whole filter.
    expect(toggleActivityChip('category:auth OR category:member', 'auth')).toBe('category:auth (category:auth OR category:member)');
  });
});

describe('search committer', () => {
  afterEach(() => vi.useRealTimers());
  const setup = () => {
    vi.useFakeTimers();
    let location = '/workspace/activity?q=revoked';
    const commits: string[] = [];
    const committer = createSearchCommitter({ wait: 250, location: () => location, commit: (t) => commits.push(t) });
    return {
      committer,
      commits,
      go: (l: string) => {
        location = l;
      },
    };
  };

  it('commits after the pause, once, with the last text', () => {
    const { committer, commits } = setup();
    committer.edit('a');
    vi.advanceTimersByTime(100);
    committer.edit('ab');
    vi.advanceTimersByTime(249);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(commits).toEqual(['ab']);
  });

  it('drops the edit when the location changed meanwhile (Back, a range change)', () => {
    const { committer, commits, go } = setup();
    committer.edit('abc');
    go('/workspace/activity'); // Back to an entry without q
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([]);
    committer.edit('x');
    go('/workspace/activity?q=revoked&range=7d'); // same q, another range
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([]);
  });

  it('commits text equal to a previous edit again (paste after Back)', () => {
    const { committer, commits, go } = setup();
    committer.edit('revoked');
    vi.advanceTimersByTime(300);
    go('/workspace/activity');
    committer.edit('revoked');
    vi.advanceTimersByTime(300);
    expect(commits).toEqual(['revoked', 'revoked']);
  });

  it('hands pending text to a chip click and cancels its write', () => {
    const { committer, commits } = setup();
    committer.edit('revoked');
    expect(committer.takePending()).toBe('revoked');
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([]);
    expect(committer.pending).toBeUndefined();
  });
});
