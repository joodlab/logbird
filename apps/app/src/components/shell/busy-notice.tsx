import { useIsFetching } from '@tanstack/react-query';
import { Loader2Icon } from 'lucide-react';
import { isBusyError } from '@/lib/api/errors';

/**
 * Slim notice while any request is waiting out a busy project (503 project_busy / retention_unavailable). The queries
 * retry on their own, honouring Retry-After (see `shouldRetry` / `retryDelay`); this explains the wait.
 */
export function BusyNotice() {
  const waiting = useIsFetching({ predicate: (query) => isBusyError(query.state.fetchFailureReason) });
  if (!waiting) return null;
  return (
    <div
      aria-live="polite"
      className="tm-fade-in flex items-center gap-2 border-outcome-denied/25 border-b bg-outcome-denied/[0.07] px-4 py-1.5 text-[13px]"
      data-testid="busy-notice"
      role="status"
    >
      <Loader2Icon className="size-3.5 shrink-0 animate-spin text-outcome-denied" />
      <span>
        <span className="font-medium">Project is busy</span>
        <span className="text-muted-foreground"> — a retention purge is running. Retrying automatically…</span>
      </span>
    </div>
  );
}
