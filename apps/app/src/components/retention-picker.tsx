import { RETENTION_OPTIONS } from '@logbird/contracts';
import { RadioChoice, RadioGroup } from '@logbird/ui/components/ui/radio-group';
import { cn } from '@logbird/ui/lib/utils';
import { formatRetention } from '@/lib/format';

const COMMON = [
  { days: 30, hint: 'Debugging' },
  { days: 90, hint: 'Recommended' },
  { days: 365, hint: 'Compliance' },
] as const;

/**
 * Retention chooser: every supported window as ONE radio group (one Tab stop, arrow keys move the selection), with
 * three common windows repeated above as large cards. The cards are pointer shortcuts that set the same value, hidden
 * from assistive tech and out of the Tab order so the value is never announced twice.
 */
export function RetentionPicker({
  value,
  onChange,
  current,
  disabled = false,
  'aria-label': ariaLabel = 'Retention',
  'aria-labelledby': ariaLabelledBy,
}: {
  value: number;
  onChange: (days: number) => void;
  current?: number;
  /** Read-only (members): shows the current window without letting it change. */
  disabled?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div aria-hidden className="grid grid-cols-3 gap-2" data-testid="retention-shortcuts">
        {COMMON.map(({ days, hint }) => (
          <button
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-lg border bg-card p-3 text-start outline-none transition-colors hover:border-foreground/25 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border',
              value === days && 'border-brand ring-1 ring-brand disabled:hover:border-brand forced-colors:border-[Highlight]',
            )}
            data-active={value === days || undefined}
            disabled={disabled}
            key={days}
            onClick={() => onChange(days)}
            tabIndex={-1}
            type="button"
          >
            <span className="font-medium text-sm">{formatRetention(days)}</span>
            <span className="text-muted-foreground text-xs">{hint}</span>
          </button>
        ))}
      </div>
      <RadioGroup
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className="flex flex-wrap gap-1.5"
        disabled={disabled}
        onValueChange={(days) => onChange(Number(days))}
        value={value}
      >
        {RETENTION_OPTIONS.map((days) => {
          const hint = COMMON.find((c) => c.days === days)?.hint;
          return (
            <RadioChoice className="tabular-nums" key={days} value={days} variant="chip">
              {formatRetention(days)}
              {hint ? <span className="sr-only">, {hint.toLowerCase()}</span> : null}
              {current === days ? (
                <span className="text-xs opacity-70">
                  <span className="sr-only">, </span>current
                </span>
              ) : null}
            </RadioChoice>
          );
        })}
      </RadioGroup>
    </div>
  );
}
