import { cn } from '@logbird/ui/lib/utils';
import { labelChips, type ViewLabel } from '@/lib/views';

/** "Tenant: Bayt Al Rimal" chips for a saved view's entity terms; renders nothing when no term has a known name. */
export function ViewLabelChips({
  q,
  labels,
  lang = 'query',
  className,
}: {
  q: string | undefined;
  labels: readonly ViewLabel[] | undefined;
  lang?: 'query' | 'sql';
  className?: string;
}) {
  const chips = labelChips(q, labels, lang);
  if (!chips.length) return null;
  return (
    <ul aria-label="Filters" className={cn('flex flex-wrap gap-1.5', className)} data-testid="view-label-chips">
      {chips.map((chip) => (
        <li
          className="inline-flex max-w-full items-center rounded-md border bg-brand/[0.06] px-2 py-0.5 font-medium font-sans text-[12px] text-foreground"
          key={`${chip.field}:${chip.value}`}
          title={`${chip.field}:${chip.value}`}
        >
          <span className="truncate" dir="auto">
            {chip.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
