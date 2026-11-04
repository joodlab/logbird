import { cn } from '@trailmark/ui/lib/utils';
import { splitAction } from '@/lib/events';

/** Mono action with a dim namespace and a strong verb: `hotel.policy.`**updated**. */
export function ActionName({ action, className }: { action: string; className?: string }) {
  const { namespace, verb } = splitAction(action);
  return (
    <span className={cn('truncate font-mono text-[12px]', className)} title={action}>
      <span className="text-muted-foreground">{namespace}</span>
      <span className="text-foreground">{verb}</span>
    </span>
  );
}
