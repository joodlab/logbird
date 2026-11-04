const numberFmt = new Intl.NumberFormat('en-US');
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

export const formatNumber = (n: number): string => numberFmt.format(n);
export const formatCompact = (n: number): string => (Math.abs(n) < 10_000 ? numberFmt.format(n) : compactFmt.format(n));
export const formatPercent = (ratio: number): string => pctFmt.format(Number.isFinite(ratio) ? ratio : 0);

/** Relative change between two values, or null when there is no baseline. */
export function delta(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return (current - previous) / previous;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const msFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
});
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const shortTimeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const fullFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short',
});
const dateOnlyFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export const formatTime = (iso: string): string => timeFmt.format(new Date(iso));
export const formatTimeMs = (iso: string): string => msFmt.format(new Date(iso));
export const formatDay = (iso: string): string => dayFmt.format(new Date(iso));
export const formatFull = (iso: string): string => fullFmt.format(new Date(iso));
export const formatDate = (iso: string): string => dateOnlyFmt.format(new Date(iso));

/** "Nov 4 · 14:32:10" in tables; time only when it happened today. */
export function formatTimestamp(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return timeFmt.format(d);
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
