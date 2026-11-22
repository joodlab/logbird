import { CalendarIcon, CheckIcon, ChevronDownIcon, ClockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Calendar } from './ui/calendar';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export interface TimeRangePreset {
  value: string;
  label: string;
  short: string;
}

interface TimeRangePickerProps {
  /** Current range value (a preset value or an app-defined absolute encoding). */
  value: string;
  presets: readonly TimeRangePreset[];
  /** Concrete bounds of `value`, used to seed the custom editor. */
  resolved: { from: Date; to: Date };
  /** Human label for the trigger. */
  label: string;
  onChange: (value: string) => void;
  /** Encode an absolute window into a value. */
  toAbsolute: (from: Date, to: Date) => string;
  className?: string;
  align?: 'start' | 'end';
  size?: 'sm' | 'default';
  /**
   * The zone the calendar and the From/To clocks edit in (default: the browser's). `offsetMs(utcMs)` is what to add to
   * a UTC instant to get that zone's wall-clock time; `label` names it beside From/To.
   */
  zone?: { offsetMs: (utcMs: number) => number; label: string };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The browser's own offset, when no zone is given. */
const browserOffset = (utcMs: number) => -new Date(utcMs).getTimezoneOffset() * 60_000;

/**
 * The editor keeps a day and a clock apart: the day is a calendar `Date` at local noon (noon exists on every day, so the
 * browser's own DST gaps never move it) and the clock is "HH:MM" in the chosen zone. A zone's wall time is never pushed
 * through a browser-local `Date`, so 02:30 UTC stays 02:30 even on the day a Berlin browser skips 02:00–03:00.
 */
export function toWall(instant: Date, offsetMs: (utcMs: number) => number): { day: Date; time: string } {
  const u = new Date(instant.getTime() + offsetMs(instant.getTime()));
  return {
    day: new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 12),
    time: `${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}`,
  };
}
/**
 * The instant a day and an "HH:MM" clock name in the zone. `gap`: the zone skips that clock that day (spring forward), so
 * no instant has it. `repeated`: the clock happens twice (fall back); the first occurrence is returned and `offsetMs` says
 * which. `invalid`: the clock is incomplete.
 */
export type WallInstant = { status: 'ok' | 'repeated'; date: Date; offsetMs: number } | { status: 'gap' | 'invalid'; date: null; offsetMs: null };
export function resolveWall(day: Date, time: string, offsetMs: (utcMs: number) => number): WallInstant {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return { status: 'invalid', date: null, offsetMs: null };
  const asUtc = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), Number(match[1]), Number(match[2]));
  // The zone's offsets either side of this wall time; each candidate is real only if it reads back as that wall time.
  const offsets = [...new Set([offsetMs(asUtc - 86_400_000), offsetMs(asUtc), offsetMs(asUtc + 86_400_000)])];
  const real = offsets
    .map((o) => asUtc - o)
    .filter((ms) => ms + offsetMs(ms) === asUtc)
    .sort((a, b) => a - b);
  const [first] = real;
  if (first === undefined) return { status: 'gap', date: null, offsetMs: null };
  return { status: real.length > 1 ? 'repeated' : 'ok', date: new Date(first), offsetMs: offsetMs(first) };
}
/** The instant a day and clock name (the first one when the clock repeats), or null when it does not exist. */
export function fromWall(day: Date, time: string, offsetMs: (utcMs: number) => number): Date | null {
  return resolveWall(day, time, offsetMs).date;
}
const sameDay = (a: Date | undefined, b: Date) =>
  Boolean(a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate());
const gmt = (offset: number) => {
  const m = Math.round(offset / 60_000);
  return `GMT${m < 0 ? '-' : '+'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? `:${pad(Math.abs(m) % 60)}` : ''}`;
};

/** Presets + calendar/time editor, Datadog/Grafana-style. Values stay strings so they fit in URLs. */
export function TimeRangePicker({
  value,
  presets,
  resolved,
  label,
  onChange,
  toAbsolute,
  className,
  align = 'end',
  size = 'sm',
  zone,
}: TimeRangePickerProps) {
  const offsetMs = zone?.offsetMs ?? browserOffset;
  const wallFrom = toWall(resolved.from, offsetMs);
  const wallTo = toWall(resolved.to, offsetMs);
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<DateRange | undefined>({ from: wallFrom.day, to: wallTo.day });
  const [fromTime, setFromTime] = useState(wallFrom.time);
  const [toTimeValue, setToTimeValue] = useState(wallTo.time);
  const isPreset = presets.some((p) => p.value === value);

  // Reseed when the editor opens, when the range changes, and when the zone changes (the offset function can be shared).
  // biome-ignore lint/correctness/useExhaustiveDependencies: zone?.label names the zone that offsetMs belongs to.
  useEffect(() => {
    if (!open) return;
    const f = toWall(resolved.from, offsetMs);
    const t = toWall(resolved.to, offsetMs);
    setDays({ from: f.day, to: t.day });
    setFromTime(f.time);
    setToTimeValue(t.time);
  }, [open, resolved.from, resolved.to, offsetMs, zone?.label]);

  // An endpoint the reader did not change keeps its exact instant (seconds, and which of a repeated hour it was).
  const endpoint = (day: Date | undefined, time: string, original: Date, shown: { day: Date; time: string }): WallInstant | null => {
    if (!day) return null;
    if (sameDay(day, shown.day) && time === shown.time) return { status: 'ok', date: original, offsetMs: offsetMs(original.getTime()) };
    return resolveWall(day, time, offsetMs);
  };
  const fromWallInstant = endpoint(days?.from, fromTime, resolved.from, wallFrom);
  const toWallInstant = endpoint(days?.to ?? days?.from, toTimeValue, resolved.to, wallTo);
  const from = fromWallInstant?.date ?? null;
  const to = toWallInstant?.date ?? null;
  const valid = Boolean(from && to && from < to && to.getTime() <= Date.now() + 60_000);
  const zoneSuffix = zone ? ` · ${zone.label}` : '';
  const zoneName = zone?.label ?? 'this time zone';
  const problem = (label: string, w: WallInstant | null, time: string) =>
    !w
      ? null
      : w.status === 'invalid'
        ? `Enter a ${label} time.`
        : w.status === 'gap'
          ? `${time} does not exist in ${zoneName} that day (the clocks skip it).`
          : w.status === 'repeated'
            ? `${time} happens twice in ${zoneName} that day; using the first (${gmt(w.offsetMs)}).`
            : null;
  const notes = [problem('start', fromWallInstant, fromTime), problem('end', toWallInstant, toTimeValue)].filter(Boolean);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button className={cn('justify-between gap-2 font-normal tabular-nums', className)} size={size} variant="outline">
            <span className="flex min-w-0 items-center gap-1.5">
              {isPreset ? <ClockIcon className="text-muted-foreground" /> : <CalendarIcon className="text-muted-foreground" />}
              <span className="truncate">{label}</span>
            </span>
            <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent align={align} className="w-auto max-w-[calc(100vw-1rem)] p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-row flex-wrap gap-0.5 border-b p-1.5 sm:w-44 sm:flex-col sm:flex-nowrap sm:border-e sm:border-b-0">
            {presets.map((p) => (
              <button
                aria-current={p.value === value || undefined}
                className={cn(
                  'flex h-8 items-center justify-between gap-2 rounded-md px-2 text-start text-sm outline-none focus-visible:outline-hidden hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:px-3',
                  p.value === value && 'font-medium text-foreground',
                  p.value !== value && 'text-muted-foreground',
                )}
                key={p.value}
                onClick={() => {
                  onChange(p.value);
                  setOpen(false);
                }}
                type="button"
              >
                <span className="hidden sm:inline">{p.label}</span>
                <span className="sm:hidden">{p.short}</span>
                {p.value === value ? <CheckIcon className="hidden size-3.5 text-brand sm:block" /> : null}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-3 p-3">
            <Calendar
              disabled={{ after: toWall(new Date(), offsetMs).day }}
              today={toWall(new Date(), offsetMs).day}
              mode="range"
              numberOfMonths={1}
              onSelect={setDays}
              selected={days}
              defaultMonth={wallTo.day}
            />
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-xs" htmlFor="tr-from">
                  From{zoneSuffix}
                </Label>
                <Input className="tabular-nums" id="tr-from" size="sm" onChange={(e) => setFromTime(e.target.value)} type="time" value={fromTime} />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-xs" htmlFor="tr-to">
                  To{zoneSuffix}
                </Label>
                <Input
                  className="tabular-nums"
                  id="tr-to"
                  size="sm"
                  onChange={(e) => setToTimeValue(e.target.value)}
                  type="time"
                  value={toTimeValue}
                />
              </div>
            </div>
            {notes.length ? (
              <p className="max-w-64 text-muted-foreground text-xs" role="status">
                {notes.join(' ')}
              </p>
            ) : null}
            <Button
              disabled={!valid}
              onClick={() => {
                if (from && to) {
                  onChange(toAbsolute(from, to));
                  setOpen(false);
                }
              }}
              size="sm"
            >
              Apply custom range
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
