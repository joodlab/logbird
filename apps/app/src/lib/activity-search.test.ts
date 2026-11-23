import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityChip, activityFreeText, activityQuery, toggleActivityChip } from './activity-search';
import { createSearchCommitter } from './search-committer';

const roundTrip = (q: string) => activityQuery(activityChip(q), activityFreeText(q));

describe('workspace activity chips (#226)', () => {
  it('only a positive, top-level, catalogued category is a chip; everything else stays as written', () => {
    for (const q of [
      '-category:auth',
      'NOT category:auth',
      '- category:auth',
      'NOT (category:auth)',
      'category:auth OR category:member',
      '(category:auth revoked)',
      'category:unknown',
      'category:auth*',
      // #220: a negated group, a dash after `)`, and terms inside a quoted value are never a chip.
      'NOT (category:auth revoked)',
      '-(category:auth)',
      '(revoked)-category:auth',
      'description:"category:auth"',
      '(action:x)-/a"b"category:auth tail/',
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
      // #220: quoted attribute keys and negated groups come back exactly as written.
      'category:auth "attr.ticket status":open',
      'category:auth NOT (actor:qa-user-1 OR "attr.ticket status":closed)',
      'category:auth (revoked)-action:x',
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
    // An explicit AND goes with the chip's term.
    expect(toggleActivityChip('revoked AND category:auth', 'auth')).toBe('revoked');
    expect(toggleActivityChip('category:auth AND revoked', 'auth')).toBe('revoked');
    expect(activityFreeText('revoked AND category:auth AND -category:member')).toBe('revoked AND -category:member');
  });
});

describe('search committer', () => {
  afterEach(() => vi.useRealTimers());
  // History entries by index: the page's own writes replace the current entry; Back/Forward and pushes move.
  const setup = () => {
    vi.useFakeTimers();
    let entry = 1;
    const commits: string[] = [];
    const committer = createSearchCommitter({ wait: 250, entry: () => `${entry}`, commit: (t) => commits.push(t) });
    return {
      committer,
      commits,
      moveTo: (e: number) => {
        entry = e;
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

  it('drops the edit when the reader moved to another entry (Back to no q, Back to the same q with another range)', () => {
    const { committer, commits, moveTo } = setup();
    committer.edit('abc');
    moveTo(0); // Back
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([]);
    moveTo(2); // a pushed entry: same q, another range
    committer.edit('x');
    moveTo(1); // Back again before the write
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([]);
  });

  it('drops an edit when a new entry is pushed while it is pending (a range picked in the header)', () => {
    const { committer, commits, moveTo } = setup();
    committer.edit('revoked');
    moveTo(2); // pushed during the edit
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([]);
  });

  it('keeps an edit through a replace on the same entry (opening an event)', () => {
    const { committer, commits } = setup();
    committer.edit('revoked');
    // `ev` replaces the current entry: same index
    vi.advanceTimersByTime(300);
    expect(commits).toEqual(['revoked']);
  });

  it('keeps typing across its own write: an edit begun before the previous write lands still commits', () => {
    const { committer, commits } = setup();
    committer.edit('rev');
    vi.advanceTimersByTime(250); // the write for "rev" replaces the current entry (same index)
    committer.edit('revoked'); // typed before the router reflects that write
    vi.advanceTimersByTime(250);
    expect(commits).toEqual(['rev', 'revoked']);
  });

  it('commits text equal to a previous edit again (paste after Back)', () => {
    const { committer, commits, moveTo } = setup();
    committer.edit('revoked');
    vi.advanceTimersByTime(300);
    moveTo(0);
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
