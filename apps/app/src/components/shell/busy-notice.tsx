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
  // Floats over the top of the page instead of pushing it down: it comes and goes on its own, mid-read.
  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center px-4">
      <div
        aria-live="polite"
        className="tm-fade-in pointer-events-auto flex items-center gap-2 rounded-full border border-outcome-denied/25 bg-popover px-3 py-1 text-[13px] shadow-md"
        data-testid="busy-notice"
        role="status"
      >
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-outcome-denied" />
        <span>
          <span className="font-medium">Project is busy</span>
          <span className="text-muted-foreground"> — a retention purge is running. Retrying automatically…</span>
        </span>
      </div>
    </div>
  );
}
