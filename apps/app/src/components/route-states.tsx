import { ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { RefreshCwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiRequestError, isBusyError, isTimeoutError } from '@/lib/api/errors';
import { placeholderKeys } from '@/lib/placeholders';

/** Title and message for an error that broke a whole route. */
function describeRouteError(error: unknown): { title: string; error: unknown } {
  if (isTimeoutError(error)) return { title: 'Logbird is taking too long to respond', error };
  if (isBusyError(error)) return { title: 'This project is busy', error };
  if (error instanceof TypeError || (error instanceof ApiRequestError && error.status >= 502))
    return {
      title: 'Cannot reach the server',
      error: new Error('The Logbird server did not answer. Check that it is running on port 4601, then retry.'),
    };
  return { title: 'This page failed to load', error };
}

/** Default route error boundary: keeps the shell, explains, offers a retry. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const described = describeRouteError(error);
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <ErrorState
        error={described.error}
        onRetry={() => {
          reset();
          router.invalidate();
        }}
        title={described.title}
      />
    </div>
  );
}

/** Generic page skeleton used while a route's loader warms the cache. */
export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-6 p-6" role="status">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {placeholderKeys(5).map((k) => (
          <Skeleton className="h-24 rounded-xl" key={k} />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

/** After this long the boot screen says it is still waiting; after `LOADER_GIVE_UP_MS` it offers a reload. */
const LOADER_SLOW_MS = 6000;
const LOADER_GIVE_UP_MS = 20_000;

/**
 * Boot screen while the session and workspace load. The requests behind it have their own deadlines (they turn into
 * a route error with Retry); this is the backstop so the screen itself can never spin forever.
 */
export function FullPageLoader() {
  const [stage, setStage] = useState<'loading' | 'slow' | 'stuck'>('loading');
  useEffect(() => {
    const slow = setTimeout(() => setStage('slow'), LOADER_SLOW_MS);
    const stuck = setTimeout(() => setStage('stuck'), LOADER_GIVE_UP_MS);
    return () => {
      clearTimeout(slow);
      clearTimeout(stuck);
    };
  }, []);
  if (stage === 'stuck') {
    return (
      <div className="flex min-h-svh items-center justify-center p-6" data-testid="loader-stuck">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center" role="alert">
          <p className="font-medium text-sm">Logbird is taking too long to load</p>
          <p className="text-muted-foreground text-sm">The server is reachable but has not answered yet. Reload to try again.</p>
          <Button onClick={() => window.location.reload()} size="sm" variant="outline">
            <RefreshCwIcon />
            Reload
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div aria-busy="true" aria-label="Loading" className="flex min-h-svh items-center justify-center" role="status">
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <span className="size-2 animate-pulse rounded-full bg-brand" />
          Loading Logbird…
        </div>
        {stage === 'slow' ? <p className="tm-fade-in text-muted-foreground text-xs">Still waiting for the server…</p> : null}
      </div>
    </div>
  );
}
