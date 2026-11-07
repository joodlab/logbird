import { describe, expect, it } from 'vitest';
import { rangePhrase } from './range';

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
