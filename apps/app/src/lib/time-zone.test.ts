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
  const picker = await import('@logbird/ui/components/time-range-picker');
  return { ...tz, ...format, ...range, ...series, toWall: picker.toWall, fromWall: picker.fromWall, resolveWall: picker.resolveWall };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => {
  process.env.TZ = originalTz;
});

// Each test re-imports the formatters, ranges and picker fresh (a cold import can take seconds on a busy machine).
describe('console time zone', { timeout: 30_000 }, () => {
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
    // Labels add the year outside the current one: pin "now" so the expectations do not age.
    vi.useFakeTimers({ now: Date.parse('2026-11-22T12:00:00.000Z'), toFake: ['Date'] });
    const m = await load('America/Los_Angeles');
    const day = Date.parse('2026-11-22T00:00:00.000Z');
    expect(m.bucketLabel(day, 86_400)).toBe('Nov 21, 16:00 – Nov 22, 16:00');
    expect(m.rangeLabel('2026-11-22T00:00:00.000Z..2026-11-22T04:00:00.000Z')).toBe('Nov 21, 16:00 – 20:00 Los Angeles time');
    m.setZonePreference('utc');
    expect(m.bucketLabel(day, 86_400)).toBe('Nov 22');
    expect(m.rangeLabel('2026-11-22T00:00:00.000Z..2026-11-22T04:00:00.000Z')).toBe('Nov 22, 00:00 – 04:00 UTC');
  });

  it('edits custom ranges in the console zone, even on a day the browser skips an hour', async () => {
    const m = await load('Europe/Berlin');
    m.setZonePreference('utc');
    // Berlin skips 02:00–03:00 local on Mar 29, 2026; 02:30 UTC exists and must survive an unchanged Apply.
    const start = new Date('2026-03-29T02:30:00.000Z');
    const wall = m.toWall(start, m.zoneOffsetMs);
    expect(wall.time).toBe('02:30');
    expect(wall.day.getDate()).toBe(29);
    expect(m.fromWall(wall.day, wall.time, m.zoneOffsetMs)?.toISOString()).toBe('2026-03-29T02:30:00.000Z');
    m.setZonePreference('local');
    const local = m.toWall(start, m.zoneOffsetMs);
    expect(local.time).toBe('04:30');
    expect(m.fromWall(local.day, local.time, m.zoneOffsetMs)?.toISOString()).toBe('2026-03-29T02:30:00.000Z');
    // Typing 09:00 in UTC applies 09:00Z, not the browser's 09:00.
    expect(m.fromWall(new Date(2026, 10, 22, 12), '09:00', () => 0)?.toISOString()).toBe('2026-11-22T09:00:00.000Z');
  });

  it('flags clocks that do not exist or happen twice, and never reads a window across a clock change backwards', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-22T12:00:00.000Z'), toFake: ['Date'] });
    const m = await load('Europe/Berlin');
    const oct25 = new Date(2026, 9, 25, 12);
    const mar29 = new Date(2026, 2, 29, 12);
    // Berlin falls back on Oct 25 (02:00–03:00 twice) and springs forward on Mar 29 (02:00–03:00 never).
    const twice = m.resolveWall(oct25, '02:30', m.zoneOffsetMs);
    expect(twice.status).toBe('repeated');
    expect(twice.date?.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(m.resolveWall(mar29, '02:30', m.zoneOffsetMs).status).toBe('gap');
    expect(m.resolveWall(mar29, '', m.zoneOffsetMs).status).toBe('invalid');
    expect(m.resolveWall(mar29, '03:30', m.zoneOffsetMs)).toMatchObject({ status: 'ok', offsetMs: 7_200_000 });
    expect(m.rangeLabel('2026-10-25T00:45:00.000Z..2026-10-25T01:00:00.000Z')).toBe('Oct 25, 02:45 (GMT+2) – 02:00 (GMT+1) Berlin time');
    // Both occurrences of 02:30–02:45 read differently.
    expect(m.rangeLabel('2026-10-25T00:30:00.000Z..2026-10-25T00:45:00.000Z')).toBe('Oct 25, 02:30 (GMT+2) – 02:45 (GMT+2) Berlin time');
    expect(m.rangeLabel('2026-10-25T01:30:00.000Z..2026-10-25T01:45:00.000Z')).toBe('Oct 25, 02:30 (GMT+1) – 02:45 (GMT+1) Berlin time');
    expect(m.rangeLabel('2026-10-25T04:00:00.000Z..2026-10-25T05:00:00.000Z')).toBe('Oct 25, 05:00 – 06:00 Berlin time');
    expect(m.bucketLabel(Date.parse('2026-10-25T00:00:00.000Z'), 3600)).toBe('Oct 25, 02:00 – 02:00 (GMT+2 → GMT+1)');
    // Multi-day buckets off the zone's midnight keep their years.
    expect(m.bucketLabel(Date.parse('2025-12-29T00:00:00.000Z'), 7 * 86_400)).toBe('Dec 29, 2025 01:00 – Jan 5, 2026 01:00');
  });

  it('finds a saved entity view by its query and range, whatever its name or the zone it was saved in', async () => {
    const m = await load('Europe/Berlin');
    const { findSavedEntityView } = await import('@/components/views/save-entity-view-button');
    const range = '2026-11-22T00:00:00.000Z..2026-11-22T04:00:00.000Z';
    const views = [
      { id: 'other', name: 'Hotel — nov 22, 01:00 – 05:00', state: { q: 'tenant:other', range } },
      { id: 'legacy', name: 'Hotel — nov 22, 01:00 – 05:00', state: { q: 'tenant:biz_5', lang: 'query', range } },
    ];
    m.setZonePreference('utc');
    expect(findSavedEntityView(views, 'tenant:biz_5', range)?.id).toBe('legacy');
    expect(findSavedEntityView(views, 'tenant:biz_5', '7d')).toBeUndefined();
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
