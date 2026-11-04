import { formatNumber } from '@/lib/format';
import { bucketLabel, outcomeChartConfig, SERIES, type SeriesRow } from './outcome-series';

/** Tooltip body shared by the overview area chart and the explorer histogram. */
export function OutcomeTooltip({ row, interval, hint }: { row: SeriesRow | undefined; interval: number; hint?: string }) {
  if (!row) return null;
  return (
    <div className="grid min-w-44 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium">{bucketLabel(row.ts, interval)}</span>
        <span className="font-medium tabular-nums">{formatNumber(row.total)}</span>
      </div>
      <div className="grid gap-1">
        {[...SERIES]
          .reverse()
          .filter((k) => row[k] > 0)
          .map((k) => (
            <div className="flex items-center justify-between gap-4" key={k}>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-[2px]" style={{ background: outcomeChartConfig[k].color }} />
                {outcomeChartConfig[k].label}
              </span>
              <span className="tabular-nums">{formatNumber(row[k])}</span>
            </div>
          ))}
      </div>
      {hint ? <div className="border-t pt-1.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
