/**
 * Time ranges are strings so they live in the URL and in saved views unchanged:
 * relative presets ("15m", "1h", "24h", "7d", "30d", "90d") or an absolute
 * "<isoFrom>..<isoTo>" window (what drag-to-zoom and the custom picker produce).
 */

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

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export function rangeLabel(range: string): string {
  const preset = RANGE_PRESETS.find((p) => p.value === range);
  if (preset) return preset.label;
  const rel = RELATIVE_RE.exec(range);
  if (rel) {
    const unit = { m: 'minute', h: 'hour', d: 'day' }[rel[2] as 'm' | 'h' | 'd'];
    return `Last ${rel[1]} ${unit}${rel[1] === '1' ? '' : 's'}`;
  }
  const r = resolveRange(range);
  const from = new Date(r.fromMs);
  const to = new Date(r.toMs);
  const sameDay = from.toDateString() === to.toDateString();
  return sameDay
    ? `${dateFmt.format(from)}, ${timeFmt.format(from)} – ${timeFmt.format(to)}`
    : `${dateFmt.format(from)} ${timeFmt.format(from)} – ${dateFmt.format(to)} ${timeFmt.format(to)}`;
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

/** Pick a histogram bucket (seconds) that yields roughly `target` bars. */
export function pickInterval(range: string, target = 60): number {
  const seconds = rangeDurationMs(range) / 1000;
  const candidates = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400];
  return candidates.find((c) => seconds / c <= target) ?? 86_400;
}
