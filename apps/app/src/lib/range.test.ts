import { describe, expect, it } from 'vitest';
import { ALL_RANGE, admittedRange, historyRange, isValidRange, rangeInSentence, rangeLabel, rangePhrase, resolveRange } from './range';

describe('rangePhrase', () => {
  it('reads presets as a phrase with "the"', () => {
    expect(rangePhrase('30d')).toBe('the last 30 days');
    expect(rangePhrase('1h')).toBe('the last hour');
    expect(rangePhrase('24h')).toBe('the last 24 hours');
  });

  it('keeps an absolute range as written (no lowercased month)', () => {
    const phrase = rangePhrase('2026-11-01T09:00:00.000Z..2026-11-07T09:00:00.000Z');
    expect(phrase).not.toMatch(/^the /);
    expect(phrase).not.toMatch(/\bnov\b/);
  });
});

describe('historyRange', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');

  it('covers everything since the first event, in whole days plus one', () => {
    expect(historyRange('2026-11-22T11:00:00.000Z', now)).toBe('2d');
    expect(historyRange('2026-09-24T08:00:00.000Z', now)).toBe('61d');
  });

  it('falls back to 90 days for an unreadable first-seen time', () => {
    expect(historyRange('not a date', now)).toBe('90d');
  });
});

describe('historyRange with a future-dated last event', () => {
  it('ends just after that event instead of now', () => {
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    const last = '2026-11-22T13:00:00.000Z';
    const r = resolveRange(historyRange('2026-11-20T12:00:00.000Z', now, last), now);
    expect(r.toMs).toBe(Date.parse(last) + 1);
    expect(r.fromMs).toBe(now - 3 * 86_400_000);
  });
});

describe('the "all" range', () => {
  it('is valid, labelled "All time" and covers everything stored, from a fixed early bound', () => {
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    expect(isValidRange(ALL_RANGE)).toBe(true);
    expect(rangeLabel(ALL_RANGE)).toBe('All time');
    const r = resolveRange(ALL_RANGE, now);
    expect(r.toMs).toBe(now + 2 * 86_400_000);
    expect(r.fromMs).toBe(Date.UTC(2000, 0, 1));
    expect(resolveRange(ALL_RANGE, now + 5 * 86_400_000).fromMs).toBe(r.fromMs);
  });
});

describe('historyRange within the current second', () => {
  it('keeps a last event from the current second (relative ends round down to the second)', () => {
    const now = Date.parse('2026-11-22T12:00:00.800Z');
    const r = resolveRange(historyRange('2026-11-20T12:00:00.000Z', now, '2026-11-22T12:00:00.500Z'), now);
    expect(r.toMs).toBe(Date.parse('2026-11-22T12:00:00.501Z'));
  });
});

describe('admittedRange', () => {
  it('covers every timestamp ingest admits, with a day of slack on each side', () => {
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    const day = 86_400_000;
    const r = resolveRange(admittedRange(now));
    expect(r.fromMs).toBe(now - 3651 * day);
    expect(r.toMs).toBe(now + 2 * day);
  });
});

describe('rangeLabel', () => {
  it('names the years of an absolute range that leaves the current year', () => {
    const label = rangeLabel('2016-11-23T07:00:00.000Z..2026-11-24T07:00:00.000Z');
    expect(label).toContain('2016');
    expect(label).toContain('2026');
  });

  it('never shows the same time at both ends of a short span (#197)', () => {
    // A one-event operation opens a 1 ms window: milliseconds tell the ends apart.
    const ms = rangeLabel('2026-11-23T10:15:30.000Z..2026-11-23T10:15:30.001Z');
    expect(ms).toMatch(/\d{2}:\d{2}:\d{2}\.000 – \d{2}:\d{2}:\d{2}\.001/);
    // Within one minute: seconds.
    const s = rangeLabel('2026-11-23T10:15:05.000Z..2026-11-23T10:15:50.000Z');
    expect(s).toMatch(/\d{2}:\d{2}:05 – \d{2}:\d{2}:50/);
    expect(s).not.toMatch(/\./);
    // Minutes apart: unchanged, minutes only.
    expect(rangeLabel('2026-11-23T10:15:00.000Z..2026-11-23T10:45:00.000Z')).not.toMatch(/:\d{2}:\d{2}/);
  });
});

describe('admittedRange with stored rows older than the admission window', () => {
  it('reaches back to the oldest stored event (minus a day)', () => {
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    const oldest = '2016-11-01T00:00:00.000Z';
    expect(resolveRange(admittedRange(now, oldest)).fromMs).toBe(Date.parse(oldest) - 86_400_000);
    expect(resolveRange(admittedRange(now, null)).fromMs).toBe(now - 3651 * 86_400_000);
  });
});

describe('isValidRange rejects ranges that name no window (#203)', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');
  it('accepts real windows', () => {
    for (const r of [
      'all',
      '15m',
      '24h',
      '7d',
      '3650d',
      '2026-11-22T00:00:00.000Z..2026-11-22T04:00:00.000Z',
      // Offsets with and without a colon, as saved views and shared links may carry them.
      '2026-11-01T09:00:00+0000..2026-11-07T09:00:00+0000',
      '2026-11-01T09:00:00+03:00..2026-11-07T09:00:00-05:30',
    ])
      expect(isValidRange(r, now), r).toBe(true);
  });
  it('rejects zero, unrepresentable, reversed, equal and malformed ranges', () => {
    for (const r of [
      '0d',
      '0h',
      '0m',
      '99999999999d',
      '9999999999999999999999m',
      '2026-11-22T04:00:00.000Z..2026-11-22T00:00:00.000Z',
      '2026-11-22T04:00:00.000Z..2026-11-22T04:00:00.000Z',
      '1969-12-31T00:00:00.000Z..2026-11-22T00:00:00.000Z',
      '2026-11-22T00:00:00.000Z..+275760-09-13T00:00:00.000Z',
      // Dates that do not exist, and years past what storage (DateTime64) supports.
      '2026-02-30T00:00:00.000Z..2026-03-04T00:00:00.000Z',
      '2026-11-22T24:00:00.000Z..2026-11-23T01:00:00.000Z',
      '2026-11-22T00:00:00.000Z..2500-01-01T00:00:00.000Z',
      '2026-11-22T00:00:00.000Z..2026-11-23T00:00:00.000Z..2026-11-24T00:00:00.000Z',
      'yesterday',
      '',
    ])
      expect(isValidRange(r, now), r).toBe(false);
  });
  it('labels a stored or shared invalid range as the default it opens', () => {
    expect(rangeLabel('0d')).toBe('Last 24 hours');
    expect(rangeLabel('99999999999d')).toBe('Last 24 hours');
  });
  it('resolves an invalid range to the default window instead of throwing', () => {
    const fallback = resolveRange('24h', now);
    expect(resolveRange('99999999999d', now)).toEqual(fallback);
    expect(resolveRange('0d', now)).toEqual(fallback);
    // An injected clock at the epoch: the fallback clamps instead of recursing.
    expect(resolveRange('0d', 0)).toMatchObject({ fromMs: 0, toMs: 0 });
  });
});

describe('rangeInSentence', () => {
  it('lowercases relative labels but keeps month and zone names', () => {
    expect(rangeInSentence('Last 7 days')).toBe('last 7 days');
    expect(rangeInSentence('All time')).toBe('all time');
    expect(rangeInSentence('Nov 22, 08:00 – 10:00 Berlin time')).toBe('Nov 22, 08:00 – 10:00 Berlin time');
  });
});
