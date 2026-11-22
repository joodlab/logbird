import { describe, expect, it } from 'vitest';
import { admittedRange, rangeLabel, rangePhrase, resolveRange } from './range';

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
});

describe('admittedRange with stored rows older than the admission window', () => {
  it('reaches back to the oldest stored event (minus a day)', () => {
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    const oldest = '2016-11-01T00:00:00.000Z';
    expect(resolveRange(admittedRange(now, oldest)).fromMs).toBe(Date.parse(oldest) - 86_400_000);
    expect(resolveRange(admittedRange(now, null)).fromMs).toBe(now - 3651 * 86_400_000);
  });
});
