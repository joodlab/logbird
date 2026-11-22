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
export function fromWall(day: Date, time: string, offsetMs: (utcMs: number) => number): Date {
  const [h, m] = time.split(':').map(Number);
  const asUtc = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), h ?? 0, m ?? 0);
  // The offset at the guess, then at the corrected instant (the zone's own DST change inside the gap).
  const first = asUtc - offsetMs(asUtc);
  return new Date(asUtc - offsetMs(first));
}

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

  useEffect(() => {
    if (!open) return;
    const f = toWall(resolved.from, offsetMs);
    const t = toWall(resolved.to, offsetMs);
    setDays({ from: f.day, to: t.day });
    setFromTime(f.time);
    setToTimeValue(t.time);
  }, [open, resolved.from, resolved.to, offsetMs]);

  const from = days?.from ? fromWall(days.from, fromTime, offsetMs) : null;
  const toDay = days?.to ?? days?.from;
  const to = toDay ? fromWall(toDay, toTimeValue, offsetMs) : null;
  const valid = Boolean(from && to && from < to && to.getTime() <= Date.now() + 60_000);
  const zoneSuffix = zone ? ` · ${zone.label}` : '';

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
