import type { ChangeValueKind } from '@logbird/contracts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { cn } from '@logbird/ui/lib/utils';
import { CHANGE_VALUE_WRAP, changeValuePreview, changeValueText, middleTruncate, REDACTED_CHANGE_VALUE } from '@/lib/change-values';

export function ChangeValue({
  text,
  kind,
  before,
  limit,
  tabIndex,
}: {
  text: string;
  kind?: ChangeValueKind;
  before?: boolean;
  limit?: number;
  tabIndex?: number;
}) {
  const preview = limit === undefined ? changeValueText(text, kind) : changeValuePreview(text, kind);
  const shown = limit === undefined ? preview : middleTruncate(preview, limit);
  const neutral = kind === 'absent' || text === REDACTED_CHANGE_VALUE;
  const className = cn(
    CHANGE_VALUE_WRAP,
    'font-mono',
    limit === undefined ? 'whitespace-pre-wrap text-[12px]' : 'whitespace-break-spaces text-[11px]',
    neutral
      ? 'text-muted-foreground italic'
      : !kind && !text
        ? 'text-muted-foreground'
        : before
          ? 'text-diff-remove line-through decoration-diff-remove/40'
          : 'text-diff-add',
  );

  if (shown === preview) {
    return (
      <span className={className} dir="auto">
        {shown}
      </span>
    );
  }
  const value = changeValueText(text, kind);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={value}
            className={cn(className, 'rounded-sm text-start focus-visible:ring-2 focus-visible:ring-ring')}
            dir="auto"
            onClick={(event) => event.stopPropagation()}
            tabIndex={tabIndex}
            type="button"
          />
        }
      >
        {shown}
      </TooltipTrigger>
      <TooltipContent
        className={cn(CHANGE_VALUE_WRAP, 'max-h-[50svh] max-w-[min(32rem,85vw)] overflow-auto whitespace-pre-wrap font-mono')}
        dir="auto"
        role="tooltip"
      >
        {value}
      </TooltipContent>
    </Tooltip>
  );
}
