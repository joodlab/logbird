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
 * Every absolute time in the console goes through these formatters: one zone (the browser's, resolved once) and
 * 24-hour clocks. The zone is labelled by name, never by the instant's own offset, so a session that spans a DST
 * change does not show "GMT+2" on one screen and "GMT+1" on another; tooltips add the UTC instant.
 */
export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const dateFormat = (locale: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: TIME_ZONE });

const timeFmt = dateFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const msFmt = dateFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
});
const dayFmt = dateFormat('en-US', { month: 'short', day: 'numeric' });
const shortTimeFmt = dateFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const fullFmt = dateFormat('en-US', {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dateOnlyFmt = dateFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const dayKeyFmt = dateFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const dayTimeFmt = dateFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

type Instant = string | number | Date;
const at = (v: Instant) => (v instanceof Date ? v : new Date(v));
/** "2026-11-04" in the console zone: compare calendar days without the runtime's default zone. */
export const localDayKey = (v: Instant): string => dayKeyFmt.format(at(v));
/** "14:32" */
export const formatClock = (v: Instant): string => shortTimeFmt.format(at(v));
/** "Nov 4" */
export const formatMonthDay = (v: Instant): string => dayFmt.format(at(v));
/** "Nov 4, 14:32" */
export const formatDayTime = (v: Instant): string => dayTimeFmt.format(at(v));
/** Milliseconds to add to a UTC instant to get console-zone wall-clock time (DST-aware). */
const partsFmt = dateFormat('en-US', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});
export function zoneOffsetMs(v: Instant): number {
  const d = at(v);
  const parts = Object.fromEntries(partsFmt.formatToParts(d).map((p) => [p.type, p.value]));
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

export const formatTime = (iso: string): string => timeFmt.format(new Date(iso));
export const formatTimeMs = (iso: string): string => msFmt.format(new Date(iso));
export const formatDay = (iso: string): string => dayFmt.format(new Date(iso));
/** "Wed, Nov 4, 2026, 14:32:10 Europe/Berlin" */
export const formatFull = (iso: string): string => `${fullFmt.format(new Date(iso))} ${TIME_ZONE}`;
export const formatDate = (iso: string): string => dateOnlyFmt.format(new Date(iso));
/** "2026-11-04 14:32:10.123 UTC" — the unambiguous instant, for tooltips and copying. */
export const formatUtc = (iso: string): string => `${new Date(iso).toISOString().replace('T', ' ').replace('Z', '')} UTC`;

/** "Nov 4 · 14:32:10" in tables; time only when it happened today. */
export function formatTimestamp(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (localDayKey(d) === localDayKey(now)) return timeFmt.format(d);
  return `${dayFmt.format(d)}, ${shortTimeFmt.format(d)}`;
}

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
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
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
