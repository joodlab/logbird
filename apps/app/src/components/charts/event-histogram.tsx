import type { HistogramResponse } from '@logbird/contracts';
import { ChartContainer, ChartTooltip } from '@logbird/ui/components/ui/chart';
import { cn } from '@logbird/ui/lib/utils';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ReferenceArea, XAxis, YAxis } from 'recharts';
import { formatAxis } from '@/lib/format';
import { OutcomeTooltip } from './chart-tooltip';
import { bucketTicks, outcomeChartConfig, SERIES, toSeries } from './outcome-series';

interface EventHistogramProps {
  data: HistogramResponse | undefined;
  height?: number;
  /** Called with the selected window after a drag (or a single bucket click). */
  onZoom?: (fromMs: number, toMs: number) => void;
  className?: string;
  loading?: boolean;
  /**
   * The bars belong to an earlier query (the current one was rejected): dim them, say so, and turn zoom off, which
   * would otherwise apply a new range to the broken query.
   */
  stale?: boolean;
}

interface ChartPointerState {
  activeLabel?: string | number;
  activeTooltipIndex?: number | string | null;
}

/** Stacked outcome bars. Drag across bars to zoom the time range; click one bar to zoom into it. */
export function EventHistogram({ data, height = 120, onZoom: onZoomProp, className, loading, stale = false }: EventHistogramProps) {
  const onZoom = stale ? undefined : onZoomProp;
  const rows = useMemo(() => toSeries(data), [data]);
  const interval = data?.interval ?? 60;
  const axis = useMemo(() => bucketTicks(rows, interval), [rows, interval]);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);

  const pointTs = (state: ChartPointerState | null | undefined): number | null => {
    if (!state) return null;
    if (typeof state.activeLabel === 'number') return state.activeLabel;
    const index = Number(state.activeTooltipIndex);
    return Number.isFinite(index) ? (rows[index]?.ts ?? null) : null;
  };

  const finish = () => {
    if (drag && onZoom) {
      const from = Math.min(drag.start, drag.end);
      const to = Math.max(drag.start, drag.end) + interval * 1000;
      onZoom(from, Math.min(to, Date.now()));
    }
    setDrag(null);
  };

  return (
    <div className={cn('relative select-none', className)} data-stale={stale || undefined}>
      {stale ? (
        <span
          className="absolute end-4 top-1 z-10 rounded-md border bg-background/90 px-1.5 py-0.5 text-[11px] text-muted-foreground shadow-xs"
          data-testid="histogram-stale"
        >
          From the last query that ran
        </span>
      ) : null}
      <ChartContainer
        className={cn('aspect-auto w-full transition-opacity', stale ? 'opacity-45' : loading && 'opacity-60')}
        config={outcomeChartConfig}
        style={{ height }}
      >
        <BarChart
          aria-label="Events per interval by outcome. Arrow keys move between bars."
          barCategoryGap={1}
          className={onZoom ? 'cursor-crosshair' : undefined}
          data={rows}
          margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
          onMouseDown={(state) => {
            if (!onZoom) return;
            const ts = pointTs(state as ChartPointerState);
            if (ts !== null) setDrag({ start: ts, end: ts });
          }}
          onMouseLeave={() => setDrag(null)}
          onMouseMove={(state) => {
            if (!drag) return;
            const ts = pointTs(state as ChartPointerState);
            if (ts !== null) setDrag((d) => (d ? { ...d, end: ts } : d));
          }}
          onMouseUp={finish}
        >
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis axisLine={false} dataKey="ts" interval={0} tickFormatter={axis.format} tickLine={false} tickMargin={6} ticks={axis.ticks} />
          <YAxis allowDecimals={false} axisLine={false} tickCount={3} tickFormatter={formatAxis} tickLine={false} width={40} />
          <ChartTooltip
            content={({ active, payload }) =>
              active && !drag ? (
                <OutcomeTooltip
                  hint={onZoom ? 'Drag to zoom · click to focus this bar' : undefined}
                  interval={interval}
                  row={payload?.[0]?.payload}
                />
              ) : null
            }
            cursor={{ fill: 'var(--foreground)', fillOpacity: 0.05 }}
            isAnimationActive={false}
          />
          {SERIES.map((k, i) => (
            <Bar
              dataKey={k}
              fill={`var(--color-${k})`}
              fillOpacity={k === 'success' ? 0.75 : 0.95}
              isAnimationActive={false}
              key={k}
              radius={i === SERIES.length - 1 ? [2, 2, 0, 0] : 0}
              stackId="o"
            />
          ))}
          {drag && drag.start !== drag.end ? (
            <ReferenceArea
              fill="var(--brand)"
              fillOpacity={0.12}
              stroke="var(--brand)"
              strokeOpacity={0.5}
              x1={Math.min(drag.start, drag.end)}
              x2={Math.max(drag.start, drag.end)}
            />
          ) : null}
        </BarChart>
      </ChartContainer>
    </div>
  );
}
