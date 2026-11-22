import { afterEach, describe, expect, it } from 'vitest';
import { displayTimeZone, formatFull, formatTimestamp } from './format';
import { BROWSER_ZONE, consoleTimeZone, setZonePreference, shortZoneLabel } from './time-zone';

afterEach(() => setZonePreference('local'));

describe('console time zone', () => {
  it('defaults to the browser zone and switches every formatter to UTC', () => {
    expect(consoleTimeZone()).toBe(BROWSER_ZONE);
    setZonePreference('utc');
    expect(displayTimeZone()).toBe('UTC');
    expect(formatFull('2026-11-22T05:25:53.000Z')).toBe('Sun, Nov 22, 2026, 05:25:53 UTC');
  });

  it('formats every table row the same way, with the year outside the current one', () => {
    setZonePreference('utc');
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    expect(formatTimestamp('2026-11-22T05:25:53.000Z', now)).toBe('Nov 22, 05:25:53');
    expect(formatTimestamp('2026-11-19T15:31:02.000Z', now)).toBe('Nov 19, 15:31:02');
    expect(formatTimestamp('2025-12-31T23:59:59.000Z', now)).toBe('Dec 31, 2025, 23:59:59');
  });

  it('labels zones compactly', () => {
    expect(shortZoneLabel('UTC')).toBe('UTC');
    expect(shortZoneLabel('Europe/Berlin')).toBe('Berlin');
    expect(shortZoneLabel('America/New_York')).toBe('New York');
  });
});
