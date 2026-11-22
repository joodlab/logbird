import { describe, expect, it } from 'vitest';
import { allStoredRange, rangePhrase, resolveRange } from './range';

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

describe('allStoredRange', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');
  const day = 86_400_000;

  it('covers the retention window plus a day, up to the ingest limit of a day ahead', () => {
    const r = resolveRange(allStoredRange(90, now));
    expect(r.fromMs).toBe(now - 91 * day);
    expect(r.toMs).toBe(now + day);
  });

  it('falls back to the 3650-day ingest limit without a retention', () => {
    expect(resolveRange(allStoredRange(undefined, now)).fromMs).toBe(now - 3650 * day);
  });
});
