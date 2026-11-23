import { consoleTimeZone } from './time-zone';

const numberFmt = new Intl.NumberFormat('en-US');
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

export const formatNumber = (n: number): string => numberFmt.format(n);
export const formatCompact = (n: number): string => (Math.abs(n) < 10_000 ? numberFmt.format(n) : compactFmt.format(n));
/** Axis ticks: 950, 1.2K, 12K. */
export const formatAxis = (n: number): string => (Math.abs(n) < 1000 ? numberFmt.format(n) : compactFmt.format(n));
export const formatPercent = (ratio: number): string => pctFmt.format(Number.isFinite(ratio) ? ratio : 0);

/** Relative change between two values, or null when there is no baseline. */
export function delta(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return (current - previous) / previous;
}

/**
 * Every absolute time in the console goes through these formatters: one zone (the browser's, or UTC when the reader
 * chose it; see `lib/time-zone.ts`) and 24-hour clocks. The zone is labelled by name, never by the instant's own
 * offset, so a session that spans a DST change does not show "GMT+2" on one screen and "GMT+1" on another; tooltips
 * add the UTC instant.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
/** A formatter in the current console zone, created once per zone. */
function inZone(key: string, locale: string, options: Intl.DateTimeFormatOptions, zone = consoleTimeZone()): Intl.DateTimeFormat {
  const id = `${zone}|${key}`;
  let f = formatters.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
    formatters.set(id, f);
  }
  return f;
}
const timeFmt = () => inZone('time', 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const msFmt = () => inZone('ms', 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false });
const dayFmt = () => inZone('day', 'en-US', { month: 'short', day: 'numeric' });
const dayYearFmt = () => inZone('dayYear', 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const shortTimeFmt = () => inZone('shortTime', 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const secondTimeFmt = () => inZone('secondTime', 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const msTimeFmt = () =>
  inZone('msTime', 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false });
const fullFmt = (zone?: string) =>
  inZone(
    'full',
    'en-US',
    { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
    zone,
  );
const dateOnlyFmt = () => inZone('dateOnly', 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const dayKeyFmt = () => inZone('dayKey', 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const dayTimeFmt = () => inZone('dayTime', 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const monthYearFmt = () => inZone('monthYear', 'en-US', { year: 'numeric', month: 'short' });
const partsFmt = () =>
  inZone('parts', 'en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });

/** The zone every console time is shown in ("Europe/Berlin", or "UTC"). */
export const displayTimeZone = (): string => consoleTimeZone();

type Instant = string | number | Date;
const at = (v: Instant) => (v instanceof Date ? v : new Date(v));
/** "2026-11-04" in the console zone: compare calendar days without the runtime's default zone. */
export const localDayKey = (v: Instant): string => dayKeyFmt().format(at(v));
/** "14:32" */
export const formatClock = (v: Instant): string => shortTimeFmt().format(at(v));
/** "14:32:07", or "14:32:07.042" with milliseconds: for spans too short to tell apart by the minute. */
export const formatClockPrecise = (v: Instant, unit: 'second' | 'millisecond'): string =>
  (unit === 'second' ? secondTimeFmt() : msTimeFmt()).format(at(v));
/** "Nov 4" */
export const formatMonthDay = (v: Instant): string => dayFmt().format(at(v));
/** "Nov 2026" */
export const formatMonthYear = (v: Instant): string => monthYearFmt().format(at(v));
/** "Nov 4, 14:32" */
export const formatDayTime = (v: Instant): string => dayTimeFmt().format(at(v));
/** Milliseconds to add to a UTC instant to get console-zone wall-clock time (DST-aware). */
export function zoneOffsetMs(v: Instant): number {
  const d = at(v);
  const parts = Object.fromEntries(
    partsFmt()
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - Math.floor(d.getTime() / 1000) * 1000;
}

export const formatTime = (iso: string): string => timeFmt().format(new Date(iso));
export const formatTimeMs = (iso: string): string => msFmt().format(new Date(iso));
export const formatDay = (iso: string): string => dayFmt().format(new Date(iso));
/** "Wed, Nov 4, 2026, 14:32:10 Europe/Berlin" */
export const formatFull = (iso: string): string => `${fullFmt().format(new Date(iso))} ${consoleTimeZone()}`;
export const formatDate = (iso: string): string => dateOnlyFmt().format(new Date(iso));
/** "Wed, Nov 4, 2026, 15:32:10 Europe/Berlin" in a given zone, whatever the console zone is. */
export const formatInZone = (iso: string, zone: string): string => `${fullFmt(zone).format(new Date(iso))} ${zone}`;
/** True when the console zone shows this instant's wall clock twice that day (the hour repeated when clocks go back). */
export function isRepeatedWallTime(v: Instant): boolean {
  const ms = at(v).getTime();
  const own = zoneOffsetMs(ms);
  return [zoneOffsetMs(ms - 86_400_000), zoneOffsetMs(ms + 86_400_000)].some((other) => {
    if (other === own) return false;
    const twin = ms + own - other;
    return twin + zoneOffsetMs(twin) === ms + own;
  });
}
/** "GMT+2", "GMT-3:30": the console zone's offset at an instant (named where a window crosses a clock change). */
export function formatOffset(v: Instant): string {
  const m = Math.round(zoneOffsetMs(v) / 60_000);
  const abs = Math.abs(m);
  return `GMT${m < 0 ? '-' : '+'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}
/** "2026-11-04 14:32:10.123 UTC" — the unambiguous instant, for tooltips and copying. */
export const formatUtc = (iso: string): string => `${new Date(iso).toISOString().replace('T', ' ').replace('Z', '')} UTC`;

/**
 * Tables: "Nov 4, 14:32:10" for every row (year added outside the current year), so rows from today and earlier read
 * the same way and compare directly with exports. The zone is named once, in the column header.
 */
export function formatTimestamp(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  return `${(timestampNeedsYear(iso, now) ? dayYearFmt() : dayFmt()).format(d)}, ${timeFmt().format(d)}`;
}
/** True when `formatTimestamp` adds the year (the time is outside the current year in the console zone). */
export const timestampNeedsYear = (iso: string, now = Date.now()): boolean => localDayKey(iso).slice(0, 4) !== localDayKey(now).slice(0, 4);

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 10_000) return 'just now';
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  if (abs < 365 * 86_400_000) return rtf.format(Math.round(diff / (30 * 86_400_000)), 'month');
  return rtf.format(Math.round(diff / (365 * 86_400_000)), 'year');
}

/** "120 ms", "4.2 s", "3 m 10 s". */
export function formatDuration(ms: number): string {
  if (ms < 1) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  // Round to whole seconds before splitting, so 119,999 ms reads "2 m", never "1 m 60 s".
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m} m ${s} s` : `${m} m`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} m`;
}

export function formatRetention(days: number): string {
  if (days % 365 === 0) {
    const y = days / 365;
    return `${y} year${y === 1 ? '' : 's'}`;
  }
  return `${days} days`;
}

export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}`.toUpperCase();
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
