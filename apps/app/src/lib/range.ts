/**
 * Time ranges are strings so they live in the URL and in saved views unchanged:
 * relative presets ("15m", "1h", "24h", "7d", "30d", "90d") or an absolute
 * "<isoFrom>..<isoTo>" window (what drag-to-zoom and the custom picker produce).
 */

import { formatClock, formatDate, formatMonthDay, localDayKey } from './format';

export const RANGE_PRESETS = [
  { value: '15m', label: 'Last 15 minutes', short: '15m' },
  { value: '1h', label: 'Last hour', short: '1h' },
  { value: '6h', label: 'Last 6 hours', short: '6h' },
  { value: '24h', label: 'Last 24 hours', short: '24h' },
  { value: '7d', label: 'Last 7 days', short: '7d' },
  { value: '30d', label: 'Last 30 days', short: '30d' },
  { value: '90d', label: 'Last 90 days', short: '90d' },
] as const;

export const DEFAULT_RANGE = '24h';

const RELATIVE_RE = /^(\d+)(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export interface ResolvedRange {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  relative: boolean;
}

export function isValidRange(range: string): boolean {
  if (RELATIVE_RE.test(range)) return true;
  const [a, b] = range.split('..');
  return Boolean(a && b && !Number.isNaN(Date.parse(a)) && !Number.isNaN(Date.parse(b)) && Date.parse(a) < Date.parse(b));
}

export function rangeDurationMs(range: string): number {
  const r = resolveRange(range);
  return r.toMs - r.fromMs;
}

/** Resolve to concrete ISO bounds. Relative ranges end "now" (rounded down to the second). */
export function resolveRange(range: string, now = Date.now()): ResolvedRange {
  const rel = RELATIVE_RE.exec(range);
  if (rel) {
    const toMs = Math.floor(now / 1000) * 1000;
    const fromMs = toMs - Number(rel[1]) * UNIT_MS[rel[2] as keyof typeof UNIT_MS];
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fromMs, toMs, relative: true };
  }
  const [a, b] = range.split('..');
  if (a && b) {
    const fromMs = Date.parse(a);
    const toMs = Date.parse(b);
    if (!(Number.isNaN(fromMs) || Number.isNaN(toMs)) && fromMs < toMs) {
      return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fromMs, toMs, relative: false };
    }
  }
  return resolveRange(DEFAULT_RANGE, now);
}

export function absoluteRange(fromMs: number, toMs: number): string {
  return `${new Date(Math.min(fromMs, toMs)).toISOString()}..${new Date(Math.max(fromMs, toMs)).toISOString()}`;
}

/**
 * A range inside a sentence: "the last 30 days", "the last hour", or an absolute span as written ("Nov 1 09:00 – Nov 7
 * 09:00"), never a lowercased date.
 */
export function rangePhrase(range: string): string {
  const preset = RANGE_PRESETS.find((p) => p.value === range);
  return preset ? `the ${preset.label.charAt(0).toLowerCase()}${preset.label.slice(1)}` : rangeLabel(range);
}

export function rangeLabel(range: string): string {
  const preset = RANGE_PRESETS.find((p) => p.value === range);
  if (preset) return preset.label;
  const rel = RELATIVE_RE.exec(range);
  if (rel) {
    const unit = { m: 'minute', h: 'hour', d: 'day' }[rel[2] as 'm' | 'h' | 'd'];
    return `Last ${rel[1]} ${unit}${rel[1] === '1' ? '' : 's'}`;
  }
  const r = resolveRange(range);
  // Years appear whenever the span leaves the current year, so a ten-year search never reads as one day.
  const year = (ms: number) => localDayKey(ms).slice(0, 4);
  const withYear = year(r.fromMs) !== year(r.toMs) || year(r.fromMs) !== year(Date.now());
  const day = (ms: number) => (withYear ? formatDate(new Date(ms).toISOString()) : formatMonthDay(ms));
  return localDayKey(r.fromMs) === localDayKey(r.toMs)
    ? `${day(r.fromMs)}, ${formatClock(r.fromMs)} – ${formatClock(r.toMs)}`
    : `${day(r.fromMs)} ${formatClock(r.fromMs)} – ${day(r.toMs)} ${formatClock(r.toMs)}`;
}

export function rangeShortLabel(range: string): string {
  const preset = RANGE_PRESETS.find((p) => p.value === range);
  if (preset) return preset.short;
  return rangeLabel(range);
}

/** The window of the same length immediately before `range` (for KPI deltas). */
export function previousWindow(range: string): { from: string; to: string } {
  const r = resolveRange(range);
  const len = r.toMs - r.fromMs;
  return { from: new Date(r.fromMs - len).toISOString(), to: r.from };
}

/**
 * Every timestamp ingest can admit, as of now: from 3650 days before arrival to a day after it (packages/clickhouse
 * timestamp admission), with a day of slack on each side for clocks and the time since arrival. Used where a search
 * must find every stored match, such as all children of an event.
 */
export function admittedRange(now = Date.now(), oldestStoredIso?: string | null): string {
  const admitted = now - 3651 * UNIT_MS.d;
  // A purge that has not run yet can leave older rows: reach back to the oldest one the project still holds.
  const oldest = oldestStoredIso ? Date.parse(oldestStoredIso) - UNIT_MS.d : Number.NaN;
  return absoluteRange(Number.isNaN(oldest) ? admitted : Math.min(admitted, oldest), now + 2 * UNIT_MS.d);
}
