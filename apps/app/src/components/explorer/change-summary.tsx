import type { AuditEvent } from '@logbird/contracts';
import { cn } from '@logbird/ui/lib/utils';
import { changeDisplayParts, changeValueText, type EventChange, middleTruncate } from '@/lib/change-values';
import { formatNumber } from '@/lib/format';
import { ChangeValue } from './change-value';

const SHOWN = 2;
const VALUE_LIMIT = 24;
const FIELD_LIMIT = 28;
const CONTROL = 'rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring';

function changePreview(change: EventChange): string {
  const parts = changeDisplayParts(change);
  const before = middleTruncate(changeValueText(change.before, change.beforeKind), VALUE_LIMIT);
  const after = middleTruncate(changeValueText(change.after, change.afterKind), VALUE_LIMIT);
  const text = parts.before && parts.after ? `${before} to ${after}` : parts.after ? `set to ${after}` : `removed (was ${before})`;
  return `${middleTruncate(change.field, FIELD_LIMIT)}: ${text}`;
}

export function changeSummaryLabel(changes: AuditEvent['changes']): string {
  if (!changes.length) return '';
  const first = changes.slice(0, SHOWN).map(changePreview);
  const rest = changes.length - SHOWN;
  if (rest > 0) first.push(moreLabel(rest));
  return first.join('; ');
}

const moreLabel = (count: number) => `${formatNumber(count)} more change${count === 1 ? '' : 's'}`;

export function ChangeSummary({
  changes,
  onOpen,
  onField,
  tabIndex,
  className,
}: {
  changes: AuditEvent['changes'];
  onOpen: () => void;
  onField?: (field: string) => void;
  tabIndex?: number;
  className?: string;
}) {
  if (!changes.length) return null;
  const rest = changes.length - SHOWN;
  return (
    <div className={cn('flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-muted-foreground text-xs', className)}>
      {changes.slice(0, SHOWN).map((change, index) => {
        const parts = changeDisplayParts(change);
        const field = middleTruncate(change.field, FIELD_LIMIT);
        return (
          <span
            className="min-w-0 [overflow-wrap:anywhere]"
            // biome-ignore lint/suspicious/noArrayIndexKey: the event's change list is positional and can repeat field names
            key={`${index}:${change.field}`}
          >
            {onField ? (
              <button
                aria-label={`Filter history by ${change.field}`}
                className={cn(CONTROL, 'text-start font-mono text-[11px] text-foreground underline decoration-muted-foreground/50')}
                dir="auto"
                onClick={(event) => {
                  event.stopPropagation();
                  onField(change.field);
                }}
                tabIndex={tabIndex}
                title={`Filter history by ${change.field}`}
                type="button"
              >
                {field}
              </button>
            ) : (
              <bdi className="font-mono text-[11px] text-foreground" title={field === change.field ? undefined : change.field}>
                {field}
              </bdi>
            )}
            {': '}
            {parts.before && !parts.after ? 'removed (was ' : null}
            {parts.before ? <ChangeValue before kind={change.beforeKind} limit={VALUE_LIMIT} tabIndex={tabIndex} text={change.before} /> : null}
            {parts.before && parts.after ? ' → ' : null}
            {!parts.before && parts.after ? 'set to ' : null}
            {parts.after ? <ChangeValue kind={change.afterKind} limit={VALUE_LIMIT} tabIndex={tabIndex} text={change.after} /> : null}
            {parts.before && !parts.after ? ')' : null}
          </span>
        );
      })}
      {rest > 0 ? (
        <button
          aria-label={`Open event to see ${moreLabel(rest)}`}
          className={cn(CONTROL, 'shrink-0 font-medium')}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          tabIndex={tabIndex}
          type="button"
        >
          +{formatNumber(rest)} more
        </button>
      ) : null}
    </div>
  );
}
