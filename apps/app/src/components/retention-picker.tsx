import { RETENTION_OPTIONS } from '@trailmark/contracts';
import { FilterChip } from '@trailmark/ui/components/filter-chip';
import { cn } from '@trailmark/ui/lib/utils';
import { formatRetention } from '@/lib/format';

const COMMON = [30, 90, 365] as const;

/** Retention chooser: three common windows as cards plus every supported option in a compact row. */
export function RetentionPicker({ value, onChange, current }: { value: number; onChange: (days: number) => void; current?: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Retention">
        {COMMON.map((days) => (
          // biome-ignore lint/a11y/useSemanticElements: card-style choices; role=radio + aria-checked expose them as a radio group
          <button
            aria-checked={value === days}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-lg border bg-card p-3 text-start outline-none transition-colors hover:border-foreground/25 focus-visible:ring-3 focus-visible:ring-ring/40',
              value === days && 'border-brand ring-1 ring-brand',
            )}
            key={days}
            onClick={() => onChange(days)}
            role="radio"
            type="button"
          >
            <span className="font-medium text-sm">{formatRetention(days)}</span>
            <span className="text-muted-foreground text-xs">{days === 30 ? 'Debugging' : days === 90 ? 'Recommended' : 'Compliance'}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="All retention options">
        {RETENTION_OPTIONS.map((days) => (
          <FilterChip
            active={value === days}
            aria-checked={value === days}
            className="tabular-nums"
            key={days}
            onClick={() => onChange(days)}
            role="radio"
          >
            {formatRetention(days)}
            {current === days ? <span className="text-xs opacity-70">current</span> : null}
          </FilterChip>
        ))}
      </div>
    </div>
  );
}
