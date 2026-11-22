import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The browser zone is read once, when `time-zone.ts` loads. Each test pins a non-UTC zone (so switching to UTC really
 * changes the wall clock) and loads the modules fresh, optionally with a stubbed `window.localStorage`.
 */
const originalTz = process.env.TZ;
async function load(zone: string, storage?: Partial<Storage>) {
  process.env.TZ = zone;
  vi.resetModules();
  if (storage) vi.stubGlobal('window', { localStorage: storage });
  const tz = await import('./time-zone');
  const format = await import('./format');
  const range = await import('./range');
  const series = await import('@/components/charts/outcome-series');
  return { ...tz, ...format, ...range, ...series };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('console time zone', () => {
  it('defaults to the browser zone and switches every formatter both ways across New Year', async () => {
    const m = await load('America/Los_Angeles');
    expect(m.BROWSER_ZONE).toBe('America/Los_Angeles');
    expect(m.consoleTimeZone()).toBe('America/Los_Angeles');
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    const newYear = '2026-01-01T03:00:00.000Z';
    // 03:00 UTC on Jan 1 is still Dec 31 in Los Angeles: the row needs the year locally, not in UTC.
    expect(m.formatTimestamp(newYear, now)).toBe('Dec 31, 2025, 19:00:00');
    expect(m.timestampNeedsYear(newYear, now)).toBe(true);
    expect(m.formatFull(newYear)).toBe('Wed, Dec 31, 2025, 19:00:00 America/Los_Angeles');
    m.setZonePreference('utc');
    expect(m.displayTimeZone()).toBe('UTC');
    expect(m.formatTimestamp(newYear, now)).toBe('Jan 1, 03:00:00');
    expect(m.timestampNeedsYear(newYear, now)).toBe(false);
    expect(m.formatFull(newYear)).toBe('Thu, Jan 1, 2026, 03:00:00 UTC');
    // The tooltip's local line names the browser zone whatever the console shows.
    expect(m.formatInZone(newYear, m.BROWSER_ZONE)).toBe('Wed, Dec 31, 2025, 19:00:00 America/Los_Angeles');
    m.setZonePreference('local');
    expect(m.formatTimestamp(newYear, now)).toBe('Dec 31, 2025, 19:00:00');
  });

  it('formats every table row the same way, with the year outside the current one', async () => {
    const m = await load('Europe/Berlin');
    m.setZonePreference('utc');
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    expect(m.formatTimestamp('2026-11-22T05:25:53.000Z', now)).toBe('Nov 22, 05:25:53');
    expect(m.formatTimestamp('2026-11-19T15:31:02.000Z', now)).toBe('Nov 19, 15:31:02');
    expect(m.formatTimestamp('2025-12-31T23:59:59.000Z', now)).toBe('Dec 31, 2025, 23:59:59');
    m.setZonePreference('local');
    expect(m.formatTimestamp('2026-11-22T05:25:53.000Z', now)).toBe('Nov 22, 06:25:53');
  });

  it('names the zone of absolute ranges and of UTC-aligned day buckets that span two local dates', async () => {
    const m = await load('America/Los_Angeles');
    const day = Date.parse('2026-11-22T00:00:00.000Z');
    expect(m.bucketLabel(day, 86_400)).toBe('Nov 21, 16:00 – Nov 22, 16:00');
    expect(m.rangeLabel('2026-11-22T00:00:00.000Z..2026-11-22T04:00:00.000Z')).toBe('Nov 21, 16:00 – 20:00 Los Angeles time');
    m.setZonePreference('utc');
    expect(m.bucketLabel(day, 86_400)).toBe('Nov 22');
    expect(m.rangeLabel('2026-11-22T00:00:00.000Z..2026-11-22T04:00:00.000Z')).toBe('Nov 22, 00:00 – 04:00 UTC');
  });

  it('reads a saved choice, and keeps working in this tab when storage is blocked', async () => {
    const saved = await load('Europe/Berlin', { getItem: () => 'utc', setItem: () => undefined });
    expect(saved.consoleTimeZone()).toBe('UTC');
    const blocked = await load('Europe/Berlin', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(blocked.consoleTimeZone()).toBe('Europe/Berlin');
    expect(() => blocked.setZonePreference('utc')).not.toThrow();
    expect(blocked.consoleTimeZone()).toBe('UTC');
  });

  it('labels zones compactly', async () => {
    const m = await load('Europe/Berlin');
    expect(m.shortZoneLabel('UTC')).toBe('UTC');
    expect(m.shortZoneLabel('Europe/Berlin')).toBe('Berlin');
    expect(m.shortZoneLabel('America/New_York')).toBe('New York');
  });
});
