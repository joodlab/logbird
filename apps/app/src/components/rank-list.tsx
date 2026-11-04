import { EmptyState } from '@trailmark/ui/components/states';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { cn } from '@trailmark/ui/lib/utils';
import type { ReactNode } from 'react';
import { formatCompact } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';

export interface RankItem {
  key: string;
  label: ReactNode;
  count: number;
  /** Renders the row as a link/button. */
  render?: (children: ReactNode, className: string) => ReactNode;
}

/** Ranked rows with proportional bars — "top actions / actors / tenants". */
export function RankList({
  items,
  loading,
  empty = 'Nothing in this range.',
  rows = 6,
}: {
  items: RankItem[];
  loading?: boolean;
  empty?: string;
  rows?: number;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-1 p-2">
        {placeholderKeys(rows).map((k, i) => (
          <Skeleton className="h-7 w-full" key={k} style={{ opacity: 1 - i * 0.12 }} />
        ))}
      </div>
    );
  }
  if (items.length === 0) return <EmptyState size="sm" title={empty} />;
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ul className="flex flex-col gap-px p-1.5">
      {items.map((item) => {
        const className = cn(
          'group/rank relative flex h-8 w-full min-w-0 items-center justify-between gap-3 overflow-hidden rounded-md px-2 text-start text-[13px] outline-none',
          item.render && 'hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50',
        );
        const body = (
          <>
            <span
              aria-hidden
              className="absolute inset-y-1 start-0 rounded-[5px] bg-brand/[0.07] transition-colors group-hover/rank:bg-brand/[0.12]"
              style={{ width: `${(item.count / max) * 100}%` }}
            />
            <span className="relative min-w-0 flex-1 truncate">{item.label}</span>
            <span className="relative shrink-0 text-muted-foreground text-xs tabular-nums">{formatCompact(item.count)}</span>
          </>
        );
        return <li key={item.key}>{item.render ? item.render(body, className) : <div className={className}>{body}</div>}</li>;
      })}
    </ul>
  );
}
