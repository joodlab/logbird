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
}

const pad = (n: number) => String(n).padStart(2, '0');
const toTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function withTime(day: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
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
}: TimeRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<DateRange | undefined>({ from: resolved.from, to: resolved.to });
  const [fromTime, setFromTime] = useState(toTime(resolved.from));
  const [toTimeValue, setToTimeValue] = useState(toTime(resolved.to));
  const isPreset = presets.some((p) => p.value === value);

  useEffect(() => {
    if (!open) return;
    setDays({ from: resolved.from, to: resolved.to });
    setFromTime(toTime(resolved.from));
    setToTimeValue(toTime(resolved.to));
  }, [open, resolved.from, resolved.to]);

  const from = days?.from ? withTime(days.from, fromTime) : null;
  const to = days?.to ? withTime(days.to, toTimeValue) : days?.from ? withTime(days.from, toTimeValue) : null;
  const valid = Boolean(from && to && from < to && to.getTime() <= Date.now() + 60_000);

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
                  'flex h-8 items-center justify-between gap-2 rounded-md px-2 text-start text-sm outline-hidden hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:px-3',
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
              disabled={{ after: new Date() }}
              mode="range"
              numberOfMonths={1}
              onSelect={setDays}
              selected={days}
              defaultMonth={resolved.to}
            />
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-xs" htmlFor="tr-from">
                  From
                </Label>
                <Input className="tabular-nums" id="tr-from" size="sm" onChange={(e) => setFromTime(e.target.value)} type="time" value={fromTime} />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-xs" htmlFor="tr-to">
                  To
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
