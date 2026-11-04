import type { HistogramResponse } from '@trailmark/contracts';
import { ChartContainer, ChartTooltip } from '@trailmark/ui/components/ui/chart';
import { cn } from '@trailmark/ui/lib/utils';
import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { formatAxis } from '@/lib/format';
import { OutcomeTooltip } from './chart-tooltip';
import { outcomeChartConfig, SERIES, type SeriesKey, tickFormatter, toSeries } from './outcome-series';

interface OutcomeAreaChartProps {
  data: HistogramResponse | undefined;
  height?: number;
  /** Click a band (or a legend chip) → filter by that outcome. */
  onSelectOutcome?: (outcome: SeriesKey) => void;
  className?: string;
}

/** Stacked area of events by outcome. Bands and legend chips are clickable. */
export function OutcomeAreaChart({ data, height = 240, onSelectOutcome, className }: OutcomeAreaChartProps) {
  const rows = useMemo(() => toSeries(data), [data]);
  const [hover, setHover] = useState<SeriesKey | null>(null);
  const present = SERIES.filter((k) => rows.some((r) => r[k] > 0));
  const interval = data?.interval ?? 60;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <ChartContainer className="aspect-auto w-full" config={outcomeChartConfig} style={{ height }}>
        <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            {SERIES.map((k) => (
              <linearGradient id={`fill-${k}`} key={k} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={`var(--color-${k})`} stopOpacity={k === 'success' ? 0.26 : 0.8} />
                <stop offset="100%" stopColor={`var(--color-${k})`} stopOpacity={k === 'success' ? 0.03 : 0.55} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="0" vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="ts"
            minTickGap={48}
            scale="time"
            tickFormatter={tickFormatter(interval)}
            tickLine={false}
            tickMargin={8}
            type="number"
            domain={['dataMin', 'dataMax']}
          />
          <YAxis allowDecimals={false} axisLine={false} tickFormatter={formatAxis} tickLine={false} width={40} />
          <ChartTooltip
            content={({ active, payload }) =>
              active ? (
                <OutcomeTooltip
                  hint={onSelectOutcome ? 'Click a band to open these events' : undefined}
                  interval={interval}
                  row={payload?.[0]?.payload}
                />
              ) : null
            }
            cursor={{ stroke: 'var(--foreground)', strokeOpacity: 0.15 }}
          />
          {SERIES.map((k) => (
            <Area
              activeDot={false}
              className={onSelectOutcome ? 'cursor-pointer' : undefined}
              dataKey={k}
              fill={`url(#fill-${k})`}
              fillOpacity={hover && hover !== k ? 0.35 : 1}
              isAnimationActive={false}
              key={k}
              onClick={() => onSelectOutcome?.(k)}
              onMouseEnter={() => setHover(k)}
              onMouseLeave={() => setHover(null)}
              stackId="1"
              // Only the base series draws a line: stacked zero-height series would otherwise trace colored
              // strokes along the top edge of the success band.
              stroke={k === 'success' ? `var(--color-${k})` : 'none'}
              strokeOpacity={hover && hover !== k ? 0.4 : 1}
              strokeWidth={1.5}
              type="monotone"
            />
          ))}
        </AreaChart>
      </ChartContainer>
      <div className="flex flex-wrap items-center gap-1.5">
        {(present.length ? present : SERIES.slice(0, 1)).map((k) => (
          <button
            className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground text-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            disabled={!onSelectOutcome}
            key={k}
            onClick={() => onSelectOutcome?.(k)}
            onMouseEnter={() => setHover(k)}
            onMouseLeave={() => setHover(null)}
            type="button"
          >
            <span className="size-2 rounded-[2px]" style={{ background: outcomeChartConfig[k].color }} />
            {outcomeChartConfig[k].label}
          </button>
        ))}
      </div>
    </div>
  );
}
