import { describe, expect, it } from 'vitest';
import { historyRange, rangePhrase, resolveRange } from './range';

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
