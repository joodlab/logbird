/**
 * Time ranges are strings so they live in the URL and in saved views unchanged:
 * relative presets ("15m", "1h", "24h", "7d", "30d", "90d") or an absolute
 * "<isoFrom>..<isoTo>" window (what drag-to-zoom and the custom picker produce).
 */

import { formatClock, formatClockPrecise, formatDate, formatMonthDay, formatOffset, isRepeatedWallTime, localDayKey, zoneOffsetMs } from './format';
import { consoleTimeZone, shortZoneLabel } from './time-zone';

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

/**
 * "Everything the project stores": entity pages pass it on when they link out of a full history, so following another
 * entity from there never inherits a computed window (like "2d") the reader did not choose.
 */
export const ALL_RANGE = 'all';
/** 2000-01-01T00:00:00Z: earlier than any event ingest can admit (3650 days before receipt) until 2035. */
const ALL_FROM_MS = Date.UTC(2000, 0, 1);

/** Latest instant a range may name: 2299-12-31T23:59:59.999Z, the end of ClickHouse's DateTime64 calendar. */
const MAX_MS = Date.UTC(2299, 11, 31, 23, 59, 59, 999);
/** An endpoint the API and storage accept: a finite instant from 1970 (before any admissible event) to 2299. */
const representable = (ms: number) => Number.isFinite(ms) && ms >= 0 && ms <= MAX_MS;

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
/** An absolute endpoint as written: an ISO instant whose date and time exist (no Feb 30, no 24:00), else NaN. */
function parseInstant(text: string): number {
  const m = ISO_INSTANT.exec(text);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return Number.NaN;
  return Date.parse(text);
}

/** The length of a relative preset such as "24h". */
function rangeDurationOf(relative: string): number {
  const rel = RELATIVE_RE.exec(relative);
  return rel ? Number(rel[1]) * UNIT_MS[rel[2] as keyof typeof UNIT_MS] : 0;
}

/** Bounds of a relative or absolute range, or null when it names no window (zero, reversed or unrepresentable). */
function windowOf(range: string, now: number): { fromMs: number; toMs: number; relative: boolean } | null {
  const rel = RELATIVE_RE.exec(range);
  if (rel) {
    const toMs = Math.floor(now / 1000) * 1000;
    const fromMs = toMs - Number(rel[1]) * UNIT_MS[rel[2] as keyof typeof UNIT_MS];
    return representable(fromMs) && fromMs < toMs ? { fromMs, toMs, relative: true } : null;
  }
  const [a, b, extra] = range.split('..');
  if (!a || !b || extra !== undefined) return null;
  const fromMs = parseInstant(a);
  const toMs = parseInstant(b);
  return representable(fromMs) && representable(toMs) && fromMs < toMs ? { fromMs, toMs, relative: false } : null;
}

/**
 * Whether a range (from a URL, a saved view or a link someone shared) names a real window: "all", a positive relative
 * duration whose start is representable ("0d" and "99999999999d" are not), or two representable instants in order.
 * Anything else falls back to the page's default range.
 */
export function isValidRange(range: string, now = Date.now()): boolean {
  return range === ALL_RANGE || windowOf(range, now) !== null;
}

export function rangeDurationMs(range: string): number {
  const r = resolveRange(range);
  return r.toMs - r.fromMs;
}

/** Resolve to concrete ISO bounds. Relative ranges end "now" (rounded down to the second). */
export function resolveRange(range: string, now = Date.now()): ResolvedRange {
  if (range === ALL_RANGE) {
    // Everything stored: from a fixed early bound (before any timestamp ingest can have admitted, and stable, so the
    // window never creeps forward past a row the purge has not removed yet) to two days ahead (ingest admits a day).
    const toMs = Math.floor(now / 1000) * 1000 + 2 * UNIT_MS.d;
    return { from: new Date(ALL_FROM_MS).toISOString(), to: new Date(toMs).toISOString(), fromMs: ALL_FROM_MS, toMs, relative: true };
  }
  // The same rule as isValidRange: a range that names no window resolves to the default instead of throwing.
  const w = windowOf(range, now);
  if (w) return { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString(), ...w };
  // The default window, computed directly (never recursing): clamped at 1970 for a clock that early (tests inject one).
  const toMs = Math.floor(now / 1000) * 1000;
  const fromMs = Math.max(0, toMs - rangeDurationOf(DEFAULT_RANGE));
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fromMs, toMs, relative: true };
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
  // A stored or shared range that names no window opens as the default: label it as what opens.
  if (!isValidRange(range)) return rangeLabel(DEFAULT_RANGE);
  if (range === ALL_RANGE) return 'All time';
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
  // An absolute window names the zone its clock times are in.
  const zone = consoleTimeZone();
  const inZone = zone === 'UTC' ? ' UTC' : ` ${shortZoneLabel(zone)} time`;
  // Across a clock change (02:45 – 02:00 when the clocks go back) each end names its offset, so the window never reads backwards.
  // Inside a repeated hour the clock alone is ambiguous too.
  const withOffsets = zoneOffsetMs(r.fromMs) !== zoneOffsetMs(r.toMs) || isRepeatedWallTime(r.fromMs) || isRepeatedWallTime(r.toMs);
  // A span shorter than a minute (a one-event operation opens a 1 ms window) gets seconds, or milliseconds when the
  // seconds still match, so its two ends never read the same (#197).
  const precise =
    formatClock(r.fromMs) !== formatClock(r.toMs)
      ? formatClock
      : formatClockPrecise(r.fromMs, 'second') !== formatClockPrecise(r.toMs, 'second')
        ? (ms: number) => formatClockPrecise(ms, 'second')
        : (ms: number) => formatClockPrecise(ms, 'millisecond');
  const clock = (ms: number) => (withOffsets ? `${precise(ms)} (${formatOffset(ms)})` : precise(ms));
  return localDayKey(r.fromMs) === localDayKey(r.toMs)
    ? `${day(r.fromMs)}, ${clock(r.fromMs)} – ${clock(r.toMs)}${inZone}`
    : `${day(r.fromMs)} ${clock(r.fromMs)} – ${day(r.toMs)} ${clock(r.toMs)}${inZone}`;
}

/** A range label inside a sentence: "last 7 days", "all time", but "Nov 22, 08:00 – 10:00 Berlin time" keeps its capitals. */
export const rangeInSentence = (label: string): string => (/^(Last|All) /.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label);

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
 * A relative range that covers everything since `firstSeenIso` (whole days, plus one so the first event is inside),
 * for an entity's full history. Relative, so live tail and "now" keep working; the string only changes once a day.
 */
export function historyRange(firstSeenIso: string, now = Date.now(), lastSeenIso?: string): string {
  const first = Date.parse(firstSeenIso);
  if (Number.isNaN(first)) return '90d';
  const days = Math.max(1, Math.ceil((now - first) / UNIT_MS.d) + 1);
  // Ingest admits events stamped up to a day ahead; a relative range ends now and would hide them.
  const last = lastSeenIso ? Date.parse(lastSeenIso) : Number.NaN;
  // A relative range ends at now rounded down to the second (exclusive): a last event at or after that point would be
  // cut off. Bounds then come from the entity's own timestamps only, so the range (and every query key) is stable.
  if (!Number.isNaN(last) && last >= Math.floor(now / 1000) * 1000) return absoluteRange(first - UNIT_MS.d, last + 1);
  return `${days}d`;
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
