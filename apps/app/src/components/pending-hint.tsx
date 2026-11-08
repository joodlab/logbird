import { cn } from '@logbird/ui/lib/utils';
import { Loader2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * 0 while `pending` is fresh, 1 after the first delay, 2 after the second. Resets to 0 as soon as `pending` ends, so a
 * fast action never flashes any text.
 */
export function usePendingStage(pending: boolean, firstMs = 1000, secondMs = 6000): 0 | 1 | 2 {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    setStage(0);
    if (!pending) return;
    const first = setTimeout(() => setStage(1), firstMs);
    const second = setTimeout(() => setStage(2), secondMs);
    return () => {
      clearTimeout(first);
      clearTimeout(second);
    };
  }, [pending, firstMs, secondMs]);
  return pending ? stage : 0;
}

/**
 * Explanatory progress text for a slow action, shown under its button after ~1 s (a spinner alone reads as "stuck"
 * after a couple of seconds). `slow` is what is happening; `slower` (after ~6 s) reassures or says what the person
 * may do meanwhile.
 */
export function PendingHint({ pending, slow, slower, className }: { pending: boolean; slow: string; slower?: string; className?: string }) {
  const stage = usePendingStage(pending);
  return (
    <p aria-live="polite" className={cn('min-h-0 text-muted-foreground text-xs', stage === 0 && 'sr-only', className)} role="status">
      {stage > 0 ? (
        <span className="tm-fade-in flex items-start gap-1.5" data-testid="pending-hint">
          <Loader2Icon aria-hidden className="mt-px size-3.5 shrink-0 animate-spin" />
          <span>
            {slow}
            {stage > 1 && slower ? ` ${slower}` : null}
          </span>
        </span>
      ) : null}
    </p>
  );
}
